import { loadSubagentRegistryFromDisk } from "../agents/subagent-registry.store.js";
import type { AllBotConfig } from "../config/config.js";
import { loadConfig } from "../config/io.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import type { OutboundChannel } from "../infra/outbound/targets.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { archiveOwnerTasks } from "../tasks/owner/archive.js";
import { reconcileOwnerTasks } from "../tasks/owner/reconcile.js";
import { createOwnerTaskStore } from "../tasks/owner/store.js";
import type { OwnerTaskRecord } from "../tasks/owner/types.js";
import { runWatchLoopTick } from "../tasks/owner/watch-loop.js";

const log = createSubsystemLogger("gateway-watchdog");

const TICK_MS = 60_000;
const ARCHIVE_EVERY_TICKS = 60;
let tickCount = 0;

function isWorkerAlive(task: {
  worker: { kind: string; runId?: string; cronJobId?: string; childSessionKey: string };
}): boolean {
  if (task.worker.kind === "cron") {
    return isCronJobActive(task.worker.cronJobId ?? "");
  }
  const runs = loadSubagentRegistryFromDisk();
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
}

async function runOnce(cfg: AllBotConfig): Promise<void> {
  tickCount += 1;
  try {
    const reconciliation = await reconcileOwnerTasks({
      store: createOwnerTaskStore(),
      isWorkerAlive,
    });
    if (reconciliation.orphanedTaskIds.length > 0) {
      log.warn("reconciled orphaned owner tasks", {
        count: reconciliation.orphanedTaskIds.length,
      });
    }
  } catch (error) {
    log.warn("owner task reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await runWatchLoopTick({
      cfg,
      enqueueSystemEvent: (text, opts) => {
        enqueueSystemEvent(text, opts);
      },
    });
    if (result.changed.length > 0 || result.failed.length > 0) {
      log.info("watch loop tick", {
        checked: result.checked,
        changed: result.changed,
        failed: result.failed,
      });
    }
  } catch (error) {
    log.warn("watch loop tick failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (tickCount === 1 || tickCount % ARCHIVE_EVERY_TICKS === 0) {
    try {
      const result = await archiveOwnerTasks({ cfg });
      if (result.archived > 0) {
        log.info("owner task archive sweep", {
          archived: result.archived,
          kept: result.kept,
        });
      }
    } catch (error) {
      log.warn("owner task archive failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * On gateway start, tell the owner which results are still waiting for review.
 * Without this a restart silently drops the review prompt and the task sits in
 * needs_review until the owner happens to open the list.
 */
async function remindPendingReviews(cfg: AllBotConfig): Promise<boolean> {
  let tasks: OwnerTaskRecord[];
  try {
    tasks = (await createOwnerTaskStore().read()).tasks.filter(
      (task) => task.status === "needs_review",
    );
  } catch (error) {
    log.warn("pending review scan failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (tasks.length === 0) {
    return true;
  }
  const groups = new Map<string, { channel: string; to: string; tasks: OwnerTaskRecord[] }>();
  for (const task of tasks) {
    const target = task.source?.replyTo;
    if (!target?.channel || !target.to) {
      continue;
    }
    const key = `${target.channel}:${target.to}`;
    const group = groups.get(key) ?? { channel: target.channel, to: target.to, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  let allSent = true;
  for (const group of groups.values()) {
    const lines = group.tasks.map((task) => `- ${task.title}（${task.shortId}）`);
    const text = [
      `有 ${group.tasks.length} 个任务等你验收：`,
      ...lines,
      "",
      "回复 /tasks accept <编号> 通过，或 /tasks reject <编号> <原因> 打回。",
    ].join("\n");
    try {
      const results = await deliverOutboundPayloads({
        cfg,
        channel: group.channel as Exclude<OutboundChannel, "none">,
        to: group.to,
        payloads: [{ text }],
        bestEffort: true,
      });
      if (results.length === 0) {
        throw new Error("outbound delivery returned no results");
      }
      log.info("pending review reminder sent", {
        channel: group.channel,
        count: group.tasks.length,
        delivered: results.length,
      });
    } catch (error) {
      allSent = false;
      log.warn("pending review reminder failed", {
        channel: group.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return allSent;
}

/**
 * Starts a low-cost, always-on maintenance loop:
 * - sweeps orphaned tasks on startup and every minute
 * - archives closed tasks once an hour
 * - polls configured watch URLs and wakes the Router only on change
 * No model call happens on an unchanged tick.
 */
export function startOwnerTaskWatchdog(cfg: AllBotConfig = loadConfig()): void {
  void runOnce(cfg);
  // Channels connect a few seconds after the gateway goes ready; give them room
  // before re-announcing the review queue.
  const remind = (delayMs: number) => {
    const timer = setTimeout(() => {
      void remindPendingReviews(cfg).then((ok) => {
        if (!ok) {
          remind(60_000);
        }
      });
    }, delayMs);
    timer.unref?.();
  };
  remind(20_000);
  const timer = setInterval(() => void runOnce(cfg), TICK_MS);
  timer.unref?.();
  log.info("owner task watchdog started", { intervalMs: TICK_MS });
}
