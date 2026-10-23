// Walk & Hack monitor. Runs on Zo as a process service. Checks the live stack every 2 min,
// texts Jon on failure (after 2 consecutive misses) and on recovery, restarts the bridge or
// sandboxd via SSM once per 15 min when they fail, and sends one "all green" heartbeat at 9:30 ET Sat.
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const ENV = loadEnv("/home/workspace/Projects/walk-and-hack/.env");
const HOST = "https://walk.dweller.sh";
const TO = "+16173656358";
const FROM = ENV.TWILIO_PHONE_NUMBER!;
const INSTANCE = "i-02141dd122d2b508d";
const REGION = "us-east-1";
const STATE_FILE = "/home/workspace/Projects/walk-and-hack/ops/.monitor-state.json";
const INTERVAL_MS = 120_000;
const FAILS_TO_ALERT = 2;
const REALERT_MS = 30 * 60_000;
const REMEDIATE_COOLDOWN_MS = 15 * 60_000;
const HEARTBEAT_AT = "2026-10-24T13:30"; // UTC = 09:30 ET
const once = process.argv.includes("--once");
const testSms = process.argv.includes("--test-sms");

type Check = { name: string; ok: boolean; detail: string };
type Slot = { fails: number; alerted: boolean; lastAlertAt: number; lastRemediateAt: number };
const state: { slots: Record<string, Slot>; heartbeatSent?: boolean } = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { slots: {} };
const slot = (n: string) => (state.slots[n] ??= { fails: 0, alerted: false, lastAlertAt: 0, lastRemediateAt: 0 });
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function loadEnv(p: string) {
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

async function get(url: string, ms: number, accept = "application/json") {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const t0 = Date.now(); const r = await fetch(url, { signal: c.signal, headers: { Accept: accept } }); return { r, ms: Date.now() - t0 }; }
  finally { clearTimeout(t); }
}

async function checkBridge(): Promise<Check[]> {
  try {
    const { r, ms } = await get(`${HOST}/healthz?deep=1`, 15_000);
    const h: any = await r.json().catch(() => ({}));
    const bridge = { name: "bridge", ok: r.status === 200 || r.status === 503, detail: `HTTP ${r.status} in ${ms}ms, ${h.users ?? "?"} callers, ${h.builds ?? "?"} builds, ${h.building ?? 0} building` };
    const sandboxd = { name: "sandboxd", ok: Boolean(h.sandboxd?.ok), detail: h.sandboxd?.ok ? `${h.sandboxd.count} apps, ${h.sandboxd.ms}ms` : `down: ${h.sandboxd?.error || "no data"}` };
    const err = h.lastErrorAt && Date.now() - Date.parse(h.lastErrorAt) < INTERVAL_MS * 2 ? [{ name: "bridge-error", ok: false, detail: String(h.lastError).slice(0, 160) }] : [];
    return [bridge, sandboxd, ...err];
  } catch (e: any) {
    return [{ name: "bridge", ok: false, detail: `unreachable: ${e.message}` }, { name: "sandboxd", ok: false, detail: "unknown (bridge unreachable)" }];
  }
}

async function checkPreview(): Promise<Check> {
  try {
    const { r } = await get(`${HOST}/wall.json`, 10_000);
    const items: any[] = await r.json();
    if (!items.length) return { name: "preview", ok: true, detail: "no apps on the wall yet" };
    const link = items[0].link;
    let { r: p, ms } = await get(link, 25_000, "text/html");
    if (p.status === 404) { await Bun.sleep(8000); ({ r: p, ms } = await get(link, 25_000, "text/html")); }
    return { name: "preview", ok: p.status === 200, detail: `${link.replace("https://", "")} HTTP ${p.status} in ${ms}ms` };
  } catch (e: any) { return { name: "preview", ok: false, detail: e.message }; }
}

let lastTwilioCheck = 0; let lastTwilio: Check = { name: "twilio", ok: true, detail: "not checked yet" };
async function checkTwilio(): Promise<Check> {
  if (Date.now() - lastTwilioCheck < 30 * 60_000) return lastTwilio;
  lastTwilioCheck = Date.now();
  try {
    const auth = "Basic " + Buffer.from(`${ENV.TWILIO_API_KEY}:${ENV.TWILIO_API_SECRET}`).toString("base64");
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(FROM)}`, { headers: { Authorization: auth } });
    const j: any = await r.json(); const n = j.incoming_phone_numbers?.[0];
    if (!n) return (lastTwilio = { name: "twilio", ok: false, detail: `number not found (HTTP ${r.status})` });
    const ok = n.sms_url === `${HOST}/webhook` && n.voice_url === `${HOST}/twiml`;
    return (lastTwilio = { name: "twilio", ok, detail: ok ? "webhooks point at walk.dweller.sh" : `webhooks drifted: sms=${n.sms_url} voice=${n.voice_url}` });
  } catch (e: any) { return (lastTwilio = { name: "twilio", ok: false, detail: e.message }); }
}

async function sms(body: string) {
  const auth = "Basic " + Buffer.from(`${ENV.TWILIO_API_KEY}:${ENV.TWILIO_API_SECRET}`).toString("base64");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST", headers: { Authorization: auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: FROM, To: TO, Body: `[walk monitor] ${body}`.slice(0, 1500) }),
  });
  log("sms", r.status, body); return r.ok;
}

async function ssm(cmd: string) {
  const p = Bun.spawn(["aws", "ssm", "send-command", "--region", REGION, "--instance-ids", INSTANCE, "--document-name", "AWS-RunShellScript", "--parameters", JSON.stringify({ commands: [cmd] }), "--query", "Command.CommandId", "--output", "text"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text(); const err = await new Response(p.stderr).text(); await p.exited;
  if (p.exitCode !== 0) throw new Error(err.trim().slice(0, 200) || "ssm failed");
  return out.trim();
}

const REMEDY: Record<string, string> = {
  bridge: "systemctl restart wah-bridge",
  sandboxd: "cd /opt/sandboxd/src && docker compose up -d && sleep 5 && systemctl restart wah-bridge",
};

async function tick() {
  const checks = [...(await checkBridge()), await checkPreview(), await checkTwilio()];
  const line = checks.map((c) => `${c.ok ? "ok " : "FAIL"} ${c.name}: ${c.detail}`).join(" | ");
  log(line);
  for (const c of checks) {
    const s = slot(c.name);
    if (c.ok) {
      if (s.alerted) { await sms(`${c.name} recovered. ${c.detail}`); }
      s.fails = 0; s.alerted = false; continue;
    }
    s.fails += 1;
    const threshold = c.name === "twilio" || c.name === "bridge-error" ? 1 : FAILS_TO_ALERT;
    if (s.fails < threshold) continue;
    let remedy = "";
    if (REMEDY[c.name] && Date.now() - s.lastRemediateAt > REMEDIATE_COOLDOWN_MS) {
      s.lastRemediateAt = Date.now();
      try { await ssm(REMEDY[c.name]); remedy = ` Sent "${REMEDY[c.name].split("&&")[0].trim()}" to the box; next check in 2 min.`; }
      catch (e: any) { remedy = ` Could not reach the box over SSM (${e.message}); it may be down entirely.`; }
    }
    if (!s.alerted || Date.now() - s.lastAlertAt > REALERT_MS) {
      s.alerted = true; s.lastAlertAt = Date.now();
      await sms(`${c.name} DOWN (${s.fails} checks). ${c.detail}.${remedy}`);
    }
  }
  const now = new Date().toISOString().slice(0, 16);
  if (!state.heartbeatSent && now >= HEARTBEAT_AT) {
    state.heartbeatSent = true;
    const bad = checks.filter((c) => !c.ok);
    await sms(bad.length ? `9:30 check: ${bad.length} problem(s): ${bad.map((c) => `${c.name} (${c.detail})`).join("; ")}` : `9:30 check, all green. ${checks.map((c) => c.detail).slice(0, 2).join(". ")}. Preview and Twilio webhooks ok.`);
  }
  save();
}

if (testSms) { await sms("armed. Checking the bridge, sandboxd, preview links and Twilio webhooks every 2 min until teardown. You'll only hear from me if something breaks, recovers, or at 9:30 Sat."); }
if (once) { await tick(); process.exit(0); }
log("monitor started"); 
while (true) { try { await tick(); } catch (e: any) { log("tick failed", e.message); } await Bun.sleep(INTERVAL_MS); }
