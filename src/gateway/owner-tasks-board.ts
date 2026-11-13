import type { IncomingMessage, ServerResponse } from "node:http";
import { isLocalDirectRequest } from "./auth.js";
import { loadConfig } from "../config/config.js";
import { resolveOwnerTasksConfig } from "../tasks/owner/config.js";
import { createOwnerTaskStore } from "../tasks/owner/store.js";
import { resolveOwnerTaskDisplayId } from "../tasks/owner/store.js";
import type { OwnerTaskRecord } from "../tasks/owner/types.js";

const BOARD_PATH = "/__allbot/owner-tasks";
const BOARD_DATA_PATH = "/__allbot/owner-tasks.json";
const STATUS_ORDER = [
  "in_progress",
  "needs_review",
  "pending",
  "done",
  "failed",
  "cancelled",
] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBoard(tasks: readonly OwnerTaskRecord[], enabled: boolean): string {
  const rows = tasks
    .map((task) => {
      const result = (task.resultText ?? "").slice(0, 200);
      return `<tr data-status="${task.status}">
  <td><code>${escapeHtml(resolveOwnerTaskDisplayId(task))}</code></td>
  <td>${escapeHtml(task.title)}</td>
  <td><span class="s s-${task.status}">${task.status}</span>${task.sensitivity && task.sensitivity !== "normal" ? ` <b class="sensitive">${escapeHtml(task.sensitivity)}</b>` : ""}</td>
  <td>${task.attemptCount}</td>
  <td>v${task.resultVersion}</td>
  <td>${escapeHtml(task.ownerId)}</td>
  <td>${escapeHtml(task.execution?.environment ?? "gateway")}${task.execution?.requiresDevice ? " · device-required" : ""}</td>
  <td>${new Date(task.updatedAt).toISOString()}</td>
  <td class="result">${escapeHtml(result)}</td>
</tr>`;
    })
    .join("\n");
  const counts = STATUS_ORDER.map(
    (status) => `${status}: ${tasks.filter((task) => task.status === status).length}`,
  ).join(" · ");
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>Owner Tasks</title>
<style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:24px;background:#111;color:#ddd}
h1{font-size:20px;margin:0 0 4px}.meta{color:#999;margin-bottom:16px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #333;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#1c1c1c;color:#aaa;font-weight:500}
code{color:#7cf}.result{max-width:420px;color:#bbb;word-break:break-word}
.s{padding:1px 6px;border-radius:3px;font-size:12px}
.s-in_progress{background:#264;color:#cfc}.s-needs_review{background:#642;color:#fdc}
.s-done{background:#246;color:#cdf}.s-failed{background:#622;color:#fcc}.s-cancelled{background:#333;color:#999}
.s-pending{background:#553;color:#edc}
.sensitive{color:#f88;font-weight:600}
</style></head><body>
<h1>Owner Tasks</h1>
<div class="meta">tasks.enabled=${enabled ? "true" : "false"} · ${escapeHtml(counts)} · total ${tasks.length}</div>
<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Attempt</th><th>Result</th><th>Owner</th><th>Execution</th><th>Updated</th><th>Result preview</th></tr></thead>
<tbody>${rows || '<tr><td colspan="9">No tasks</td></tr>'}</tbody></table>
</body></html>`;
}

/**
 * Read-only HTML board for OwnerTask records. Served directly by the gateway
 * so it works even when the Control UI bundle has not been built.
 */
export function handleOwnerTasksBoardHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== BOARD_PATH && path !== BOARD_DATA_PATH) {
    return false;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return true;
  }
  // Read-only board may contain task results and owner ids: loopback only.
  if (!isLocalDirectRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden: owner task board is loopback-only");
    return true;
  }

  void (async () => {
    try {
      const cfg = loadConfig();
      const enabled = resolveOwnerTasksConfig(cfg).enabled;
      const data = await createOwnerTaskStore().read();
      const tasks = data.tasks.toSorted((a, b) => {
        const ai = STATUS_ORDER.indexOf(a.status as (typeof STATUS_ORDER)[number]);
        const bi = STATUS_ORDER.indexOf(b.status as (typeof STATUS_ORDER)[number]);
        return ai - bi || b.updatedAt - a.updatedAt;
      });
      res.statusCode = 200;
      res.setHeader("Cache-Control", "no-store");
      if (path === BOARD_DATA_PATH) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          method === "HEAD"
            ? undefined
            : JSON.stringify({
                enabled,
                total: tasks.length,
                counts: Object.fromEntries(
                  STATUS_ORDER.map((status) => [
                    status,
                    tasks.filter((task) => task.status === status).length,
                  ]),
                ),
                executionCounts: {
                  gateway: tasks.filter((task) => !task.execution?.environment).length,
                  device: tasks.filter((task) => task.execution?.environment === "device").length,
                  cloud: tasks.filter((task) => task.execution?.environment === "cloud").length,
                  deviceRequired: tasks.filter((task) => task.execution?.requiresDevice).length,
                },
                sensitivityCounts: {
                  normal: tasks.filter(
                    (task) => !task.sensitivity || task.sensitivity === "normal",
                  ).length,
                  sensitive: tasks.filter(
                    (task) => Boolean(task.sensitivity) && task.sensitivity !== "normal",
                  ).length,
                },
                tasks,
              }),
        );
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(method === "HEAD" ? undefined : renderBoard(tasks, enabled));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`owner tasks board unavailable: ${String(err)}`);
    }
  })();
  return true;
}
