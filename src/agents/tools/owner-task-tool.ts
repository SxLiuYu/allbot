import { Type } from "typebox";
import { resolveCorrectionUserId } from "../../cognitive/correction/userid.js";
import type { AllBotConfig } from "../../config/config.js";
import { isCronJobActive } from "../../cron/active-jobs.js";
import { callGateway } from "../../gateway/call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  acceptOwnerTask,
  cancelOwnerTask,
  getOwnerTask,
  listOwnerTasks,
  rejectOwnerTask,
} from "../../tasks/owner/actions.js";
import { ownerTasksEnabled } from "../../tasks/owner/config.js";
import { reconcileOwnerTasks } from "../../tasks/owner/reconcile.js";
import { createOwnerTaskStore } from "../../tasks/owner/store.js";
import { buildOwnerTaskSummarySection } from "../../tasks/owner/summary.js";
import type { OwnerTaskRecord } from "../../tasks/owner/types.js";
import { loadSubagentRegistryFromDisk } from "../subagent-registry.store.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, textResult } from "./common.js";

const log = createSubsystemLogger("owner-task-tool");

const TaskListSchema = Type.Object({
  includeClosed: Type.Optional(
    Type.Boolean({ description: "Include done/failed/cancelled tasks (default false)." }),
  ),
});

const TaskGetSchema = Type.Object({
  taskId: Type.String({ description: "Owner task id" }),
});

const TaskAcceptSchema = Type.Object({
  taskId: Type.String({ description: "Owner task id" }),
  resultVersion: Type.Number({
    description: "The resultVersion the user reviewed (from task_get). Rejects stale versions.",
  }),
});

const TaskRejectSchema = Type.Object({
  taskId: Type.String({ description: "Owner task id" }),
  feedback: Type.String({ description: "What the user wants changed" }),
});

const TaskCancelSchema = Type.Object({
  taskId: Type.String({ description: "Owner task id" }),
});

type OwnerTaskToolDeps = {
  config?: AllBotConfig;
  sessionKey?: string;
  deliveryTo?: string;
  callGateway?: typeof callGateway;
};

function resolveOwnerId(deps: OwnerTaskToolDeps): string | undefined {
  return resolveCorrectionUserId(deps.sessionKey, deps.deliveryTo) ?? undefined;
}

function summarizeTask(task: OwnerTaskRecord) {
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    attemptCount: task.attemptCount,
    resultVersion: task.resultVersion,
    updatedAt: task.updatedAt,
    ...(task.status === "needs_review" ? { resultPreview: task.resultText?.slice(0, 200) } : {}),
  };
}

function disabled(): ReturnType<typeof textResult> {
  return textResult("Owner tasks are disabled (tasks.enabled=false).", { status: "disabled" });
}

/**
 * Opportunistic orphan sweep: long-running in_progress tasks whose worker is
 * gone are failed instead of staying stuck. Cheap enough to run on task_list.
 */
async function reconcileBeforeList(): Promise<void> {
  const store = createOwnerTaskStore();
  const runs = loadSubagentRegistryFromDisk();
  await reconcileOwnerTasks({
    store,
    isWorkerAlive: (task) => {
      if (task.worker.kind === "cron") {
        return isCronJobActive(task.worker.cronJobId ?? "");
      }
      if (task.worker.runId) {
        const run = runs.get(task.worker.runId);
        if (run) {
          return typeof run.endedAt !== "number";
        }
      }
      for (const run of runs.values()) {
        if (run.childSessionKey === task.worker.childSessionKey) {
          return typeof run.endedAt !== "number";
        }
      }
      return false;
    },
  });
}

export function createOwnerTaskListTool(deps: OwnerTaskToolDeps = {}): AnyAgentTool {
  return {
    name: "task_list",
    label: "List Tasks",
    description:
      "List the current user's owner tasks (in progress, awaiting review, and optionally closed). Use for task status questions.",
    parameters: TaskListSchema,
    async execute(_toolCallId: string, rawParams: unknown) {
      if (!ownerTasksEnabled(deps.config)) {
        return disabled();
      }
      const ownerId = resolveOwnerId(deps);
      if (!ownerId) {
        return textResult("No user session; task list unavailable.", { status: "no_session" });
      }
      const params = (rawParams ?? {}) as { includeClosed?: boolean };
      try {
        await reconcileBeforeList();
      } catch {
        // Orphan sweep is best-effort; never block listing.
      }
      const tasks = await listOwnerTasks(
        { ownerId, sessionKey: deps.sessionKey },
        { includeClosed: params.includeClosed === true },
      );
      return jsonResult({
        status: "ok",
        count: tasks.length,
        tasks: tasks.map(summarizeTask),
        summary: buildOwnerTaskSummarySection(tasks),
      });
    },
  };
}

export function createOwnerTaskGetTool(deps: OwnerTaskToolDeps = {}): AnyAgentTool {
  return {
    name: "task_get",
    label: "Get Task",
    description:
      "Show one owner task, including the full saved result the user must review. Returns resultVersion for task_accept.",
    parameters: TaskGetSchema,
    async execute(_toolCallId: string, rawParams: unknown) {
      if (!ownerTasksEnabled(deps.config)) {
        return disabled();
      }
      const ownerId = resolveOwnerId(deps);
      if (!ownerId) {
        return textResult("No user session.", { status: "no_session" });
      }
      const params = rawParams as { taskId: string };
      const task = await getOwnerTask({ ownerId, sessionKey: deps.sessionKey }, params.taskId);
      return task
        ? jsonResult({ status: "ok", task })
        : jsonResult({ status: "not_found", taskId: params.taskId });
    },
  };
}

export function createOwnerTaskAcceptTool(deps: OwnerTaskToolDeps = {}): AnyAgentTool {
  return {
    name: "task_accept",
    label: "Accept Task",
    description:
      "Accept a task result after the user explicitly approves it. Requires the resultVersion the user reviewed; stale versions are refused.",
    parameters: TaskAcceptSchema,
    async execute(_toolCallId: string, rawParams: unknown) {
      if (!ownerTasksEnabled(deps.config)) {
        return disabled();
      }
      const ownerId = resolveOwnerId(deps);
      if (!ownerId) {
        return textResult("no owner identity for this session", {
          status: "no_owner_identity",
        });
      }
      const params = rawParams as { taskId: string; resultVersion: number };
      const result = await acceptOwnerTask({
        cfg: deps.config,
        scope: { ownerId, sessionKey: deps.sessionKey },
        taskId: params.taskId,
        expectedResultVersion: params.resultVersion,
      });
      if (!result.ok) {
        return jsonResult({
          status: result.code,
          taskId: params.taskId,
          message: result.message,
        });
      }
      log.info("owner task accepted", { taskId: params.taskId, ownerId });
      return jsonResult({ status: "done", task: summarizeTask(result.task) });
    },
  };
}

export function createOwnerTaskRejectTool(deps: OwnerTaskToolDeps = {}): AnyAgentTool {
  return {
    name: "task_reject",
    label: "Reject Task",
    description:
      "Send a task result back to its worker with user feedback. The worker is re-invoked in its own session; attemptCount increases and the task fails after the configured limit.",
    parameters: TaskRejectSchema,
    async execute(_toolCallId: string, rawParams: unknown) {
      if (!ownerTasksEnabled(deps.config)) {
        return disabled();
      }
      const ownerId = resolveOwnerId(deps);
      if (!ownerId) {
        return textResult("no owner identity for this session", {
          status: "no_owner_identity",
        });
      }
      const params = rawParams as { taskId: string; feedback: string };
      const result = await rejectOwnerTask({
        cfg: deps.config,
        scope: { ownerId, sessionKey: deps.sessionKey },
        taskId: params.taskId,
        feedback: params.feedback,
        callGateway: deps.callGateway ?? callGateway,
      });
      if (!result.ok) {
        return jsonResult({
          status: result.code,
          taskId: params.taskId,
          message: result.message,
        });
      }
      if (result.task.status === "failed") {
        return jsonResult({
          status: "failed",
          taskId: params.taskId,
          message: result.task.error,
        });
      }
      return jsonResult({
        status: "in_progress",
        taskId: params.taskId,
        attemptCount: result.task.attemptCount,
        dispatch: result.dispatch,
        ...(result.dispatch === "failed"
          ? {
              message: "Task moved back to in_progress, but the worker could not be re-invoked.",
            }
          : {}),
      });
    },
  };
}

export function createOwnerTaskCancelTool(deps: OwnerTaskToolDeps = {}): AnyAgentTool {
  return {
    name: "task_cancel",
    label: "Cancel Task",
    description: "Cancel a pending, in-progress, or awaiting-review owner task.",
    parameters: TaskCancelSchema,
    async execute(_toolCallId: string, rawParams: unknown) {
      if (!ownerTasksEnabled(deps.config)) {
        return disabled();
      }
      const ownerId = resolveOwnerId(deps);
      if (!ownerId) {
        return textResult("no owner identity for this session", {
          status: "no_owner_identity",
        });
      }
      const params = rawParams as { taskId: string };
      const result = await cancelOwnerTask({
        scope: { ownerId, sessionKey: deps.sessionKey },
        taskId: params.taskId,
      });
      if (!result.ok) {
        return jsonResult({
          status: result.code,
          taskId: params.taskId,
          message: result.message,
        });
      }
      return jsonResult({ status: "cancelled", task: summarizeTask(result.task) });
    },
  };
}
