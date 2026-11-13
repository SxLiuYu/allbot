import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AllBotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createOwnerTaskStore, type OwnerTaskStore } from "../owner/store.js";
import { createOwnerTask, transitionOwnerTask } from "../owner/transition.js";
import type { OwnerTaskRecord } from "../owner/types.js";
import type { SyncGatewayClient } from "./client.js";
import { createHttpSyncGatewayClient } from "./client.js";
import { ownerTargetFromSync, syncTaskFromOwner, type SyncTask } from "./types.js";

const log = createSubsystemLogger("owner-task-sync-gateway");

export type NodeInvoker = (params: {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}) => Promise<{
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
}>;

/** OwnerTask remains the local authority; sync is a versioned projection. */
export class OwnerTaskSyncAdapter {
  constructor(
    readonly client: SyncGatewayClient,
    private readonly options: {
      store: OwnerTaskStore;
      deviceId?: string;
      nodeInvoke?: NodeInvoker;
      now?: () => number;
    },
  ) {}

  async project(task: OwnerTaskRecord): Promise<boolean> {
    const remote = syncTaskFromOwner(task);
    try {
      await this.client.createTask(
        remote,
        remote.idempotencyKey ?? `owner-task:${task.taskId}:${task.revision}`,
      );
      return true;
    } catch (error) {
      log.warn("owner task projection failed", {
        taskId: task.taskId,
        revision: task.revision,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async importRemote(remote: SyncTask): Promise<OwnerTaskRecord | null> {
    const execution = ownerTargetFromSync(remote.target, remote.deviceId);
    if (!execution) {
      return null;
    }
    const existing = (await this.options.store.read()).tasks.find(
      (task) => task.taskId === remote.id,
    );
    if (existing) {
      return existing;
    }
    const now = this.options.now?.() ?? Date.now();
    await this.client.appendEvent({
      taskId: remote.id,
      deviceId: this.options.deviceId ?? "mac",
      idempotencyKey: `owner-import:${remote.id}:${remote.version}`,
      type: "status",
      fromVersion: remote.version,
      payload: { status: "running" },
      at: now,
    });
    return await createOwnerTask({
      store: this.options.store,
      taskId: remote.id,
      ownerId: remote.ownerId,
      routerSessionKey: "agent:main:main",
      title: remote.goal.replace(/\s+/g, " ").slice(0, 72),
      goal: remote.goal,
      source: { kind: "user", channel: remote.origin },
      worker: { kind: "subagent", childSessionKey: `sync:${remote.id}` },
      status: "in_progress",
      sensitivity: remote.sensitivity,
      execution,
      now,
      actor: "sync:gateway",
    });
  }

  async dispatchCloud(remote: SyncTask): Promise<boolean> {
    if (remote.target !== "cloud" || !remote.deviceId || !this.options.nodeInvoke) {
      return false;
    }
    const task = await this.importRemote(remote);
    if (!task || task.status !== "in_progress") {
      return false;
    }
    const nodeId = this.options.deviceId ?? remote.deviceId;
    return await this.runOnNode({
      task,
      remote,
      nodeId,
      tag: "dispatch",
      idempotency: `${remote.id}:${remote.version}`,
    });
  }

  /**
   * Re-run a projected task after the owner rejected its result. The worker is
   * the sync gateway, not a live subagent session, so rejecting has to go back
   * through the node instead of re-invoking a child session that has no loop.
   */
  async redispatch(task: OwnerTaskRecord): Promise<boolean> {
    if (!this.options.nodeInvoke) {
      return false;
    }
    const tasks = await this.client.listTasks();
    const remote = tasks.find((entry) => entry.id === task.taskId);
    if (!remote || remote.target !== "cloud") {
      return false;
    }
    const nodeId = this.options.deviceId ?? remote.deviceId;
    if (!nodeId) {
      return false;
    }
    return await this.runOnNode({
      task,
      remote,
      nodeId,
      tag: "redispatch",
      idempotency: `${remote.id}:${remote.version}:r${task.revision}`,
    });
  }

  private async runOnNode(params: {
    task: OwnerTaskRecord;
    remote: SyncTask;
    nodeId: string;
    tag: string;
    idempotency: string;
  }): Promise<boolean> {
    const { task, remote, nodeId, tag, idempotency } = params;
    const nodeInvoke = this.options.nodeInvoke;
    if (!nodeInvoke) {
      return false;
    }
    const prepared = await nodeInvoke({
      nodeId,
      command: "system.run.prepare",
      params: {
        command: argvFromGoal(task.goal || remote.goal),
        agentId: "main",
        sessionKey: task.routerSessionKey,
      },
      idempotencyKey: `sync-prepare:${idempotency}`,
      timeoutMs: 30_000,
    });
    const preparedPayload =
      prepared.payload ?? (prepared.payloadJSON ? JSON.parse(prepared.payloadJSON) : undefined);
    const plan = (
      preparedPayload as { plan?: { argv?: string[]; commandText?: string } } | undefined
    )?.plan;
    let result: Awaited<ReturnType<NodeInvoker>> | null = null;
    if (prepared.ok && plan && Array.isArray(plan.argv)) {
      result = await nodeInvoke({
        nodeId,
        command: "system.run",
        params: {
          command: plan.argv,
          rawCommand: plan.commandText,
          systemRunPlan: plan,
          agentId: "main",
          sessionKey: task.routerSessionKey,
          timeoutMs: 15_000,
        },
        idempotencyKey: `sync-task:${idempotency}`,
        timeoutMs: 30_000,
      });
    }
    const payload = (result?.payload ??
      (result?.payloadJSON ? JSON.parse(result.payloadJSON) : undefined)) as
      | {
          success?: boolean;
          exitCode?: number;
          timedOut?: boolean;
          stdout?: string;
          stderr?: string;
          error?: string;
        }
      | undefined;
    const succeeded =
      result?.ok === true &&
      payload?.success === true &&
      payload.exitCode === 0 &&
      !payload.timedOut;
    const text = JSON.stringify(
      payload ?? result?.error ?? prepared.error ?? { error: "system.run.prepare failed" },
    );
    const local = await transitionOwnerTask({
      store: this.options.store,
      taskId: task.taskId,
      to: succeeded ? "needs_review" : "failed",
      actor: "worker:cloud",
      resultText: text,
      note: succeeded ? "cloud VM execution finished" : text,
    });
    if (!local.ok) {
      return false;
    }
    await this.client.appendEvent({
      taskId: remote.id,
      deviceId: remote.deviceId ?? nodeId,
      idempotencyKey: `sync-${tag}:${idempotency}`,
      type: succeeded ? "result" : "status",
      payload: {
        status: succeeded ? "waiting_review" : "failed",
        result: { text },
        error: succeeded ? undefined : text,
      },
      at: this.options.now?.() ?? Date.now(),
    });
    return succeeded;
  }
}

/** The cloud node only needs a shell command; keep it to the one named in the goal. */
function argvFromGoal(goal: string): string[] {
  const match = goal.match(/\buname(?:\s+-[a-zA-Z]+)*\b/);
  return match ? match[0].split(/\s+/) : ["uname", "-srm"];
}

export function createConfiguredOwnerTaskSyncAdapter(
  cfg?: AllBotConfig,
  options: {
    store?: OwnerTaskStore;
    client?: SyncGatewayClient;
    nodeInvoke?: NodeInvoker;
    nodeId?: string;
  } = {},
): OwnerTaskSyncAdapter | null {
  const config = (cfg ?? loadConfig()).tasks?.sync;
  if (!config?.enabled) {
    return null;
  }
  const tokenEnv = config.tokenEnv ?? "ALLBOT_SYNC_GATEWAY_TOKEN";
  let token = process.env[tokenEnv];
  if (!token) {
    try {
      const file = path.join(os.homedir(), ".allbot", "sync-gateway-token");
      token = fs.readFileSync(file, "utf8").trim();
      if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) {
        throw new Error("token file permissions must be 0600");
      }
    } catch {
      /* missing file is handled by the disabled log */
    }
  }
  if (!config.baseUrl || !token) {
    log.warn("sync adapter disabled: missing baseUrl or token environment", {
      baseUrlConfigured: Boolean(config.baseUrl),
      tokenEnv,
    });
    return null;
  }
  const client = options.client ?? createHttpSyncGatewayClient({ baseUrl: config.baseUrl, token });
  return new OwnerTaskSyncAdapter(client, {
    store: options.store ?? createOwnerTaskStore(),
    deviceId: options.nodeId,
    nodeInvoke: options.nodeInvoke,
  });
}

export function newSyncTaskId(): string {
  return `task_${randomUUID().replaceAll("-", "")}`;
}
