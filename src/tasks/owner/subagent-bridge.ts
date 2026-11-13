import type { AllBotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createConfiguredOwnerTaskSyncAdapter } from "../sync/adapter.js";
import { ownerTasksEnabled } from "./config.js";
import { createOwnerTaskStore, type OwnerTaskStore } from "./store.js";
import { findOwnerTaskByWorker, transitionOwnerTask } from "./transition.js";
import type { OwnerTaskArtifact } from "./types.js";

export type SubagentWorkerOutcomeStatus = "ok" | "error" | "timeout" | "unknown";

export type SubagentCompletionSyncInput = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  outcomeStatus: SubagentWorkerOutcomeStatus;
  /** Frozen completion text; copied into the task, never referenced later. */
  resultText?: string | null;
  artifacts?: OwnerTaskArtifact[];
  now?: number;
  store?: OwnerTaskStore;
  cfg?: AllBotConfig;
};

export type SubagentCompletionSyncResult = {
  synced: boolean;
  reviewRequired: boolean;
  taskId?: string;
};

const EMPTY_RESULT: SubagentCompletionSyncResult = { synced: false, reviewRequired: false };
const log = createSubsystemLogger("owner-task-sync");

/**
 * Copies a finished subagent run into its owner task:
 *   ok            -> needs_review (result copied, version bumped)
 *   error/timeout -> failed
 *
 * Returns `reviewRequired` so the announce prompt can ask the user to review
 * instead of claiming the work is finished. Never throws: completion
 * bookkeeping must not break announce delivery.
 */
export async function syncOwnerTaskFromSubagentCompletion(
  input: SubagentCompletionSyncInput,
): Promise<SubagentCompletionSyncResult> {
  try {
    const cfg = input.cfg ?? loadConfig();
    if (!ownerTasksEnabled(cfg)) {
      return EMPTY_RESULT;
    }
    const store = input.store ?? createOwnerTaskStore();
    const data = await store.read();
    const task = findOwnerTaskByWorker(data, {
      runId: input.runId,
      childSessionKey: input.childSessionKey,
    });
    if (!task || task.status !== "in_progress") {
      log.debug("owner task sync skipped: no active task for run", {
        runId: input.runId,
        childSessionKey: input.childSessionKey,
        status: task?.status ?? "not_found",
      });
      return EMPTY_RESULT;
    }

    if (input.outcomeStatus === "ok") {
      const result = await transitionOwnerTask({
        store,
        taskId: task.taskId,
        to: "needs_review",
        actor: "worker:subagent",
        resultText: input.resultText ?? "",
        artifacts: input.artifacts,
        now: input.now,
      });
      if (result.ok && cfg.tasks?.sync?.enabled) {
        // Optional outbound sync never changes the local review decision.
        const adapter = createConfiguredOwnerTaskSyncAdapter(cfg, { store });
        if (adapter) {
          void adapter.project(result.task);
        }
      }
      return result.ok ? { synced: true, reviewRequired: true, taskId: task.taskId } : EMPTY_RESULT;
    }

    const result = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "failed",
      actor: "worker:subagent",
      note:
        input.outcomeStatus === "timeout"
          ? "Worker timed out before producing a result."
          : "Worker failed before producing a result.",
      now: input.now,
    });
    return result.ok ? { synced: true, reviewRequired: false, taskId: task.taskId } : EMPTY_RESULT;
  } catch (error) {
    log.warn("owner task sync failed", {
      runId: input.runId,
      childSessionKey: input.childSessionKey,
      outcomeStatus: input.outcomeStatus,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_RESULT;
  }
}
