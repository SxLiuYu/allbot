---
summary: "Updating AllBot safely (global install or source), plus rollback strategy"
read_when:
  - Updating AllBot
  - Something breaks after an update
title: "Updating"
---

# Updating

Keep AllBot up to date.

## Recommended: `allbot update`

The fastest way to update. It detects your install type (npm or git), fetches the latest version, runs `allbot doctor`, and restarts the gateway.

```bash
allbot update
```

To switch channels or target a specific version:

```bash
allbot update --channel beta
allbot update --tag main
allbot update --dry-run   # preview without applying
```

`--channel beta` prefers beta, but the runtime falls back to stable/latest when
the beta tag is missing or older than the latest stable release. Use `--tag beta`
if you want the raw npm beta dist-tag for a one-off package update.

See [Development channels](/install/development-channels) for channel semantics.

## Alternative: re-run from source

```bash
cd allbot
git pull
pnpm install
pnpm build
```

## Alternative: manual pnpm or bun

```bash
pnpm add -g allbot@latest
```

```bash
bun add -g allbot@latest
```

## Auto-updater

The auto-updater is off by default. Enable it in `~/.allbot/allbot.json`:

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
      stableDelayHours: 6,
      stableJitterHours: 12,
      betaCheckIntervalHours: 1,
    },
  },
}
```

| Channel  | Behavior                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `stable` | Waits `stableDelayHours`, then applies with deterministic jitter across `stableJitterHours` (spread rollout). |
| `beta`   | Checks every `betaCheckIntervalHours` (default: hourly) and applies immediately.                              |
| `dev`    | No automatic apply. Use `allbot update` manually.                                                           |

The gateway also logs an update hint on startup (disable with `update.checkOnStart: false`).

## After updating

<Steps>

### Run doctor

```bash
allbot doctor
```

Migrates config, audits DM policies, and checks gateway health. Details: [Doctor](/gateway/doctor)

### Restart the gateway

```bash
allbot gateway restart
```

### Verify

```bash
allbot health
```

</Steps>

## Rollback

### Pin a version (source build)

```bash
cd allbot
git checkout <tag>
pnpm install
pnpm build
allbot doctor
allbot gateway restart
```

Tip: `git tag -l` shows available versions.

### Pin a commit (source)

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
pnpm install && pnpm build
allbot gateway restart
```

To return to latest: `git checkout main && git pull`.

## If you are stuck

- Run `allbot doctor` again and read the output carefully.
- For `allbot update --channel dev` on source checkouts, the updater auto-bootstraps `pnpm` when needed. If you see a pnpm/corepack bootstrap error, install `pnpm` manually (or re-enable `corepack`) and rerun the update.
- Check: [Troubleshooting](/gateway/troubleshooting)
- Report issues: [github.com/Kaiji-Z/kaijibot/issues](https://github.com/Kaiji-Z/kaijibot/issues)

## Related

- [Install Overview](/install) — all installation methods
- [Doctor](/gateway/doctor) — health checks after updates
- [Migrating](/install/migrating) — major version migration guides
