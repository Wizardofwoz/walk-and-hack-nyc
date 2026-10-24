import "dotenv/config";

import { SMSChannel, TAC, TACConfig, TACServer, VoiceChannel } from "twilio-agent-connect";

import { attachTAC, broadcast, extractKeys, handleAgentMessage, health, publicBuilds } from "./agents/wah-agent.js";
import { wallHtml } from "./agents/wall.js";

for (const name of [
  "TWILIO_RCS_SENDER_ID",
  "TWILIO_WHATSAPP_NUMBER",
  "TWILIO_VOICE_PUBLIC_DOMAIN",
  "OPENAI_MODEL",
  "AIR_QUALITY_PROVIDER",
  "AIRNOW_API_KEY",
]) {
  if (!process.env[name]) delete process.env[name];
}

const tac = await TAC.create({ config: TACConfig.fromEnv() });
attachTAC(tac);

tac.registerChannel(new VoiceChannel(tac, { memoryMode: "always" }));
tac.registerChannel(new SMSChannel(tac, { memoryMode: "always" }));

tac.onMessageReady(async ({ conversationId, profileId, message, author, memory, session, channel }) => {
  console.log(`[${channel}] ${extractKeys(message || "").redacted}`);
  return handleAgentMessage(message, { conversationId, profileId, author, memory, session, channel });
});

const server = new TACServer(tac, {
  host: process.env.TWILIO_SERVER_HOST || "0.0.0.0",
  port: Number.parseInt(process.env.TWILIO_SERVER_PORT || process.env.PORT || "8000", 10),
  conversationRelayConfig: {
    welcomeGreeting: "Walk and Hack. Tell me what to build, or what to change.",
    welcomeGreetingInterruptible: "any",
    interruptible: "any",
    hints: "Walk and Hack, Twilio, Central Park, pigeon, web app, build, link",
  },
});

const previewHost = /^[a-z0-9-]+\.app\.dweller\.sh$/i;
server.fastify.get("/tls-ask", (request, reply) => {
  const domain = String(request.query?.domain || "");
  return previewHost.test(domain) ? reply.code(200).send("ok") : reply.code(404).send("no");
});
server.fastify.get("/healthz", async (request, reply) => {
  if (request.query?.deep === undefined) return { ok: true };
  const h = await health();
  return reply.code(h.ok ? 200 : 503).send(h);
});
server.fastify.get("/wall", (request, reply) => reply.type("text/html").send(wallHtml()));
server.fastify.get("/wall.json", () => publicBuilds());
server.fastify.post("/nudge", async (request, reply) => {
  const token = process.env.WAH_NUDGE_TOKEN;
  if (!token || request.headers["x-wah-token"] !== token) return reply.code(401).send({ error: "unauthorized" });
  const { text, dry, only } = request.body || {};
  try {
    return await broadcast(text, { dry: Boolean(dry), only: Array.isArray(only) ? only : null });
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

await server.start();
