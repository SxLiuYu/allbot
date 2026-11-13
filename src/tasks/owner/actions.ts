import type { AllBotConfig } from "../../config/config.js";
import type { callGateway } from "../../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveOwnerTasksConfig } from "./config.js";
import { createOwnerTaskStore } from "./store.js";
import { transitionOwnerTask } from "./transition.js";
import type { OwnerTaskRecord } from "./types.js";

export type OwnerTaskScope = {
  ownerId: string;
  /** The Router session that owns the task. */
  sessionKey?: string;
};

export type OwnerTaskActionResult =
  | { ok: true; task: OwnerTaskRecord }
  | { ok: false; code: string; message: string; task?: OwnerTaskRecord };

export type OwnerTaskRejectResult =
  | { ok: true; task: OwnerTaskRecord; dispatch: "sent" | "failed" }
  | { ok: false; code: string; message: string; task?: OwnerTaskRecord };

/**
 * Sync-projected tasks have no live subagent session to re-invoke; the gateway
 * registers a handler here that re-runs them through the node instead.
 */
let redispatchHandler: ((task: OwnerTaskRecord) => Promise<boolean>) | null = null;

export function setOwnerTaskRedispatchHandler(
  handler: ((task: OwnerTaskRecord) => Promise<boolean>) | null,
): void {
  redispatchHandler = handler;
}

function isProjectedWorker(task: OwnerTaskRecord): boolean {
  return (
    task.worker.childSessionKey.startsWith("sync:") ||
    task.execution?.environment === "cloud" ||
    task.execution?.environment === "device"
  );
}

export function isOwnerTaskVisible(task: OwnerTaskRecord, scope: OwnerTaskScope): boolean {
  return (
    task.ownerId === scope.ownerId ||
    (scope.sessionKey !== undefined && task.routerSessionKey === scope.sessionKey)
  );
}

export async function listOwnerTasks(
  scope: OwnerTaskScope,
  params: { includeClosed?: boolean } = {},
): Promise<OwnerTaskRecord[]> {
  const data = await createOwnerTaskStore().read();
  return data.tasks
    .filter((task) => isOwnerTaskVisible(task, scope))
    .filter((task) =>
      params.includeClosed ? true : task.status === "in_progress" || task.status === "needs_review",
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export async function getOwnerTask(
  scope: OwnerTaskScope,
  taskId: string,
): Promise<OwnerTaskRecord | undefined> {
  const data = await createOwnerTaskStore().read();
  const task = data.tasks.find((entry) => entry.taskId === taskId || entry.shortId === taskId);
  return task && isOwnerTaskVisible(task, scope) ? task : undefined;
}

async function findVisibleTask(
  scope: OwnerTaskScope,
  taskId: string,
): Promise<OwnerTaskRecord | undefined> {
  return await getOwnerTask(scope, taskId);
}

export async function acceptOwnerTask(params: {
  cfg?: AllBotConfig;
  scope: OwnerTaskScope;
  taskId: string;
  expectedResultVersion: number;
  actor?: string;
}): Promise<OwnerTaskActionResult> {
  const task = await findVisibleTask(params.scope, params.taskId);
  if (!task) {
    return { ok: false, code: "not_found", message: `Task ${params.taskId} not found.` };
  }
  const result = await transitionOwnerTask({
    store: createOwnerTaskStore(),
    taskId: task.taskId,
    to: "done",
    actor: params.actor ?? `owner:${params.scope.ownerId}`,
    expectedResultVersion: params.expectedResultVersion,
    maxAttempts: resolveOwnerTasksConfig(params.cfg).maxAttempts,
  });
  return result.ok
    ? { ok: true, task: result.task }
    : { ok: false, code: result.code, message: result.message, task: result.task };
}

export async function cancelOwnerTask(params: {
  scope: OwnerTaskScope;
  taskId: string;
  actor?: string;
}): Promise<OwnerTaskActionResult> {
  const task = await findVisibleTask(params.scope, params.taskId);
  if (!task) {
    return { ok: false, code: "not_found", message: `Task ${params.taskId} not found.` };
  }
  const result = await transitionOwnerTask({
    store: createOwnerTaskStore(),
    taskId: task.taskId,
    to: "cancelled",
    actor: params.actor ?? `owner:${params.scope.ownerId}`,
  });
  return result.ok
    ? { ok: true, task: result.task }
    : { ok: false, code: result.code, message: result.message, task: result.task };
}

function buildRejectMessage(task: OwnerTaskRecord, feedback: string): string {
  return [
    "[Task Review] The user rejected the previous result.",
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    `Attempt: ${task.attemptCount}`,
    "",
    "Feedback:",
    feedback.trim(),
    "",
    "Continue working in this session and produce a revised result.",
  ].join("\n");
}

export async function rejectOwnerTask(params: {
  cfg?: AllBotConfig;
  scope: OwnerTaskScope;
  taskId: string;
  feedback: string;
  actor?: string;
  callGateway?: typeof callGateway;
}): Promise<OwnerTaskRejectResult> {
  const task = await findVisibleTask(params.scope, params.taskId);
  if (!task) {
    return { ok: false, code: "not_found", message: `Task ${params.taskId} not found.` };
  }
  const result = await transitionOwnerTask({
    store: createOwnerTaskStore(),
    taskId: task.taskId,
    to: "in_progress",
    actor: params.actor ?? `owner:${params.scope.ownerId}`,
    reviewNote: params.feedback,
    note: params.feedback,
    maxAttempts: resolveOwnerTasksConfig(params.cfg).maxAttempts,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message, task: result.task };
  }
  if (result.task.status !== "in_progress") {
    // Attempt budget exhausted: transition already persisted `failed`.
    return { ok: true, task: result.task, dispatch: "failed" };
  }

  if (isProjectedWorker(result.task)) {
    const handler = redispatchHandler;
    if (handler) {
      try {
        if (await handler(result.task)) {
          return { ok: true, task: result.task, dispatch: "sent" };
        }
      } catch {
        // Fall through: a projected worker that cannot be re-run must not sit
        // in in_progress until the 30-minute orphan sweep.
      }
    }
    const failed = await transitionOwnerTask({
      store: createOwnerTaskStore(),
      taskId: result.task.taskId,
      to: "failed",
      actor: `owner:${params.scope.ownerId}`,
      note: "该任务由云端/手机执行，打回后无法重新派发。",
    });
    return {
      ok: true,
      task: failed.ok ? failed.task : result.task,
      dispatch: "failed",
    };
  }

  const call = params.callGateway;
  if (!call) {
    return { ok: true, task: result.task, dispatch: "failed" };
  }
  try {
    await call({
      method: "agent",
      params: {
        sessionKey: result.task.worker.childSessionKey,
        message: buildRejectMessage(result.task, params.feedback),
        deliver: false,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: result.task.routerSessionKey,
          sourceChannel: INTERNAL_MESSAGE_CHANNEL,
          sourceTool: "task_reject",
        },
        idempotencyKey: `owner-task-reject:${result.task.taskId}:${result.task.revision}`,
      },
      timeoutMs: 120_000,
    });
  } catch {
    return { ok: true, task: result.task, dispatch: "failed" };
  }
  return { ok: true, task: result.task, dispatch: "sent" };
}
