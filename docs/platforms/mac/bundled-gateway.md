---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging AllBot.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

# Gateway on macOS (external launchd)

AllBot.app no longer bundles Node/Bun or the Gateway runtime. The macOS app
expects an **external** `allbot` CLI install, does not spawn the Gateway as a
child process, and manages a per‑user launchd service to keep the Gateway
running (or attaches to an existing local Gateway if one is already running).

## Install the CLI (required for local mode)

Node 24 is the default runtime on the Mac. Node 22 LTS, currently `22.14+`, still works for compatibility. Then install `allbot` from source:

```bash
git clone https://github.com/SxLiuYu/allbot
cd allbot
pnpm install
pnpm build
```

The macOS app's **Install CLI** button runs the same build flow the app
uses internally. Node remains the recommended Gateway runtime.

## Launchd (Gateway as LaunchAgent)

Label:

- `ai.allbot.gateway` (or `ai.allbot.<profile>`; legacy `com.allbot.*` may remain)

Plist location (per‑user):

- `~/Library/LaunchAgents/ai.allbot.gateway.plist`
  (or `~/Library/LaunchAgents/ai.allbot.<profile>.plist`)

Manager:

- The macOS app owns LaunchAgent install/update in Local mode.
- The CLI can also install it: `allbot gateway install`.

Behavior:

- “AllBot Active” enables/disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.

Logging:

- launchd stdout/err: `/tmp/allbot/allbot-gateway.log`

## Version compatibility

The macOS app checks the gateway version against its own version. If they’re
incompatible, update the global CLI to match the app version.

## Smoke check

```bash
allbot --version

ALLBOT_SKIP_CHANNELS=1 \
ALLBOT_SKIP_CANVAS_HOST=1 \
allbot gateway --port 18999 --bind loopback
```

Then:

```bash
allbot gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
