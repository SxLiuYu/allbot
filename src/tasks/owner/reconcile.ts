import type { OwnerTaskStore } from "./store.js";
import { transitionOwnerTask } from "./transition.js";
import type { OwnerTaskRecord } from "./types.js";

export type ReconcileOwnerTasksInput = {
  store: OwnerTaskStore;
  /**
   * Whether the worker run behind a task is still alive. Injected so this
   * module does not depend on the subagent registry or cron service.
   */
  isWorkerAlive: (task: OwnerTaskRecord) => boolean | Promise<boolean>;
  /** A task must be untouched this long before it is considered orphaned. */
  staleMs?: number;
  now?: number;
  actor?: string;
};

export type ReconcileOwnerTasksResult = {
  orphanedTaskIds: string[];
};

export const DEFAULT_OWNER_TASK_STALE_MS = 30 * 60_000;

/**
 * Fails `in_progress` tasks whose worker disappeared, so a crashed process
 * cannot leave a task stuck forever. Called from gateway startup / periodic
 * maintenance; never touches `needs_review` tasks. Status changes still go
 * through `transitionOwnerTask`.
 */
export async function reconcileOwnerTasks(
  input: ReconcileOwnerTasksInput,
): Promise<ReconcileOwnerTasksResult> {
  const now = input.now ?? Date.now();
  const staleMs = input.staleMs ?? DEFAULT_OWNER_TASK_STALE_MS;
  const data = await input.store.read();
  const candidates = data.tasks.filter(
    (task) => task.status === "in_progress" && now - task.updatedAt >= staleMs,
  );

  const orphanedTaskIds: string[] = [];
  for (const task of candidates) {
    const alive = await input.isWorkerAlive(task);
    if (alive) {
      continue;
    }
    const result = await transitionOwnerTask({
      store: input.store,
      taskId: task.taskId,
      to: "failed",
      actor: input.actor ?? "system:reconcile",
      note: "Worker disappeared before reporting a result.",
      now,
    });
    if (result.ok) {
      orphanedTaskIds.push(task.taskId);
    }
  }

  return { orphanedTaskIds };
}
