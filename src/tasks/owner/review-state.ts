import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createOwnerTaskStore, type OwnerTaskStore } from "./store.js";
import { findOwnerTaskByWorker } from "./transition.js";

const log = createSubsystemLogger("owner-task-review");

export type ResolveOwnerTaskReviewRequiredInput = {
  runId: string;
  childSessionKey: string;
  store?: OwnerTaskStore;
};

/**
 * True only when an owner task is waiting for user review. Used by both the
 * first announce and retry/resume announces so their wording cannot diverge.
 */
export async function resolveOwnerTaskReviewRequired(
  input: ResolveOwnerTaskReviewRequiredInput,
): Promise<boolean> {
  try {
    const store = input.store ?? createOwnerTaskStore();
    const data = await store.read();
    const task = findOwnerTaskByWorker(data, {
      runId: input.runId,
      childSessionKey: input.childSessionKey,
    });
    return task?.status === "needs_review";
  } catch (error) {
    log.debug("owner task review lookup failed", {
      runId: input.runId,
      childSessionKey: input.childSessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
