---
summary: "Advanced setup and development workflows for AllBot"
read_when:
  - Setting up a new machine
  - You want “latest + greatest” without breaking your personal setup
title: "Setup"
---

# Setup

<Note>
If you are setting up for the first time, start with [Getting Started](/start/getting-started).
For onboarding details, see [Onboarding (CLI)](/start/wizard).
</Note>

## TL;DR

- **Tailoring lives outside the repo:** `~/.allbot/workspace` (workspace) + `~/.allbot/allbot.json` (config).
- **Standard workflow:** run `allbot setup`, configure Feishu credentials, then start the Gateway.
- **Bleeding edge workflow:** run the Gateway yourself via `pnpm gateway:watch` for hot-reload development.

## Prereqs (from source)

- Node 24 recommended (Node 22 LTS, currently `22.14+`, still supported)
- `pnpm` preferred (or Bun if you intentionally use the [Bun workflow](/install/bun))
- Docker (optional; only for containerized setup/e2e — see [Docker](/install/docker))

## Tailoring strategy (so updates do not hurt)

If you want “100% tailored to me” _and_ easy updates, keep your customization in:

- **Config:** `~/.allbot/allbot.json` (JSON/JSON5-ish)
- **Workspace:** `~/.allbot/workspace` (skills, prompts, memories; make it a private git repo)

Bootstrap once:

```bash
allbot setup
```

From inside this repo, use the local CLI entry:

```bash
allbot setup
```

If you don’t have a global install yet, run it via `pnpm allbot setup` (or `bun run allbot setup` if you are using the Bun workflow).

## Run the Gateway from this repo

After `pnpm build`, you can run the packaged CLI directly:

```bash
node allbot.mjs gateway --port 18789 --verbose
```

## Standard workflow (Feishu channel)

1. Run setup:

```bash
allbot setup
```

2. Configure Feishu credentials:

```bash
allbot config set channels.feishu.appId "your-app-id"
allbot config set channels.feishu.appSecret "your-app-secret"
```

Create your Feishu app at [open.feishu.cn](https://open.feishu.cn/) and enable
WebSocket events.

3. Start the Gateway:

```bash
allbot gateway
```

4. Sanity check:

```bash
allbot health
```

If onboarding is not available in your build:

- Run `allbot setup`, then `allbot gateway` manually.

## Bleeding edge workflow (Gateway in a terminal)

Goal: work on the TypeScript Gateway, get hot reload.

### 1) Start the dev Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` runs the gateway in watch mode and reloads on relevant source,
config, and bundled-plugin metadata changes.

If you are intentionally using the Bun workflow, the equivalent commands are:

```bash
bun install
bun run gateway:watch
```

### 2) Verify

```bash
allbot health
```

### Common footguns

- **Wrong port:** Gateway WS defaults to `ws://127.0.0.1:18789`; keep app + CLI on the same port.
- **Where state lives:**
  - Channel/provider state: `~/.allbot/credentials/`
  - Model auth profiles: `~/.allbot/agents/<agentId>/agent/auth-profiles.json`
  - Sessions: `~/.allbot/agents/<agentId>/sessions/`
  - Logs: `/tmp/allbot/`

## Credential storage map

Use this when debugging auth or deciding what to back up:

- **Feishu credentials**: `channels.feishu.appId` and `channels.feishu.appSecret` in config or env
- **Pairing allowlists**:
  - `~/.allbot/credentials/<channel>-allowFrom.json` (default account)
  - `~/.allbot/credentials/<channel>-<accountId>-allowFrom.json` (non-default accounts)
- **Model auth profiles**: `~/.allbot/agents/<agentId>/agent/auth-profiles.json`
- **File-backed secrets payload (optional)**: `~/.allbot/secrets.json`
- **Legacy OAuth import**: `~/.allbot/credentials/oauth.json`
  More detail: [Security](/gateway/security#credential-storage-map).

## Updating (without wrecking your setup)

- Keep `~/.allbot/workspace` and `~/.allbot/` as “your stuff”; don’t put personal prompts/config into the `allbot` repo.
- Updating source: `git pull` + your chosen package-manager install step (`pnpm install` by default; `bun install` for Bun workflow) + keep using the matching `gateway:watch` command.

## Linux (systemd user service)

Linux installs use a systemd **user** service. By default, systemd stops user
services on logout/idle, which kills the Gateway. Onboarding attempts to enable
lingering for you (may prompt for sudo). If it’s still off, run:

```bash
sudo loginctl enable-linger $USER
```

For always-on or multi-user servers, consider a **system** service instead of a
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + examples)
- [Feishu](/channels/feishu) (App ID, App Secret, WebSocket event setup)
- [AllBot assistant setup](/start/allbot)
