import type { OwnerTaskStore } from "./store.js";
import { createOwnerTask, transitionOwnerTask } from "./transition.js";
import type { OwnerTaskStoreData } from "./types.js";

export type HistoricalSubagentRun = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  createdAt?: number;
  endedAt?: number;
  outcomeStatus?: "ok" | "error" | "timeout" | "unknown";
  resultText?: string | null;
};

export type ImportHistoricalResult = {
  imported: number;
  skipped: number;
  taskIds: string[];
};

/**
 * Read-only import of terminal subagent runs into owner tasks. Never sends
 * notifications and never rewrites the subagent runs file. Runs without a
 * terminal timestamp are skipped (still in flight).
 */
export async function importHistoricalSubagentRuns(params: {
  store: OwnerTaskStore;
  runs: readonly HistoricalSubagentRun[];
  ownerId?: string;
  now?: number;
}): Promise<ImportHistoricalResult> {
  const existing = await params.store.read();
  const knownRunIds = new Set(
    existing.tasks.map((task) => task.worker.runId).filter((id): id is string => Boolean(id)),
  );

  let imported = 0;
  let skipped = 0;
  const taskIds: string[] = [];

  for (const run of params.runs) {
    if (
      typeof run.endedAt !== "number" ||
      !run.runId.trim() ||
      !run.requesterSessionKey.trim() ||
      knownRunIds.has(run.runId)
    ) {
      skipped += 1;
      continue;
    }
    const endedAt = run.endedAt;
    const task = await createOwnerTask({
      store: params.store,
      ownerId: params.ownerId ?? "imported",
      routerSessionKey: run.requesterSessionKey,
      title: run.task.slice(0, 120) || run.runId,
      goal: run.task,
      source: { kind: "user" },
      worker: {
        kind: "subagent",
        runId: run.runId,
        childSessionKey: run.childSessionKey,
      },
      now: run.createdAt ?? endedAt,
      actor: "import",
    });

    if (run.outcomeStatus === "ok" || run.outcomeStatus === undefined) {
      const review = await transitionOwnerTask({
        store: params.store,
        taskId: task.taskId,
        to: "needs_review",
        actor: "import",
        resultText: run.resultText ?? "",
        now: endedAt,
      });
      if (review.ok) {
        await transitionOwnerTask({
          store: params.store,
          taskId: task.taskId,
          to: "done",
          actor: "system:import",
          expectedResultVersion: review.task.resultVersion,
          now: endedAt,
        });
      }
    } else {
      await transitionOwnerTask({
        store: params.store,
        taskId: task.taskId,
        to: "failed",
        actor: "import",
        note: `Historical ${run.outcomeStatus} run.`,
        now: endedAt,
      });
    }

    imported += 1;
    taskIds.push(task.taskId);
    knownRunIds.add(run.runId);
  }

  return { imported, skipped, taskIds };
}

export function countImportedTasks(data: OwnerTaskStoreData): number {
  return data.tasks.filter((task) => task.events.some((event) => event.actor === "import")).length;
}
