---
summary: "CLI reference for `allbot browser` (lifecycle, profiles, tabs, actions, state, and debugging)"
read_when:
  - You use `allbot browser` and want examples for common tasks
  - You want to control a browser running on another machine via a node host
  - You want to attach to your local signed-in Chrome via Chrome MCP
title: "browser"
---

# `allbot browser`

Manage AllBot's browser control surface and run browser actions (lifecycle, profiles, tabs, snapshots, screenshots, navigation, input, state emulation, and debugging).

Related:

- Browser tool + API: [Browser tool](/tools/browser)

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (defaults to config).
- `--token <token>`: Gateway token (if required).
- `--timeout <ms>`: request timeout (ms).
- `--expect-final`: wait for a final Gateway response.
- `--browser-profile <name>`: choose a browser profile (default from config).
- `--json`: machine-readable output (where supported).

## Quick start (local)

```bash
allbot browser profiles
allbot browser --browser-profile allbot start
allbot browser --browser-profile allbot open https://example.com
allbot browser --browser-profile allbot snapshot
```

## Lifecycle

```bash
allbot browser status
allbot browser start
allbot browser stop
allbot browser --browser-profile allbot reset-profile
```

Notes:

- For `attachOnly` and remote CDP profiles, `allbot browser stop` closes the
  active control session and clears temporary emulation overrides even when
  AllBot did not launch the browser process itself.
- For local managed profiles, `allbot browser stop` stops the spawned browser
  process.

## If the command is missing

If `allbot browser` is an unknown command, check `plugins.allow` in
`~/.allbot/allbot.json`.

When `plugins.allow` is present, the bundled browser plugin must be listed
explicitly:

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

`browser.enabled=true` does not restore the CLI subcommand when the plugin
allowlist excludes `browser`.

Related: [Browser tool](/tools/browser#missing-browser-command-or-tool)

## Profiles

Profiles are named browser routing configs. In practice:

- `allbot`: launches or attaches to a dedicated AllBot-managed Chrome instance (isolated user data dir).
- `user`: controls your existing signed-in Chrome session via Chrome DevTools MCP.
- custom CDP profiles: point at a local or remote CDP endpoint.

```bash
allbot browser profiles
allbot browser create-profile --name work --color "#FF5A36"
allbot browser create-profile --name chrome-live --driver existing-session
allbot browser create-profile --name remote --cdp-url https://browser-host.example.com
allbot browser delete-profile --name work
```

Use a specific profile:

```bash
allbot browser --browser-profile work tabs
```

## Tabs

```bash
allbot browser tabs
allbot browser tab new
allbot browser tab select 2
allbot browser tab close 2
allbot browser open https://example.com
allbot browser focus <targetId>
allbot browser close <targetId>
```

## Snapshot / screenshot / actions

Snapshot:

```bash
allbot browser snapshot
```

Screenshot:

```bash
allbot browser screenshot
allbot browser screenshot --full-page
allbot browser screenshot --ref e12
```

Notes:

- `--full-page` is for page captures only; it cannot be combined with `--ref`
  or `--element`.
- `existing-session` / `user` profiles support page screenshots and `--ref`
  screenshots from snapshot output, but not CSS `--element` screenshots.

Navigate/click/type (ref-based UI automation):

```bash
allbot browser navigate https://example.com
allbot browser click <ref>
allbot browser type <ref> "hello"
allbot browser press Enter
allbot browser hover <ref>
allbot browser scrollintoview <ref>
allbot browser drag <startRef> <endRef>
allbot browser select <ref> OptionA OptionB
allbot browser fill --fields '[{"ref":"1","value":"Ada"}]'
allbot browser wait --text "Done"
allbot browser evaluate --fn '(el) => el.textContent' --ref <ref>
```

File + dialog helpers:

```bash
allbot browser upload /tmp/allbot/uploads/file.pdf --ref <ref>
allbot browser waitfordownload
allbot browser download <ref> report.pdf
allbot browser dialog --accept
```

## State and storage

Viewport + emulation:

```bash
allbot browser resize 1280 720
allbot browser set viewport 1280 720
allbot browser set offline on
allbot browser set media dark
allbot browser set timezone Europe/London
allbot browser set locale en-GB
allbot browser set geo 51.5074 -0.1278 --accuracy 25
allbot browser set device "iPhone 14"
allbot browser set headers '{"x-test":"1"}'
allbot browser set credentials myuser mypass
```

Cookies + storage:

```bash
allbot browser cookies
allbot browser cookies set session abc123 --url https://example.com
allbot browser cookies clear
allbot browser storage local get
allbot browser storage local set token abc123
allbot browser storage session clear
```

## Debugging

```bash
allbot browser console --level error
allbot browser pdf
allbot browser responsebody "**/api"
allbot browser highlight <ref>
allbot browser errors --clear
allbot browser requests --filter api
allbot browser trace start
allbot browser trace stop --out trace.zip
```

## Existing Chrome via MCP

Use the built-in `user` profile, or create your own `existing-session` profile:

```bash
allbot browser --browser-profile user tabs
allbot browser create-profile --name chrome-live --driver existing-session
allbot browser create-profile --name brave-live --driver existing-session --user-data-dir "~/Library/Application Support/BraveSoftware/Brave-Browser"
allbot browser --browser-profile chrome-live tabs
```

This path is host-only. For Docker, headless servers, Browserless, or other remote setups, use a CDP profile instead.

Current existing-session limits:

- snapshot-driven actions use refs, not CSS selectors
- `click` is left-click only
- `type` does not support `slowly=true`
- `press` does not support `delayMs`
- `hover`, `scrollintoview`, `drag`, `select`, `fill`, and `evaluate` reject
  per-call timeout overrides
- `select` supports one value only
- `wait --load networkidle` is not supported
- file uploads require `--ref` / `--input-ref`, do not support CSS
  `--element`, and currently support one file at a time
- dialog hooks do not support `--timeout`
- screenshots support page captures and `--ref`, but not CSS `--element`
- `responsebody`, download interception, PDF export, and batch actions still
  require a managed browser or raw CDP profile

## Remote browser control (node host proxy)

If the Gateway runs on a different machine than the browser, run a **node host** on the machine that has Chrome/Brave/Edge/Chromium. The Gateway will proxy browser actions to that node (no separate browser control server required).

Use `gateway.nodes.browser.mode` to control auto-routing and `gateway.nodes.browser.node` to pin a specific node if multiple are connected.

Security + remote setup: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
