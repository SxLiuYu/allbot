import { resolveCorrectionUserId } from "../../cognitive/correction/userid.js";
import type { AllBotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getSubagentDepth, isCronSessionKey } from "../../sessions/session-key-utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { resolveOwnerTasksConfig } from "./config.js";
import { createOwnerTaskStore, type OwnerTaskStore } from "./store.js";
import { createOwnerTask } from "./transition.js";
import type { OwnerTaskRecord } from "./types.js";

const log = createSubsystemLogger("owner-task-spawn");

export type CreateOwnerTaskForSubagentSpawnInput = {
  childRunId: string;
  childSessionKey: string;
  requesterInternalKey: string;
  agentTo?: string;
  task: string;
  label?: string;
  requesterOrigin?: DeliveryContext;
  cfg?: AllBotConfig;
  store?: OwnerTaskStore;
  now?: number;
};

const TITLE_MAX = 72;

function truncateTitle(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > TITLE_MAX ? collapsed.slice(0, TITLE_MAX) : collapsed;
}

/**
 * Creates the authoritative OwnerTask after a subagent run was registered.
 * Best-effort: failures are logged and never break the spawn.
 */
export async function createOwnerTaskForSubagentSpawn(
  input: CreateOwnerTaskForSubagentSpawnInput,
): Promise<OwnerTaskRecord | null> {
  try {
    const cfg = input.cfg ?? loadConfig();
    const config = resolveOwnerTasksConfig(cfg);
    if (!config.enabled) {
      return null;
    }
    if (
      getSubagentDepth(input.requesterInternalKey) > 0 ||
      isCronSessionKey(input.requesterInternalKey)
    ) {
      log.debug("owner task skipped for nested worker", {
        runId: input.childRunId,
        requesterSessionKey: input.requesterInternalKey,
      });
      return null;
    }
    const ownerId = resolveCorrectionUserId(input.requesterInternalKey, input.agentTo);
    if (!ownerId) {
      log.debug("owner task skipped: no owner identity", {
        runId: input.childRunId,
        requesterSessionKey: input.requesterInternalKey,
      });
      return null;
    }

    const store = input.store ?? createOwnerTaskStore();
    const activeCount = (await store.read()).tasks.filter(
      (task) => task.ownerId === ownerId && task.status === "in_progress",
    ).length;
    if (activeCount >= config.maxActive) {
      log.warn("owner task skipped: too many active tasks", {
        runId: input.childRunId,
        ownerId,
        activeCount,
        maxActive: config.maxActive,
      });
      return null;
    }

    const task = await createOwnerTask({
      store,
      ownerId,
      routerSessionKey: input.requesterInternalKey,
      title: truncateTitle(input.label || input.task) || input.childRunId,
      goal: input.task,
      source: {
        kind: "user",
        ...(input.requesterOrigin ? { replyTo: input.requesterOrigin } : {}),
      },
      worker: {
        kind: "subagent",
        runId: input.childRunId,
        childSessionKey: input.childSessionKey,
      },
      status: "in_progress",
      now: input.now,
      actor: "spawn",
    });
    log.info("owner task created for subagent spawn", {
      taskId: task.taskId,
      runId: input.childRunId,
      ownerId,
    });
    return task;
  } catch (error) {
    log.warn("owner task creation failed for subagent spawn", {
      runId: input.childRunId,
      childSessionKey: input.childSessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
