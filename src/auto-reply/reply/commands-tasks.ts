import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveCorrectionUserId } from "../../cognitive/correction/userid.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import {
  acceptOwnerTask,
  cancelOwnerTask,
  getOwnerTask,
  listOwnerTasks,
  rejectOwnerTask,
  type OwnerTaskScope,
} from "../../tasks/owner/actions.js";
import { ownerTasksEnabled } from "../../tasks/owner/config.js";
import { resolveOwnerTaskDisplayId } from "../../tasks/owner/store.js";
import { OWNER_TASK_SUMMARY_LIMIT } from "../../tasks/owner/summary.js";
import type { OwnerTaskRecord } from "../../tasks/owner/types.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import {
  listTasksForAgentIdForStatus,
  listTasksForSessionKeyForStatus,
} from "../../tasks/task-status-access.js";
import {
  buildTaskStatusSnapshot,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
} from "../../tasks/task-status.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const MAX_VISIBLE_TASKS = 5;

const TASK_STATUS_ICONS: Record<TaskRecord["status"], string> = {
  queued: "🟡",
  running: "🟢",
  succeeded: "✅",
  failed: "🔴",
  timed_out: "⏱️",
  cancelled: "⚪️",
  lost: "⚠️",
};

const TASK_RUNTIME_LABELS: Record<TaskRecord["runtime"], string> = {
  subagent: "Subagent",
  acp: "ACP",
  cli: "CLI",
  cron: "Cron",
};

function formatTaskHeadline(snapshot: ReturnType<typeof buildTaskStatusSnapshot>): string {
  if (snapshot.totalCount === 0) {
    return "All clear - nothing linked to this session right now.";
  }
  return `Current session: ${snapshot.activeCount} active · ${snapshot.totalCount} total`;
}

function formatAgentFallbackLine(agentId: string): string | undefined {
  const snapshot = buildTaskStatusSnapshot(listTasksForAgentIdForStatus(agentId));
  if (snapshot.totalCount === 0) {
    return undefined;
  }
  return `Agent-local: ${snapshot.activeCount} active · ${snapshot.totalCount} total`;
}

function formatTaskTiming(task: TaskRecord): string | undefined {
  if (task.status === "running") {
    const startedAt = task.startedAt ?? task.createdAt;
    return `elapsed ${formatDurationCompact(Date.now() - startedAt, { spaced: true }) ?? "0s"}`;
  }
  if (task.status === "queued") {
    return `queued ${formatTimeAgo(Date.now() - task.createdAt)}`;
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return `finished ${formatTimeAgo(Date.now() - endedAt)}`;
}

function formatTaskDetail(task: TaskRecord): string | undefined {
  return formatTaskStatusDetail(task);
}

function formatVisibleTask(task: TaskRecord, index: number): string {
  const title = formatTaskStatusTitle(task);
  const status = task.status.replaceAll("_", " ");
  const timing = formatTaskTiming(task);
  const detail = formatTaskDetail(task);
  const meta = [TASK_RUNTIME_LABELS[task.runtime], status, timing].filter(Boolean).join(" · ");
  const lines = [`${index + 1}. ${TASK_STATUS_ICONS[task.status]} ${title}`, `   ${meta}`];
  if (detail) {
    lines.push(`   ${detail}`);
  }
  return lines.join("\n");
}

export function buildTasksText(params: { sessionKey: string; agentId: string }): string {
  const sessionSnapshot = buildTaskStatusSnapshot(
    listTasksForSessionKeyForStatus(params.sessionKey),
  );
  const lines = ["📋 Tasks", formatTaskHeadline(sessionSnapshot)];

  if (sessionSnapshot.totalCount > 0) {
    const visible = sessionSnapshot.visible.slice(0, MAX_VISIBLE_TASKS);
    lines.push("");
    for (const [index, task] of visible.entries()) {
      lines.push(formatVisibleTask(task, index));
      if (index < visible.length - 1) {
        lines.push("");
      }
    }
    const hiddenCount = sessionSnapshot.visible.length - visible.length;
    if (hiddenCount > 0) {
      lines.push("", `+${hiddenCount} more recent task${hiddenCount === 1 ? "" : "s"}`);
    }
    return lines.join("\n");
  }

  const agentFallback = formatAgentFallbackLine(params.agentId);
  if (agentFallback) {
    lines.push(agentFallback);
  }
  return lines.join("\n");
}

export async function buildTasksReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  return {
    text: buildTasksText({
      sessionKey: params.sessionKey,
      agentId,
    }),
  };
}

const OWNER_STATUS_ICONS: Record<OwnerTaskRecord["status"], string> = {
  pending: "🟡",
  in_progress: "🟢",
  needs_review: "🔎",
  done: "✅",
  failed: "🔴",
  cancelled: "⚪️",
};

function resolveOwnerTaskScope(params: HandleCommandsParams): OwnerTaskScope | null {
  const ownerId = resolveCorrectionUserId(params.sessionKey, params.command.to);
  return ownerId ? { ownerId, sessionKey: params.sessionKey } : null;
}

function formatOwnerTaskLine(task: OwnerTaskRecord, index: number): string {
  const version = task.status === "needs_review" ? ` · result v${task.resultVersion}` : "";
  const displayId = resolveOwnerTaskDisplayId(task);
  return (
    `${index + 1}. ${OWNER_STATUS_ICONS[task.status]} [${displayId}] ${task.title}` +
    ` · ${task.status} · attempt ${task.attemptCount}${version}`
  );
}

export function buildOwnerTasksText(tasks: readonly OwnerTaskRecord[]): string {
  const lines = ["📋 Tasks"];
  if (tasks.length === 0) {
    lines.push("No active tasks.");
    return lines.join("\n");
  }
  const visible = tasks.slice(0, OWNER_TASK_SUMMARY_LIMIT);
  lines.push(`${tasks.length} active`);
  for (const [index, task] of visible.entries()) {
    lines.push(formatOwnerTaskLine(task, index));
    if (task.status === "needs_review") {
      const displayId = resolveOwnerTaskDisplayId(task);
      lines.push(`   /tasks accept ${displayId} · /tasks reject ${displayId} <feedback>`);
    }
  }
  if (tasks.length > visible.length) {
    lines.push(`+${tasks.length - visible.length} more`);
  }
  return lines.join("\n");
}

function buildOwnerTaskDetailText(task: OwnerTaskRecord): string {
  const result = (task.resultText ?? "").trim();
  const capped = result.length > 4000 ? `${result.slice(0, 3999)}…` : result;
  const displayId = resolveOwnerTaskDisplayId(task);
  const lines = [
    `${OWNER_STATUS_ICONS[task.status]} [${displayId}] ${task.title}`,
    `Status: ${task.status} · attempt ${task.attemptCount} · result v${task.resultVersion}`,
  ];
  if (task.reviewNote) {
    lines.push(`Last feedback: ${task.reviewNote}`);
  }
  lines.push("", capped || "(no result saved)");
  if (task.status === "needs_review") {
    lines.push(
      "",
      `Accept: /tasks accept ${displayId}`,
      `Reject: /tasks reject ${displayId} <feedback>`,
    );
  }
  return lines.join("\n");
}

async function runOwnerTaskCommand(
  params: HandleCommandsParams,
  args: string,
): Promise<ReplyPayload> {
  const [sub, taskId, ...rest] = args.split(/\s+/).filter(Boolean);
  if (sub !== "review" && sub !== "accept" && sub !== "reject" && sub !== "cancel") {
    return { text: "Usage: /tasks" };
  }
  if (!ownerTasksEnabled(params.cfg)) {
    return { text: "Owner tasks are disabled (tasks.enabled=false)." };
  }
  if (!params.command.senderIsOwner) {
    return { text: "Only the owner can use task review commands." };
  }
  const scope = resolveOwnerTaskScope(params);
  if (!scope) {
    return { text: "No owner identity for this session; task command unavailable." };
  }

  if (sub === "review") {
    if (!taskId) {
      return { text: "Usage: /tasks review <taskId>" };
    }
    const task = await getOwnerTask(scope, taskId);
    return {
      text: task ? buildOwnerTaskDetailText(task) : `Task ${taskId} not found.`,
    };
  }

  if (sub === "accept") {
    if (!taskId) {
      return { text: "Usage: /tasks accept <taskId>" };
    }
    const task = await getOwnerTask(scope, taskId);
    if (!task) {
      return { text: `Task ${taskId} not found.` };
    }
    if (task.status !== "needs_review") {
      return { text: `Task ${taskId} is ${task.status}; only needs_review tasks can be accepted.` };
    }
    const result = await acceptOwnerTask({
      cfg: params.cfg,
      scope,
      taskId,
      expectedResultVersion: task.resultVersion,
    });
    return {
      text: result.ok
        ? `Accepted [${result.task.taskId}] ${result.task.title}. Status: done.`
        : `Accept failed: ${result.code} — ${result.message}`,
    };
  }

  if (sub === "reject") {
    const feedback = rest.join(" ").trim();
    if (!taskId || !feedback) {
      return { text: "Usage: /tasks reject <taskId> <feedback>" };
    }
    const result = await rejectOwnerTask({
      cfg: params.cfg,
      scope,
      taskId,
      feedback,
      callGateway,
    });
    if (!result.ok) {
      return { text: `Reject failed: ${result.code} — ${result.message}` };
    }
    if (result.task.status === "failed") {
      return { text: `Rejected [${taskId}] and marked failed: ${result.task.error}` };
    }
    return {
      text:
        result.dispatch === "sent"
          ? `Rejected [${taskId}]; worker re-invoked (attempt ${result.task.attemptCount}).`
          : `Rejected [${taskId}] (attempt ${result.task.attemptCount}), but the worker could not be re-invoked.`,
    };
  }

  if (sub === "cancel") {
    if (!taskId) {
      return { text: "Usage: /tasks cancel <taskId>" };
    }
    const result = await cancelOwnerTask({ scope, taskId });
    return {
      text: result.ok
        ? `Cancelled [${taskId}].`
        : `Cancel failed: ${result.code} — ${result.message}`,
    };
  }

  return {
    text: "Usage: /tasks | /tasks review <taskId> | /tasks accept <taskId> | /tasks reject <taskId> <feedback> | /tasks cancel <taskId>",
  };
}

export const handleTasksCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/tasks" && !normalized.startsWith("/tasks ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /tasks from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const args = normalized.slice("/tasks".length).trim();
  if (args) {
    return {
      shouldContinue: false,
      reply: await runOwnerTaskCommand(params, args),
    };
  }
  if (ownerTasksEnabled(params.cfg)) {
    const scope = resolveOwnerTaskScope(params);
    if (scope) {
      const tasks = await listOwnerTasks(scope);
      return {
        shouldContinue: false,
        reply: { text: buildOwnerTasksText(tasks) },
      };
    }
  }
  return {
    shouldContinue: false,
    reply: await buildTasksReply(params),
  };
};
