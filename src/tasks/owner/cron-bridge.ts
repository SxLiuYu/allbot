import type { AllBotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { ownerTasksEnabled } from "./config.js";
import { createOwnerTaskStore, type OwnerTaskStore } from "./store.js";
import {
  AUTO_ACCEPT_ACTOR,
  createOwnerTask,
  transitionOwnerTask,
  updateOwnerTaskResult,
} from "./transition.js";
import type { OwnerTaskRecord } from "./types.js";

export type CronRunProjectionStatus = "ok" | "error" | "skipped";

export type CronRunProjectionInput = {
  jobId: string;
  jobName?: string;
  runId?: string;
  /** Session the job targets; used to scope the task to the owner's Router session. */
  sessionKey?: string;
  status: CronRunProjectionStatus;
  summary?: string;
  outputText?: string;
  replyTo?: DeliveryContext;
  /** Only honored when the job explicitly sets `autoAccept: true`. */
  autoAccept?: boolean;
  ownerId?: string;
  now?: number;
  store?: OwnerTaskStore;
  cfg?: AllBotConfig;
};

export type CronRunProjectionResult = {
  synced: boolean;
  taskId?: string;
  reviewRequired: boolean;
};

const NOOP: CronRunProjectionResult = { synced: false, reviewRequired: false };
const log = createSubsystemLogger("owner-task-cron");

function findActiveCronTask(
  tasks: readonly OwnerTaskRecord[],
  jobId: string,
): OwnerTaskRecord | undefined {
  return tasks
    .toReversed()
    .find(
      (task) =>
        task.worker.cronJobId === jobId &&
        (task.status === "pending" ||
          task.status === "in_progress" ||
          task.status === "needs_review" ||
          task.status === "failed"),
    );
}

/**
 * Projects a finished cron run onto one owner task per job (not per run), so
 * recurring monitoring jobs do not flood the Router session with review cards.
 * Jobs only close themselves when `autoAccept === true`; otherwise the task
 * stops at needs_review.
 */
export async function syncOwnerTaskFromCronRun(
  input: CronRunProjectionInput,
): Promise<CronRunProjectionResult> {
  try {
    if (input.status === "skipped") {
      return NOOP;
    }
    const cfg = input.cfg ?? loadConfig();
    if (!ownerTasksEnabled(cfg)) {
      return NOOP;
    }

    const store = input.store ?? createOwnerTaskStore();
    const data = await store.read();
    const resultText = (input.summary ?? input.outputText ?? "").trim();
    // An auto-accepted job closes its card immediately, so no active card is
    // left to reuse. Compare against the most recent card of any status before
    // creating a new one, or every schedule tick grows another done task.
    if (input.autoAccept === true && input.status === "ok") {
      const last = data.tasks
        .toReversed()
        .find((task) => task.worker.cronJobId === input.jobId);
      if (last && (last.resultText ?? "").trim() === resultText) {
        return { synced: true, reviewRequired: false, taskId: last.taskId };
      }
    }
    const existing = findActiveCronTask(data.tasks, input.jobId);
    if (existing?.status === "needs_review") {
      // Recurring checks often return the same text (e.g. HEARTBEAT_OK) every
      // run. Do not bump resultVersion or rewrite the store for an unchanged
      // result, or one unattended card grows a write per schedule tick.
      if ((existing.resultText ?? "").trim() === resultText) {
        // An unattended job that just gained autoAccept should still close its
        // old review card, even when the result text did not change.
        if (input.autoAccept === true && existing.source.autoAccept !== true) {
          await transitionOwnerTask({
            store,
            taskId: existing.taskId,
            to: "done",
            actor: AUTO_ACCEPT_ACTOR,
            expectedResultVersion: existing.resultVersion,
            now: input.now,
          });
        }
        return { synced: true, reviewRequired: false, taskId: existing.taskId };
      }
      const updated = await updateOwnerTaskResult({
        store,
        taskId: existing.taskId,
        actor: "worker:cron",
        resultText,
        now: input.now,
      });
      if (!updated.ok) {
        return NOOP;
      }
      // Use the current job's setting, not the flag frozen when the card was
      // first created, so enabling autoAccept on a live job takes effect.
      if (input.autoAccept === true) {
        await transitionOwnerTask({
          store,
          taskId: existing.taskId,
          to: "done",
          actor: AUTO_ACCEPT_ACTOR,
          expectedResultVersion: updated.task.resultVersion,
          now: input.now,
        });
      }
      return { synced: true, reviewRequired: false, taskId: existing.taskId };
    }
    if (existing?.status === "failed") {
      await transitionOwnerTask({
        store,
        taskId: existing.taskId,
        to: "in_progress",
        actor: "worker:cron",
        now: input.now,
      });
    }

    const routerSessionKey = input.sessionKey?.trim() || "agent:main:main";
    let task: OwnerTaskRecord;
    if (existing) {
      task = existing;
    } else {
      task = await createOwnerTask({
        store,
        ownerId: input.ownerId ?? "system:cron",
        routerSessionKey,
        title: input.jobName?.trim() || `Cron ${input.jobId}`,
        goal: `Scheduled job ${input.jobId}`,
        source: {
          kind: "cron",
          autoAccept: input.autoAccept === true,
          ...(input.replyTo?.channel ? { channel: input.replyTo.channel } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        },
        worker: {
          kind: "cron",
          cronJobId: input.jobId,
          ...(input.runId ? { runId: input.runId } : {}),
          childSessionKey: input.sessionKey?.trim() || `cron:${input.jobId}`,
        },
        now: input.now,
        actor: "cron",
      });
    }

    if (input.status === "error") {
      const failed = await transitionOwnerTask({
        store,
        taskId: task.taskId,
        to: "failed",
        actor: "worker:cron",
        note: "Cron run failed before producing a result.",
        now: input.now,
      });
      return failed.ok ? { synced: true, reviewRequired: false, taskId: task.taskId } : NOOP;
    }

    const review = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker:cron",
      resultText,
      now: input.now,
    });
    if (!review.ok) {
      return NOOP;
    }

    if (input.autoAccept === true) {
      const accepted = await transitionOwnerTask({
        store,
        taskId: task.taskId,
        to: "done",
        actor: AUTO_ACCEPT_ACTOR,
        expectedResultVersion: review.task.resultVersion,
        now: input.now,
      });
      if (accepted.ok) {
        return { synced: true, reviewRequired: false, taskId: task.taskId };
      }
    }

    log.info("owner task cron run projected", {
      jobId: input.jobId,
      runId: input.runId,
      status: input.status,
      taskId: task.taskId,
      reviewRequired: true,
    });
    return { synced: true, reviewRequired: true, taskId: task.taskId };
  } catch (error) {
    log.warn("owner task cron projection failed", {
      jobId: input.jobId,
      runId: input.runId,
      status: input.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOOP;
  }
}
