import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import twilio from "twilio";

const SANDBOXD_URL = process.env.SANDBOXD_URL || "http://127.0.0.1:9090";
const SANDBOXD_API_KEY = process.env.SANDBOXD_API_KEY || "";
const AGENT = process.env.WAH_AGENT || "opencode";
const MODEL = process.env.WAH_MODEL || undefined;
const PROVIDER = process.env.WAH_PROVIDER || undefined;
const PRESET = process.env.WAH_PRESET || "react-vite";
const MAX_TASKS = Number.parseInt(process.env.WAH_MAX_TASKS || "40", 10);
const TASK_TIMEOUT_S = Number.parseInt(process.env.WAH_TASK_TIMEOUT_S || "900", 10);
const STATE_FILE = process.env.WAH_STATE_FILE || path.resolve("data/users.json");

const state = loadState();
let tacRef = null;
let twilioClient = null;

export function attachTAC(tac) {
  tacRef = tac;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { users: {} };
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function userKey(context) {
  const phone = String(context.session?.authorInfo?.address || context.author || "").replace(/^(sms|voice|whatsapp|rcs):/i, "");
  const key = context.profileId || phone.replace(/[^0-9+]/g, "") || "anon";
  if (!state.users[key]) {
    state.users[key] = { phone, appId: null, sandboxId: null, tasks: 0, running: null, createdAt: new Date().toISOString() };
    saveState();
  }
  if (phone && !state.users[key].phone) state.users[key].phone = phone;
  return key;
}

async function sb(method, route, body) {
  const res = await fetch(`${SANDBOXD_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${SANDBOXD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`sandboxd ${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

function publicUrl(url) {
  if (!url) return url;
  return url.replace(/^http:\/\//, "https://").replace(/:\d+(\/|$)/, "$1");
}

async function ensureApp(key) {
  const user = state.users[key];
  if (user.appId && user.sandboxId) return user;

  const list = await sb("GET", `/v1/apps?external_user_id=${encodeURIComponent(key)}`);
  let app = (list.apps || []).find((a) => a.current_sandbox_id) || (list.apps || [])[0];
  if (!app) {
    const last4 = (user.phone || key).slice(-4);
    app = await sb("POST", "/v1/apps", {
      name: `wah-${last4}-${Date.now().toString(36)}`,
      external_user_id: key,
      runtime_preset: PRESET,
      tags: ["walk-and-hack"],
    });
  }
  user.appId = app.id;
  user.sandboxId = app.current_sandbox_id || null;

  if (!user.sandboxId) {
    const created = await sb("POST", `/v1/apps/${app.id}/sandbox`, {});
    user.sandboxId = created.id || created.sandbox_id || created.current_sandbox_id || null;
  }
  if (!user.sandboxId) throw new Error("could not create a sandbox for app " + app.id);
  saveState();
  return user;
}

async function waitSandboxRunning(sandboxId) {
  for (let i = 0; i < 80; i += 1) {
    const s = await sb("GET", `/v1/sandboxes/${sandboxId}`);
    if (s.status === "running") return s;
    if (s.status === "error") throw new Error("sandbox is in error state");
    await sleep(3000);
  }
  throw new Error("sandbox did not reach running state");
}

async function previewUrl(sandboxId) {
  const s = await sb("GET", `/v1/sandboxes/${sandboxId}`);
  return { url: publicUrl(s.preview?.url), status: s.preview?.status };
}

async function runBuild(key, prompt, conversationId, channel) {
  const user = state.users[key];
  try {
    await ensureApp(key);
    await waitSandboxRunning(user.sandboxId);
    const task = await sb("POST", `/v1/sandboxes/${user.sandboxId}/tasks`, {
      prompt,
      agent: AGENT,
      ...(MODEL ? { model: MODEL } : {}),
      ...(PROVIDER ? { provider: PROVIDER } : {}),
      continue: true,
      timeout_s: TASK_TIMEOUT_S,
    });
    user.running = { taskId: task.id, startedAt: new Date().toISOString(), prompt };
    user.tasks += 1;
    saveState();
    console.log(`[wah] ${key} task ${task.id} started`);

    let result;
    const deadline = Date.now() + (TASK_TIMEOUT_S + 120) * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      result = await sb("GET", `/v1/sandboxes/${user.sandboxId}/tasks/${task.id}`);
      if (result.status && result.status !== "running") break;
    }
    user.running = null;
    saveState();

    const { url } = await previewUrl(user.sandboxId);
    let text;
    if (result?.status === "succeeded") {
      const changed = (result.files_changed || []).filter((f) => !f.startsWith("node_modules/")).length;
      const note = result.agent_message ? `\n\n${String(result.agent_message).slice(0, 280)}` : changed ? `\n\n${changed} file${changed === 1 ? "" : "s"} changed.` : "";
      const buildNote = result.build_status === "failed" ? "\n\n(Heads up: the build step reported an error, so the page may not have updated. Text me what you see.)" : "";
      text = `Done! Open it here: ${url}${note}${buildNote}\n\nText me what to change next.`;
    } else if (result?.status === "running" || !result) {
      text = `Still building after ${Math.round(TASK_TIMEOUT_S / 60)} minutes. Check ${url} in a bit, or text me a smaller change.`;
    } else {
      const why = result.error_message || result.failure_reason || result.status;
      text = `That one hit a snag (${String(why).slice(0, 200)}). Text me again with what you want and I'll retry.`;
    }
    await sendText(user, conversationId, text);
    console.log(`[wah] ${key} task ${task.id} ${result?.status}`);
  } catch (error) {
    user.running = null;
    saveState();
    console.error(`[wah] ${key} build failed:`, error.message);
    await sendText(user, conversationId, `Something broke on my side (${error.message.slice(0, 160)}). Try again in a minute, or find Jon on the walk.`);
  }
}

async function sendText(user, conversationId, text) {
  const channel = tacRef?.getChannel?.("sms");
  if (channel && conversationId && channel.isConversationActive?.(conversationId)) {
    try {
      await channel.sendResponse(conversationId, text);
      return;
    } catch (error) {
      console.warn("[wah] TAC sendResponse failed, falling back to REST:", error.message);
    }
  }
  if (!user.phone) {
    console.error("[wah] no phone for user; cannot send:", text);
    return;
  }
  if (!twilioClient) {
    twilioClient = twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { accountSid: process.env.TWILIO_ACCOUNT_SID });
  }
  await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: user.phone, body: text });
}

const HELP = [
  "Walk & Hack: text me what to build and I build a real web app for you.",
  "Try: \"Make a page that shows the weather in Central Park\"",
  "LINK = your app's link. STATUS = what I'm doing. NEW = start a fresh app. HELP = this.",
  "Call this number to talk instead of type.",
].join("\n");

export async function handleAgentMessage(userMessage, context = {}) {
  const key = userKey(context);
  const user = state.users[key];
  const text = String(userMessage || "").trim();
  const cmd = text.toLowerCase().replace(/[^a-z]/g, "");
  const voice = context.channel === "voice";

  if (!text) return voice ? "I didn't catch that. Tell me what you'd like to build." : HELP;

  if (cmd === "help" || cmd === "menu") return voice ? "Tell me what to build and I'll text you a link when it's ready. You can also say link, status, or new." : HELP;

  if (cmd === "link" || cmd === "url") {
    if (!user.sandboxId) return "You haven't built anything yet. Text me what you want to build.";
    const { url, status } = await previewUrl(user.sandboxId);
    return voice ? `I just texted you the link. It's ${status === "up" ? "up" : "still starting"}.` : `${url}\n(status: ${status})`;
  }

  if (cmd === "status") {
    if (user.running) return `Working on: "${user.running.prompt.slice(0, 120)}" since ${new Date(user.running.startedAt).toLocaleTimeString("en-US", { timeZone: "America/New_York" })}. I'll text you when it's done.`;
    return user.sandboxId ? "Idle. Text me the next change." : "Nothing yet. Text me what to build.";
  }

  if (cmd === "new" || cmd === "newapp" || cmd === "startover") {
    if (user.running) return "Let me finish the current build first. I'll text you.";
    user.appId = null;
    user.sandboxId = null;
    saveState();
    return "Fresh start. Text me what the new app should be.";
  }

  if (user.running) {
    return voice
      ? "I'm still working on your last request. I'll text you when it's done."
      : "Still working on your last request. I'll text you the link when it's done. Text STATUS to check.";
  }

  if (user.tasks >= MAX_TASKS) {
    return `You've used your build budget for today (${MAX_TASKS} builds). Find Jon on the walk to top up.`;
  }

  const firstTime = !user.sandboxId && user.tasks === 0;
  runBuild(key, text, context.conversationId, context.channel);

  if (voice) return firstTime ? "Love it. Setting up your workshop and building that now. I'll text you a link in a few minutes." : "On it. I'll text you when it's done.";
  return firstTime
    ? "Welcome to Walk & Hack! Setting up your workshop and building that now. First build takes a few minutes; I'll text you a link. Reply STOP to opt out, HELP for commands."
    : "On it. Building now, I'll text you a link in a few minutes.";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
