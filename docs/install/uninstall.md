---
summary: "Uninstall AllBot completely (CLI, service, state, workspace)"
read_when:
  - You want to remove AllBot from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

# Uninstall

Two paths:

- **Easy path** if `allbot` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
allbot uninstall
```

Non-interactive (automation / npx):

```bash
allbot uninstall --all --yes --non-interactive
npx -y allbot uninstall --all --yes --non-interactive
```

Manual steps (same result):

1. Stop the gateway service:

```bash
allbot gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
allbot gateway uninstall
```

3. Delete state + config:

```bash
rm -rf "${ALLBOT_STATE_DIR:-$HOME/.allbot}"
```

If you set `ALLBOT_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4. Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/.allbot/workspace
```

5. Remove the CLI install (pick the one you used):

```bash
pnpm remove -g allbot
bun remove -g allbot
```

6. If you installed the macOS app:

```bash
rm -rf /Applications/AllBot.app
```

Notes:

- If you used profiles (`--profile` / `ALLBOT_PROFILE`), repeat step 3 for each state dir (defaults are `~/.allbot-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `allbot` is missing.

### macOS (launchd)

Default label is `ai.allbot.gateway` (or `ai.allbot.<profile>`; legacy `com.allbot.*` may still exist):

```bash
launchctl bootout gui/$UID/ai.allbot.gateway
rm -f ~/Library/LaunchAgents/ai.allbot.gateway.plist
```

If you used a profile, replace the label and plist name with `ai.allbot.<profile>`. Remove any legacy `com.allbot.*` plists if present.

### Linux (systemd user unit)

Default unit name is `allbot-gateway.service` (or `allbot-gateway-<profile>.service`):

```bash
systemctl --user disable --now allbot-gateway.service
rm -f ~/.config/systemd/user/allbot-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `AllBot Gateway` (or `AllBot Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "AllBot Gateway"
Remove-Item -Force "$env:USERPROFILE\.allbot\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.allbot-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (pnpm / bun)

If you installed via pnpm or bun, remove with `pnpm remove -g allbot` (or `bun remove -g`).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `allbot ...` / `bun run allbot ...`):

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. Delete the repo directory.
3. Remove state + workspace as shown above.
