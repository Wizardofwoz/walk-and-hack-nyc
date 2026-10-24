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
const TALKER_MODEL = process.env.WAH_TALKER_MODEL || "anthropic/claude-haiku-5.5";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const PUBLIC_HOST = process.env.WAH_PUBLIC_HOST || process.env.TWILIO_VOICE_PUBLIC_DOMAIN || "walk.dweller.sh";
const WALL_URL = `https://${PUBLIC_HOST}/wall`;
const PROMPT_TURNS = 30;
const SECRETS_FILE = process.env.WAH_SECRETS_FILE || path.join(path.dirname(STATE_FILE), "secrets.json");

const state = loadState();
const locks = new Map();
let tacRef = null;
let twilioClient = null;

export function attachTAC(tac) {
  tacRef = tac;
}

export const MASTHEAD = [
  "WALK & HACK — AI Tinkerers NYC x Twilio",
  "You're texting a coding agent. Tell it what to build (text or call this number) and it builds a real web app and texts you the link. Then just say what to change.",
  "Under the hood: Twilio Agent Connect handles the phone + memory, each caller gets a private sandbox, and Claude does the building. Builds are on us today.",
  `Everything built shows up at ${WALL_URL}. Tell me your name to put yours in the 12:30 demo lineup.`,
  'Try: "make a page that counts pigeons". Reply STOP to opt out.',
].join("\n\n");

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const u of Object.values(s.users || {})) {
      u.turns ||= [];
      if (!u.running?.taskId) u.running = null;
    }
    return s;
  } catch {
    return { users: {} };
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function now() {
  return new Date().toISOString();
}

function userKey(context) {
  const phone = String(context.session?.authorInfo?.address || context.author || "").replace(/^(sms|voice|whatsapp|rcs):/i, "");
  const key = context.profileId || phone.replace(/[^0-9+]/g, "") || "anon";
  if (!state.users[key]) {
    state.users[key] = {
      phone, appId: null, sandboxId: null, link: null, title: null, name: null,
      tasks: 0, running: null, pending: null, turns: [], optedOut: false, createdAt: now(),
    };
    saveState();
  }
  const user = state.users[key];
  if (phone && !user.phone) user.phone = phone;
  return key;
}

function addTurn(user, turn) {
  user.turns.push({ t: now(), ...turn });
  user.updatedAt = now();
  saveState();
}

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

const inFlightAtBoot = Object.entries(state.users).filter(([, u]) => u.running?.taskId).map(([key, u]) => [key, u.running.taskId]);
setTimeout(() => {
  for (const [key, taskId] of inFlightAtBoot) {
    const u = state.users[key];
    if (u.running?.taskId === taskId) runBuild(key, u.running.instructions, taskId).catch((e) => console.error("[wah] resume crashed", e));
  }
}, 3000);

// ---------- caller API keys (texted in, kept out of the transcript) ----------

const KEY_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "ANTHROPIC_API_KEY"],
  [/\bsk-or-[A-Za-z0-9_-]{20,}/g, "OPENROUTER_API_KEY"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "OPENAI_API_KEY"],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, "GEMINI_API_KEY"],
  [/\bgsk_[A-Za-z0-9]{20,}/g, "GROQ_API_KEY"],
  [/\bxai-[A-Za-z0-9]{20,}/g, "XAI_API_KEY"],
  [/\bhf_[A-Za-z0-9]{20,}/g, "HF_TOKEN"],
  [/\br8_[A-Za-z0-9]{20,}/g, "REPLICATE_API_TOKEN"],
  [/\bAC[0-9a-f]{32}\b/g, "TWILIO_ACCOUNT_SID"],
  [/\bSK[0-9a-f]{32}\b/g, "TWILIO_API_KEY"],
];
const TWILIO_TOKEN = /\b[0-9A-Za-z]{32}\b/g;
const NAMED_KEY = /\b([A-Z][A-Z0-9_]{1,60}_(?:KEY|TOKEN|SECRET))\s*[=:]\s*["']?([^\s"']{8,})["']?/g;
const KEY_LABELS = {
  ANTHROPIC_API_KEY: "Anthropic", OPENROUTER_API_KEY: "OpenRouter", OPENAI_API_KEY: "OpenAI", GEMINI_API_KEY: "Gemini",
  GROQ_API_KEY: "Groq", XAI_API_KEY: "xAI", HF_TOKEN: "Hugging Face", REPLICATE_API_TOKEN: "Replicate",
  TWILIO_ACCOUNT_SID: "Twilio account", TWILIO_API_KEY: "Twilio API key", TWILIO_AUTH_TOKEN: "Twilio auth token", TWILIO_API_SECRET: "Twilio API secret",
};

const secrets = (() => { try { return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")); } catch { return {}; } })();

function saveSecrets() {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

export function extractKeys(text) {
  const found = {};
  let redacted = String(text).replace(NAMED_KEY, (_, name, value) => { found[name] = value; return `[${name} saved]`; });
  for (const [re, name] of KEY_PATTERNS) {
    redacted = redacted.replace(re, (value) => { found[name] = value; return `[${name} saved]`; });
  }
  if (found.TWILIO_ACCOUNT_SID || found.TWILIO_API_KEY || /twilio|auth\s*token|secret/i.test(text)) {
    const name = found.TWILIO_API_KEY && !found.TWILIO_ACCOUNT_SID ? "TWILIO_API_SECRET" : found.TWILIO_API_KEY && /secret/i.test(text) ? "TWILIO_API_SECRET" : "TWILIO_AUTH_TOKEN";
    redacted = redacted.replace(TWILIO_TOKEN, (value) => { found[name] = value; return `[${name} saved]`; });
  }
  return { found, redacted };
}

function keyNames(key) {
  return Object.keys(secrets[key] || {});
}

function secretsNote(key) {
  const names = keyNames(key);
  if (!names.length) return "";
  return [
    `SERVER SECRETS: the file .env.local in the project root holds the caller's own API keys as env vars: ${names.join(", ")}.`,
    "Use them only in server-side code (e.g. a Vite server middleware plugin in vite.config.ts). Load them there with loadEnv(mode, process.cwd(), '') from 'vite' and copy them into process.env before creating handlers, so server code can read process.env.<NAME>.",
    ...(names.some((n) => n.startsWith("TWILIO_")) ? ["Twilio credentials are the caller's own account: use the twilio npm package server-side; to send texts or place calls, use a phone number from their account (list it with client.incomingPhoneNumbers.list()) as the from number."] : []),
    "Never import them into browser code, never prefix them with VITE_, never print, log, echo or cat .env.local, never copy the values into any other file, and keep .env.local in .gitignore. Visitors must never see a key.",
  ].join(" ");
}

async function writeSecretsFile(key) {
  const user = await ensureApp(key);
  await waitSandboxRunning(user.sandboxId);
  const env = Object.entries(secrets[key] || {}).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  await putFile(user.sandboxId, ".env.local", env);
  let ignore = "";
  try { ignore = await getFile(user.sandboxId, ".gitignore"); } catch { /* none yet */ }
  if (!/^\.env\.local$|^\.env\*|^\*\.local$/m.test(ignore)) {
    await putFile(user.sandboxId, ".gitignore", `${ignore.replace(/\n?$/, "\n")}.env.local\n`.replace(/^\n/, ""));
  }
}

// ---------- sandboxd ----------

async function putFile(sandboxId, filePath, content) {
  const res = await fetch(`${SANDBOXD_URL}/v1/sandboxes/${sandboxId}/files?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${SANDBOXD_API_KEY}`, "Content-Type": "application/octet-stream" },
    body: content,
  });
  if (!res.ok) throw new Error(`sandboxd PUT file ${filePath} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function getFile(sandboxId, filePath) {
  const res = await fetch(`${SANDBOXD_URL}/v1/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`, {
    headers: { Authorization: `Bearer ${SANDBOXD_API_KEY}` },
  });
  if (!res.ok) throw new Error(`sandboxd GET file ${filePath} -> ${res.status}`);
  return res.text();
}

async function sb(method, route, body) {
  const res = await fetch(`${SANDBOXD_URL}${route}`, {
    method,
    headers: { Authorization: `Bearer ${SANDBOXD_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`sandboxd ${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
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
    try {
      const created = await sb("POST", `/v1/apps/${app.id}/sandbox`, {});
      user.sandboxId = created.id || created.sandbox_id || created.current_sandbox_id || null;
    } catch (error) {
      if (!/409/.test(error.message)) throw error;
      const fresh = await sb("GET", `/v1/apps/${app.id}`);
      user.sandboxId = fresh.current_sandbox_id || null;
    }
  }
  if (!user.sandboxId) throw new Error("could not create a sandbox for app " + app.id);
  saveState();
  return user;
}

async function waitSandboxRunning(sandboxId) {
  let woke = false;
  for (let i = 0; i < 80; i += 1) {
    const s = await sb("GET", `/v1/sandboxes/${sandboxId}`);
    if (s.status === "running") return s;
    if (s.status === "error") throw new Error("sandbox is in error state");
    if (s.status === "stopped" && !woke) {
      woke = true;
      console.log(`[wah] sandbox ${sandboxId} is stopped (idle reaper); waking`);
      try {
        const started = await sb("POST", `/v1/sandboxes/${sandboxId}/start`);
        if (started?.status === "running") return started;
      } catch (e) {
        console.log(`[wah] wake failed for ${sandboxId}: ${e.message}`);
      }
    }
    await sleep(3000);
  }
  throw new Error("sandbox did not reach running state");
}

async function previewUrl(sandboxId) {
  const s = await sb("GET", `/v1/sandboxes/${sandboxId}`);
  return { url: publicUrl(s.preview?.url), status: s.preview?.status };
}

// ---------- builds ----------

function startBuild(key, instructions, title, channel, conversationId) {
  const user = state.users[key];
  if (user.running) {
    user.pending = { instructions: user.pending ? `${user.pending.instructions}\n\nAlso: ${instructions}` : instructions, channel, conversationId };
    if (title && !user.title) user.title = title;
    saveState();
    return { status: "queued", note: "A build is already running. This will be folded into the next build automatically when it finishes." };
  }
  if (user.tasks >= MAX_TASKS) return { status: "budget", note: `Build budget for today is used up (${MAX_TASKS} builds). Find Jon on the walk.` };
  if (title) user.title = title;
  user.running = { taskId: null, startedAt: now(), instructions, channel, conversationId };
  saveState();
  runBuild(key, instructions).catch((e) => console.error("[wah] runBuild crashed", e));
  return { status: "started", note: user.sandboxId ? "Build started. Takes about a minute." : "Workshop is being set up and the first build started. Takes a few minutes." };
}

async function runBuild(key, instructions, resumeTaskId) {
  const user = state.users[key];
  const { channel, conversationId } = user.running;
  let event;
  try {
    let task;
    if (resumeTaskId) {
      task = { id: resumeTaskId };
      console.log(`[wah] ${key} resuming task ${task.id} after restart`);
    } else {
    await ensureApp(key);
    await waitSandboxRunning(user.sandboxId);
    task = await createTask(key, instructions, !user.freshSession);
    if (user.freshSession) { user.freshSession = false; }
    user.running.taskId = task.id;
    user.tasks += 1;
    saveState();
    console.log(`[wah] ${key} task ${task.id} started`);
    }

    let result = await pollTask(user, task.id);
    if (result?.status === "failed" && /Provider rejected/i.test(String(result.error_message || ""))) {
      console.log(`[wah] ${key} provider rejected task ${task.id}; retrying in a fresh agent session`);
      task = await createTask(key, `${instructions}\n\n(Fresh session: the project already exists. Read the current code first, then make the change.)`, false);
      user.running.taskId = task.id;
      saveState();
      console.log(`[wah] ${key} task ${task.id} started (fresh)`);
      result = await pollTask(user, task.id);
    }
    const { url } = await previewUrl(user.sandboxId);
    user.link = url;
    if (result?.status === "succeeded") {
      const summary = String(result.agent_message || "").trim().slice(0, 400);
      const broken = result.build_status === "failed";
      event = { ok: true, link: url, summary, broken };
    } else if (result?.status === "running" || !result) {
      event = { ok: false, link: url, summary: `Still building after ${Math.round(TASK_TIMEOUT_S / 60)} minutes; it may land on its own.` };
    } else {
      event = { ok: false, link: url, summary: `Build failed: ${String(result.error_message || result.failure_reason || result.status).slice(0, 200)}` };
    }
    console.log(`[wah] ${key} task ${task.id} ${result?.status}`);
  } catch (error) {
    console.error(`[wah] ${key} build failed:`, error.message);
    event = { ok: false, link: user.link, summary: `Something broke on our side: ${error.message.slice(0, 160)}` };
  }

  await withLock(key, async () => {
    user.running = null;
    noteTask(Boolean(event.ok));
    addTurn(user, { role: "event", text: buildEventText(event) });
    const pending = user.pending;
    user.pending = null;
    saveState();

    const sms = event.ok
      ? `Done: ${event.link}${event.summary ? `\n\n${event.summary}` : ""}${event.broken ? "\n\n(The build step reported an error, so the page may not have updated. Text me what you see.)" : ""}${pending ? "\n\nStarting on the next thing you asked for now." : "\n\nText or call me with what to change."}`
      : `${event.summary}${event.link ? `\nYour app: ${event.link}` : ""}\n\nText me again with what you want and I'll retry.`;
    await notifyDone(user, channel, conversationId, sms, event, Boolean(pending));

    if (pending) {
      addTurn(user, { role: "event", text: "Queued changes are now being built." });
      startBuild(key, pending.instructions, null, pending.channel || channel, pending.conversationId || conversationId);
    }
  });
}

async function createTask(key, instructions, cont) {
  const user = state.users[key];
  const note = secretsNote(key);
  return sb("POST", `/v1/sandboxes/${user.sandboxId}/tasks`, {
    prompt: note ? `${instructions}\n\n${note}` : instructions,
    agent: AGENT,
    ...(MODEL ? { model: MODEL } : {}),
    ...(PROVIDER ? { provider: PROVIDER } : {}),
    continue: cont,
    timeout_s: TASK_TIMEOUT_S,
  });
}

async function pollTask(user, taskId) {
  let result;
  const deadline = Date.now() + (TASK_TIMEOUT_S + 120) * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    result = await sb("GET", `/v1/sandboxes/${user.sandboxId}/tasks/${taskId}`);
    if (result.status && result.status !== "running") break;
  }
  return result;
}

function buildEventText(e) {
  if (e.ok) return `Build finished. Link: ${e.link}. Agent summary: ${e.summary || "(none)"}${e.broken ? " WARNING: the dev build reported an error; the page may not reflect the change." : ""}`;
  return `Build did not succeed. ${e.summary}${e.link ? ` Link: ${e.link}` : ""}`;
}

async function notifyDone(user, channel, conversationId, sms, event, hasPending) {
  try { await sendText(user, channel === "sms" ? conversationId : null, sms); } catch (e) { console.error("[wah] done text failed:", e.message); }
  if (channel !== "voice") return;
  const voice = tacRef?.getChannel?.("voice");
  const spoken = event.ok
    ? `Your build just finished${user.title ? `: ${user.title}` : ""}. The link is in your texts.${hasPending ? " I'm starting on the next change now." : " Want to change anything?"}`
    : `Heads up, that build didn't land. ${event.summary.slice(0, 120)}. Tell me again what you want and I'll retry.`;
  if (voice && conversationId && voice.isConversationActive?.(conversationId)) {
    try { await voice.sendResponse(conversationId, spoken); return; } catch (e) { console.warn("[wah] voice sendResponse failed:", e.message); }
  }
  if (!voice || !user.phone || hasPending) return;
  try {
    await voice.initiateOutboundConversation({
      to: user.phone,
      conversationRelayConfig: { url: `wss://${PUBLIC_HOST}/ws`, welcomeGreeting: `Hey, it's Walk and Hack. ${spoken}`, welcomeGreetingInterruptible: "any" },
    });
    addTurn(user, { role: "event", text: "Called the caller back to say the build finished." });
  } catch (e) {
    console.warn("[wah] callback call failed:", e.message);
  }
}

async function sendText(user, conversationId, text) {
  const channel = tacRef?.getChannel?.("sms");
  if (channel && conversationId && channel.isConversationActive?.(conversationId)) {
    try { await channel.sendResponse(conversationId, text); return; } catch (error) {
      console.warn("[wah] TAC sendResponse failed, falling back to REST:", error.message);
    }
  }
  if (!user.phone) { console.error("[wah] no phone for user; cannot send:", text); return; }
  if (!twilioClient) {
    twilioClient = twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { accountSid: process.env.TWILIO_ACCOUNT_SID });
  }
  await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: user.phone, body: text });
}

// ---------- outbound calls on request ----------

const MAX_CALLS = Number.parseInt(process.env.WAH_MAX_CALLS || "5", 10);

function normalizePhone(s) {
  const d = String(s).replace(/[^0-9+]/g, "");
  if (/^\+\d{10,15}$/.test(d)) return d;
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  return null;
}

async function placeCall(key, to, message) {
  const user = state.users[key];
  if (!message.trim()) return { status: "error", note: "No message to say." };
  if ((user.calls || 0) >= MAX_CALLS) return { status: "limit", note: `Call limit reached (${MAX_CALLS} per person today).` };
  const everyone = Object.entries(state.users).filter(([, u]) => u.phone && !u.optedOut);
  let target;
  if (/^(me|myself)$/i.test(to.trim())) target = [key, user];
  else {
    const phone = normalizePhone(to);
    if (phone) target = everyone.find(([, u]) => normalizePhone(u.phone) === phone);
    else {
      const name = to.trim().toLowerCase();
      const hits = everyone.filter(([, u]) => u.name && u.name.toLowerCase() === name);
      const loose = hits.length ? hits : everyone.filter(([, u]) => u.name && u.name.toLowerCase().split(/\s+/)[0] === name.split(/\s+/)[0]);
      if (loose.length > 1) return { status: "ambiguous", note: `More than one attendee is named ${to}; ask for their number.` };
      target = loose[0];
    }
  }
  if (!target) return { status: "not_allowed", note: "I can only call people who have already texted or called this line today (that keeps it from being used for prank calls). Ask them to text this number first, then try again." };
  const [targetKey, targetUser] = target;
  if (targetUser.optedOut || !targetUser.phone) return { status: "not_allowed", note: "That person has opted out." };
  const from = targetKey === key ? "" : `${user.name || "Another walker"} asked me to call you. `;
  const greeting = `Hi, this is the Walk and Hack line. ${from}${message.trim()}`.slice(0, 600);
  const voice = tacRef?.getChannel?.("voice");
  try {
    if (voice?.initiateOutboundConversation) {
      await voice.initiateOutboundConversation({
        to: targetUser.phone,
        conversationRelayConfig: { url: `wss://${PUBLIC_HOST}/ws`, welcomeGreeting: greeting, welcomeGreetingInterruptible: "any" },
      });
    } else {
      if (!twilioClient) twilioClient = twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { accountSid: process.env.TWILIO_ACCOUNT_SID });
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say(greeting);
      await twilioClient.calls.create({ from: process.env.TWILIO_PHONE_NUMBER, to: targetUser.phone, twiml: twiml.toString() });
    }
  } catch (e) {
    console.error(`[wah] ${key} outbound call failed:`, e.message);
    return { status: "error", note: "The call didn't go through. Try again in a minute." };
  }
  user.calls = (user.calls || 0) + 1;
  if (targetKey !== key) addTurn(targetUser, { role: "event", text: `Called this person at ${user.name || "another attendee"}'s request and said: ${message.trim()}` });
  saveState();
  console.log(`[wah] ${key} placed call to ${targetKey}`);
  return { status: "calling", note: `Calling ${targetKey === key ? "the caller" : targetUser.name || "them"} now.` };
}

// ---------- the talker ----------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "build",
      description: "Hand instructions to the caller's coding agent to create or change their web app. Call this whenever the caller has described something to make or change. When in doubt, call it.",
      parameters: {
        type: "object",
        properties: {
          instructions: { type: "string", description: "A complete, specific spec for a coding agent, written from the whole conversation: what to build or change, look, behavior. Fold in anything the caller asked for that has not been built yet. Do not repeat things already built unless they are changing." },
          title: { type: "string", description: "A short title for the caller's project, 2-5 words, e.g. 'Pigeon Counter'. Keep the existing title unless the project changed." },
        },
        required: ["instructions", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "call",
      description: "Place a phone call from the Walk & Hack number to someone and speak a message, when the caller asks you to call someone (or themselves). Only works for people who have already texted or called this line today. After the message the person can talk to you like any caller.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Phone number, or the name of another attendee as it appears on the wall, or 'me' for the caller." },
          message: { type: "string", description: "What to say when they pick up, written to be spoken aloud, one to three sentences. No URLs; say the link is in their texts if relevant." },
        },
        required: ["to", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_name",
      description: "Record the caller's name for the live wall, only when they tell you their name or ask to be credited.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
];

function systemPrompt(key, user, channel, memory) {
  const voice = channel === "voice";
  const lines = [
    "You are the Walk & Hack build line: AI Tinkerers NYC x Twilio, a Saturday walk through Central Park where people build web apps by text or by phone call. The caller is an attendee. You talk, and you have tools: build (the main one), call, and set_name.",
    "",
    voice
      ? "CHANNEL: VOICE. The caller is on a phone call outdoors. Reply in one or two short spoken sentences. No lists, no URLs, no markdown. If they need the link, say it's in their texts (it is texted automatically after every build)."
      : "CHANNEL: SMS. Keep replies short, plain text, no markdown. You may include the app link if it is in the transcript.",
    "",
    "HOW TO BEHAVE",
    "- When the caller describes something to make or change, call build. Write the instructions as a full spec for a coding agent, drawing on the whole conversation. If unsure whether they want a build or a chat, build; a wasted minute is cheaper than ignoring them.",
    "- Read it back: in the same reply as a build, say in one line what you're building, e.g. 'Orange pigeon counter with a big button, building now.' That is how park-noise mistakes get caught.",
    "- If build returns 'queued', tell them you'll fold it in right after the current build. If it returns 'budget', say so and point them to Jon.",
    "- Never say a link exists or that something is done unless a build-finished event in the transcript says so. Never invent a URL.",
    "- A build takes about a minute, the first one a few minutes. The link is always texted when it lands. If they are on a call when it finishes, you'll hear about it in the transcript; if they hung up, they get a call back.",
    "- Greet returning callers like you remember them (you do: the transcript and Twilio memory are below). Don't re-explain the product to someone who has already built something.",
    "- Small talk is fine; keep it brief and steer back to building.",
    "- If they ask what this is or how it works: Twilio Agent Connect handles the phone and memory, each caller gets a private sandbox, Claude does the building, Jon from AI Tinkerers built the bridge. Honest and short.",
    "- If they give their name, call set_name. Builds appear on the live wall (" + WALL_URL + ") with the project title. Giving a name is how they submit for the demo circle at 12:30: named apps go to the top of the wall as the lineup, unnamed ones show lower with the title only. If they ask how to submit or enter, tell them: just tell me your name. Never mention phone numbers.",
    "- API keys: if the caller wants their app to call an AI model or another paid API with their own key, tell them to just text the key here. It is pulled out of the chat before you ever see it, stored on their app's server only (never in the page, never visible to visitors), and the builder is told to use it server-side. Suggest a fresh key with a spending limit that they revoke after today. You will see '[NAME saved]' where a key was; never ask them to repeat it. Do not send them to Jon for keys.",
    "- Calls: if the caller asks you to call someone (a friend on the walk, or themselves), use the call tool with a short spoken message. It only reaches people who have texted or called this line today; if it says not_allowed, explain that and suggest they get their friend to text the number first. If someone wants their own app to text or call people, tell them to text their Twilio account SID and auth token here; they get stored on their app's server like any key.",
    "- Say 'reply STOP to opt out' only if asked how to stop.",
    "",
    `CALLER STATE: ${user.title ? `project "${user.title}"` : "no project yet"}; ${user.link ? `current link ${user.link}` : "no link yet"}; ${user.running ? "a build is running right now" : "no build running"}; ${user.pending ? "changes are queued for the next build" : ""}; ${user.name ? `name ${user.name}` : "name not given"}; builds so far ${user.tasks}; ${keyNames(key).length ? `caller's keys stored on their server: ${keyNames(key).join(", ")}` : "no caller API keys stored"}.`,
  ];
  const mem = memoryText(memory);
  if (mem) lines.push("", "TWILIO MEMORY (from past conversations):", mem);
  return lines.join("\n");
}

function memoryText(memory) {
  if (!memory) return "";
  const out = [];
  try {
    for (const s of memory.summaries || []) out.push(`summary: ${s.summary || s.text || JSON.stringify(s)}`.slice(0, 400));
    for (const o of memory.observations || []) out.push(`note: ${o.observation || o.text || JSON.stringify(o)}`.slice(0, 200));
  } catch { /* ignore */ }
  return out.slice(0, 12).join("\n");
}

function toMessages(key, user, channel, memory) {
  const msgs = [{ role: "system", content: systemPrompt(key, user, channel, memory) }];
  const turns = user.turns.slice(-PROMPT_TURNS);
  for (const t of turns) {
    if (t.role === "user") msgs.push({ role: "user", content: `[${t.ch || "sms"}] ${t.text}` });
    else if (t.role === "assistant") msgs.push({ role: "assistant", content: t.text || "" });
    else if (t.role === "event") msgs.push({ role: "user", content: `[event, not from the caller] ${t.text}` });
  }
  if (msgs.length > 1 && msgs[1].role !== "user") msgs.splice(1, 0, { role: "user", content: "[event] conversation start" });
  return msgs;
}

async function openrouter(messages, tools) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": `https://${PUBLIC_HOST}`, "X-Title": "Walk & Hack" },
      body: JSON.stringify({ model: TALKER_MODEL, messages, tools, tool_choice: "auto", max_tokens: 1500, temperature: 0.4 }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(`openrouter ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
    return data.choices[0].message;
  } finally {
    clearTimeout(timer);
  }
}

async function talk(key, channel, conversationId, memory) {
  const user = state.users[key];
  const messages = toMessages(key, user, channel, memory);
  let reply = "";
  for (let i = 0; i < 3; i += 1) {
    const msg = await openrouter(messages, TOOLS);
    if (msg.content) reply = String(msg.content).trim();
    const calls = msg.tool_calls || [];
    if (!calls.length) break;
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) { console.warn("[wah] tool args unparsable:", String(call.function.arguments).slice(0, 200)); }
      let result;
      if (call.function.name === "build") {
        const lastUser = [...user.turns].reverse().find((t) => t.role === "user")?.text || "";
        const instructions = String(args.instructions || "").trim() || `Apply this change to the existing app: ${lastUser}`;
        result = startBuild(key, instructions, String(args.title || "").slice(0, 60) || null, channel, conversationId);
        addTurn(user, { role: "event", text: `build tool called (${result.status}) with title "${user.title || args.title}" and instructions: ${instructions.slice(0, 300)}` });
      } else if (call.function.name === "call") {
        result = await placeCall(key, String(args.to || ""), String(args.message || ""));
        addTurn(user, { role: "event", text: `call tool: ${result.status} (${result.note})` });
      } else if (call.function.name === "set_name") {
        user.name = String(args.name || "").slice(0, 40) || null;
        saveState();
        result = { status: "ok", note: `Name recorded: ${user.name}` };
      } else {
        result = { status: "error", note: "unknown tool" };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return reply;
}

function fallbackReply(key, text, channel, conversationId) {
  const r = startBuild(key, text, null, channel, conversationId);
  if (r.status === "started") return channel === "voice" ? "Got it, building that now. I'll text you the link." : "On it. Building now; I'll text you the link in a minute.";
  if (r.status === "queued") return channel === "voice" ? "Got it, I'll add that right after the current build." : "Got it. I'll fold that in right after the current build finishes.";
  return r.note;
}

export async function handleAgentMessage(userMessage, context = {}) {
  const key = userKey(context);
  const user = state.users[key];
  const raw = String(userMessage || "").trim();
  const channel = context.channel === "voice" ? "voice" : "sms";
  const { found, redacted } = extractKeys(raw);
  const text = redacted;
  const word = text.toLowerCase().replace(/[^a-z]/g, "");

  if (word === "stop" || word === "unsubscribe" || word === "cancel") {
    user.optedOut = true;
    saveState();
    return channel === "voice" ? "Okay, I won't text you again. Bye." : null;
  }
  if (word === "start" || word === "unstop") { user.optedOut = false; saveState(); }
  if (!text) return channel === "voice" ? "I didn't catch that. Tell me what you'd like to build." : MASTHEAD;

  return withLock(key, async () => {
    const firstContact = user.turns.length === 0;
    addTurn(user, { role: "user", ch: channel, text });
    const names = Object.keys(found);
    if (names.length) {
      secrets[key] = { ...(secrets[key] || {}), ...found };
      saveSecrets();
      const labels = names.map((n) => KEY_LABELS[n] || n).join(" and ");
      try {
        await writeSecretsFile(key);
        console.log(`[wah] ${key} stored keys: ${names.join(", ")}`);
        addTurn(user, { role: "event", text: `Caller's keys stored in .env.local on their app server: ${names.join(", ")}. The value never appears in this transcript.` });
      } catch (e) {
        console.error(`[wah] ${key} storing keys failed:`, e.message);
        const fail = `Got your ${labels} key but couldn't save it to your app just now. Text it again in a minute.`;
        addTurn(user, { role: "assistant", ch: channel, text: fail });
        return fail;
      }
      const rest = text.replace(/\[[A-Z0-9_]+ saved\]/g, "").replace(/[^A-Za-z]/g, "");
      if (rest.length < 25) {
        const r = startBuild(key, `The caller just added their own API key(s) (${names.join(", ")}). Wire the existing app to use them from server-side code so visitors need no key and never see one. If the app has no feature that needs them yet, just load them on the server so they are ready, and keep everything else unchanged.`, null, channel, context.conversationId);
        const reply = `Saved your ${labels} key on your app's server. Visitors never see it, and it's out of this chat. ${r.status === "queued" ? "I'll wire it in right after the current build." : r.status === "started" ? "Wiring your app to use it now; link coming." : r.note}\n\nTip: use a key with a spending limit and revoke it after today.`;
        addTurn(user, { role: "assistant", ch: channel, text: reply });
        if (firstContact && channel === "sms") return `${MASTHEAD}\n\n${reply}`;
        return reply;
      }
    }
    let reply;
    try {
      reply = OPENROUTER_API_KEY ? await talk(key, channel, context.conversationId, context.memory) : "";
    } catch (e) {
      console.error("[wah] talker failed:", e.message);
      reply = "";
    }
    if (!reply) reply = fallbackReply(key, text, channel, context.conversationId);
    addTurn(user, { role: "assistant", ch: channel, text: reply });

    if (firstContact) {
      if (channel === "sms") return `${MASTHEAD}\n\n${reply}`;
      sendText(user, null, MASTHEAD).catch((e) => console.warn("[wah] masthead text failed:", e.message));
    }
    return reply;
  });
}

// ---------- health ----------

const healthLog = { lastError: null, lastErrorAt: null, lastTaskAt: null, lastTaskOk: null };
const origError = console.error.bind(console);
console.error = (...args) => { healthLog.lastError = args.map(String).join(" ").slice(0, 300); healthLog.lastErrorAt = now(); origError(...args); };

export async function health() {
  const users = Object.values(state.users);
  const out = {
    ok: true, at: now(), users: users.length, building: users.filter((u) => u.running).length,
    builds: users.reduce((n, u) => n + (u.tasks || 0), 0), optedOut: users.filter((u) => u.optedOut).length,
    talker: Boolean(OPENROUTER_API_KEY), tac: Boolean(tacRef), uptimeS: Math.round(process.uptime()),
    sandboxd: { ok: false, ms: null, count: null, running: null, error: null }, ...healthLog,
  };
  const t0 = Date.now();
  try {
    const list = await Promise.race([sb("GET", "/v1/apps"), sleep(8000).then(() => { throw new Error("sandboxd timeout 8s"); })]);
    const arr = Array.isArray(list) ? list : list?.apps || [];
    const sample = users.find((u) => u.sandboxId)?.sandboxId;
    let running = null;
    if (sample) { try { running = (await sb("GET", `/v1/sandboxes/${sample}`))?.status || null; } catch (e) { running = `err: ${e.message}`; } }
    out.sandboxd = { ok: true, ms: Date.now() - t0, count: arr.length, running, error: null };
  } catch (e) {
    out.sandboxd = { ok: false, ms: Date.now() - t0, count: null, running: null, error: e.message };
    out.ok = false;
  }
  return out;
}

export function noteTask(ok) { healthLog.lastTaskAt = now(); healthLog.lastTaskOk = ok; }

// ---------- group nudges ----------

export async function broadcast(text, { dry = false, only = null } = {}) {
  const body = String(text || "").trim();
  if (!body) throw new Error("empty nudge");
  const seen = new Set();
  const result = { sent: 0, skipped: 0, failed: 0, dry, recipients: 0 };
  for (const user of Object.values(state.users)) {
    const phone = String(user.phone || "").replace(/[^0-9+]/g, "");
    if (!phone || user.optedOut || seen.has(phone)) { result.skipped++; continue; }
    if (only && !only.includes(phone)) { result.skipped++; continue; }
    seen.add(phone);
    result.recipients++;
    if (dry) continue;
    try {
      await sendText(user, null, body);
      addTurn(user, { role: "event", text: `Texted the whole group: "${body}"` });
      result.sent++;
    } catch (e) {
      console.warn("[wah] nudge failed for", phone.slice(-4), e.message);
      result.failed++;
    }
  }
  saveState();
  return result;
}

// ---------- the wall ----------

export async function publicBuilds() {
  for (const u of Object.values(state.users)) {
    if (u.sandboxId && !u.link && u.tasks > 0) {
      try { u.link = (await previewUrl(u.sandboxId)).url; saveState(); } catch { /* next time */ }
    }
  }
  return Object.values(state.users)
    .filter((u) => u.link && u.tasks > 0)
    .map((u) => ({ title: u.title || "Untitled build", name: u.name || null, submitted: Boolean(u.name), link: u.link, builds: u.tasks, updatedAt: u.updatedAt || u.createdAt, building: Boolean(u.running) }))
    .sort((a, b) => (Number(b.submitted) - Number(a.submitted)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
