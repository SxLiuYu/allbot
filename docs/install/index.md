---
summary: "Install AllBot -- one-click installer, npm, Docker, and source build"
read_when:
  - You need an install method other than the Getting Started quickstart
  - You want to deploy to a cloud platform
  - You need to update, migrate, or uninstall
title: "Install"
---

# Install

AllBot supports multiple installation methods: one-click installer (recommended for most users), npm, Docker, or build from source.
（AllBot 支持多种安装方式：一键安装（推荐）、npm、Docker 或从源码构建。）

## System requirements

- **Node.js >= 22** -- Node 24 recommended
- **pnpm** -- required for building from source (`corepack enable`)
- **macOS, Linux, or Windows** -- both native Windows and WSL2 are supported; WSL2 is more stable. See [Windows](/platforms/windows).

## One-click install (recommended / 推荐)

**macOS / Linux:**

```bash
curl -fsSL https://github.com/SxLiuYu/allbot/raw/main/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
iwr -useb https://github.com/SxLiuYu/allbot/raw/main/scripts/install.ps1 | iex
```

The script auto-detects your system, installs Node.js if needed, and launches
the `allbot onboard` wizard.（自动检测系统、安装 Node.js，并启动 onboard 向导。）

## Release tarball

If you already have Node.js 22+:

```bash
curl -fsSL https://github.com/SxLiuYu/allbot/raw/main/scripts/install.sh | bash
allbot onboard
```

> `npm install -g allbot` installs an unrelated project — that name on npm is taken.

## Source build

Clone the repo, install dependencies, and build:

```bash
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
pnpm install
pnpm build
```

<Tip>
国内镜像加速：`pnpm install --registry https://registry.npmmirror.com`
</Tip>

Then run onboarding and start the Gateway:

```bash
pnpm allbot onboard      # interactive setup wizard
pnpm allbot gateway --port 18789
```

Or link the CLI globally and use `allbot` directly:

```bash
pnpm link --global
allbot onboard
allbot gateway --port 18789
```

See [Setup](/start/setup) for full development workflows.

## Docker

For containerized or headless deployments:

```bash
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
docker compose up -d
```

The default `docker-compose.yml` runs the gateway service on port 18789. Configure via environment variables:

- `ZAI_API_KEY` -- LLM provider API key
- `ALLBOT_GATEWAY_TOKEN` -- gateway authentication token
- `ALLBOT_GATEWAY_PORT` -- override the default port (18789)
- `ALLBOT_GATEWAY_BIND` -- override the bind address

Config directory is mounted at `/home/node/.allbot`. See [Docker](/install/docker) for details.

## Cloud deployment

Deploy AllBot on a cloud server or VPS. The source build steps apply to any Linux VM:

```bash
# On your server
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
pnpm install --frozen-lockfile
pnpm build
allbot onboard
allbot gateway --port 18789
```

<CardGroup cols={3}>
  <Card title="VPS" href="/vps">Any Linux VPS</Card>
  <Card title="Docker VM" href="/install/docker-vm-runtime">Shared Docker steps</Card>
  <Card title="Kubernetes" href="/install/kubernetes">K8s</Card>
</CardGroup>

For managed startup after install:

- macOS: LaunchAgent via `allbot gateway install`
- Linux/WSL2: systemd user service via the same command
- Native Windows: Scheduled Task

## Verify the install

```bash
allbot --version      # confirm the CLI is available
allbot doctor         # check for config issues
allbot gateway status # verify the Gateway is running
```

## Update, migrate, or uninstall

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Keep AllBot up to date.
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    Move to a new machine.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    Remove AllBot completely.
  </Card>
</CardGroup>

For source builds, update by pulling the latest changes:

```bash
cd allbot
git pull
pnpm install
pnpm build
```

## Troubleshooting: `allbot` not found

If you used `pnpm link --global` but `allbot` is not found in your terminal:

```bash
node -v           # Node installed?
pnpm root -g      # Where are global packages?
echo "$PATH"      # Is the global bin dir in PATH?
```

If the pnpm global bin directory is not in your `$PATH`, add it to your shell startup file (`~/.zshrc` or `~/.bashrc`):

```bash
export PATH="$(pnpm bin -g):$PATH"
```

Then open a new terminal. See [Node setup](/install/node) for more details.
