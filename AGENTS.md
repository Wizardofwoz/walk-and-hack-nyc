# Walk & Hack (Twilio TAC + sandboxd bridge)

AI Tinkerers NYC event, Sat 2026-10-24, Central Park loop. Attendees text or call one Twilio
number and a coding agent builds them a web app; they get a live link back by text.
Sponsor contact: Kaelyn Chresfield (Twilio devrel). Her repo: `kchresfield/walk-and-hack-nyc`.

## Layout

- This folder is a clone of Kaelyn's repo on branch `bridge`, pushed to the fork
  `Wizardofwoz/walk-and-hack-nyc` (remote `fork`). `origin` is Kaelyn's. Open a PR to her when stable.
- `agents/wah-agent.js` — the bridge. One sandboxd app + sandbox per caller (keyed by TAC
  profileId, else phone). Commands: HELP, LINK, STATUS, NEW. Anything else = a build prompt:
  immediate "on it" reply, background task, result texted via TAC `sendResponse` (falls back to
  Twilio REST if the TAC conversation closed). Per-user state in `data/users.json` (gitignored).
- `server.js` — Kaelyn's starter with the agent import swapped, plus `/healthz` and `/tls-ask`
  (Caddy on-demand TLS allowlist for `*.app.camino.markets`).
- `.env` — Kaelyn's Twilio keys + OpenAI key (gitignored, CRLF stripped). Canonical copy is AWS
  SSM Parameter Store `/wah/bridge.env` (SecureString, us-east-1). `/wah/openrouter.key` holds Jon's OpenRouter key.

## The box (AWS us-east-1, account 645667512744)

- EC2 `i-02141dd122d2b508d`, t3.large, Ubuntu 24.04, 60 GB, EIP `54.174.142.68`, SG `walk-and-hack-web` (80/443),
  IAM role `walk-and-hack-server` (SSM + read `/wah/*`). No SSH: use `aws ssm send-command`.
- DNS (Cloudflare zone camino.markets, unproxied A records): `walk.camino.markets` and `*.app.camino.markets` → EIP.
- Caddy (`/etc/caddy/Caddyfile`): `walk.camino.markets` → bridge :8000; `*.app.camino.markets` → Traefik :8080
  with on-demand TLS gated by the bridge's `/tls-ask`. Note: use `handle` blocks; a bare `respond` runs before `reverse_proxy`.
- Bridge: `/opt/wah/bridge` (this repo, branch `bridge`), systemd `wah-bridge`. Deploy = `/opt/wah/deploy.sh`
  (git fetch fork/bridge, reset, npm install, rebuild `.env` from SSM + `/opt/wah/extra.env`, restart).
  `extra.env` holds `SANDBOXD_API_KEY`, `SANDBOXD_URL`, `WAH_AGENT=opencode`, `WAH_PROVIDER=<model-provider id>`,
  `WAH_MODEL=anthropic/claude-sonnet-5.5`, `WAH_PRESET=react-vite`.
- sandboxd: `/opt/sandboxd/src` (source build, `docker compose`), API `127.0.0.1:9090`, `.env` has
  `PREVIEW_DOMAIN=app.camino.markets PREVIEW_HOST_STYLE=flat HTTP_PORT=8080` and the bootstrap API token.
  Preview URLs come back as `http://s-<id>-<port>.app.camino.markets:8080`; the bridge rewrites to https without port.
  Model: one model-provider "OpenRouter" (openai-completions) with Claude Sonnet 5.5 / Haiku 5.5; agent OpenCode.
  Claude Code is installed in the base image but needs an Anthropic key (`POST /v1/agents/claude-code/api-key`).
  Installer gotcha: `.env` must contain a `SANDBOXD_API_TOKENS=` line or install.sh dies silently (pipefail + grep).
- Smoke test: `/opt/wah/e2e.sh` (creates app `e2e-test`, runs a build, prints the public link).

## Twilio side (Kaelyn's account, number +1 917 512 5901)

- Voice webhook `https://walk.camino.markets/twiml`, SMS webhook `https://walk.camino.markets/webhook`,
  Conversation Configuration `conv_configuration_01m4xtgh6dep4tkzm7rvq0yygv` status callback → same `/webhook`
  (all set via API 2026-10-21; update the config with PUT of the full object, PATCH is unsupported).

## Not built yet

Dollar spend caps per caller (only a 40-builds/day count, `WAH_MAX_TASKS`), BYOK by text, GitHub push by text,
voice tuning, the event-page quick start. Teardown after the event: terminate the instance, release the EIP,
delete the two DNS records and the SSM params.
