import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnerTaskStore } from "../owner/store.js";
import { createOwnerTask, transitionOwnerTask } from "../owner/transition.js";
import { OwnerTaskSyncAdapter } from "./adapter.js";
import { createHttpSyncGatewayClient } from "./client.js";
import {
  assertSyncTransition,
  ownerStatusFromSync,
  syncTaskFromOwner,
  type SyncTask,
} from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-sync-"));
  dirs.push(dir);
  return createOwnerTaskStore({ filePath: path.join(dir, "tasks.json") });
}
function remote(overrides: Partial<SyncTask> = {}): SyncTask {
  return {
    id: "task_remote_0001",
    goal: "run uname",
    status: "pending",
    origin: "web",
    target: "cloud",
    ownerId: "ou_owner",
    deviceId: "sg-cloud-node-1",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("OwnerTask sync contract", () => {
  it("maps every owner status and preserves review/result metadata", async () => {
    const s = store();
    const task = await createOwnerTask({
      store: s,
      ownerId: "ou_owner",
      routerSessionKey: "agent:main:main",
      title: "test",
      goal: "work",
      source: { kind: "user", channel: "feishu" },
      worker: { kind: "subagent", childSessionKey: "child" },
      sensitivity: "payment",
      execution: { environment: "cloud", deviceId: "sg-cloud-node-1" },
    });
    const projected = syncTaskFromOwner(task);
    expect(projected).toMatchObject({
      id: task.taskId,
      status: "running",
      origin: "feishu",
      target: "cloud",
      sensitivity: "payment",
      version: 1,
    });
    expect(ownerStatusFromSync(projected.status)).toBe("in_progress");
    expect(ownerStatusFromSync("waiting_review")).toBe("needs_review");
    expect(ownerStatusFromSync("waiting_input")).toBeNull();
  });

  it("rejects sensitive auto-done and non-human review acceptance", () => {
    expect(() => assertSyncTransition("running", "done", "payment", "worker:subagent")).toThrow(
      "requires review",
    );
    expect(() =>
      assertSyncTransition("waiting_review", "done", "payment", "worker:subagent"),
    ).toThrow("human owner");
    expect(() =>
      assertSyncTransition("waiting_review", "done", "payment", "owner:ou_owner"),
    ).not.toThrow();
    expect(() => assertSyncTransition("done", "running", "normal", "owner:ou_owner")).toThrow(
      "illegal",
    );
  });

  it("imports a remote cloud task once and dispatches with idempotent node.invoke", async () => {
    const s = store();
    const appendEvent = vi.fn().mockResolvedValue(undefined);
    const nodeInvoke = vi
      .fn()
      .mockImplementation(async ({ command }) =>
        command === "system.run.prepare"
          ? { ok: true, payload: { plan: { argv: ["uname", "-srm"], commandText: "uname -srm" } } }
          : { ok: true, payload: { success: true, exitCode: 0, stdout: "Linux x86_64" } },
      );
    const adapter = new OwnerTaskSyncAdapter(
      { listTasks: vi.fn(), createTask: vi.fn(), appendEvent },
      {
        store: s,
        nodeInvoke,
        now: () => 100,
      },
    );
    expect(await adapter.dispatchCloud(remote())).toBe(true);
    expect(await adapter.importRemote(remote())).toMatchObject({ taskId: "task_remote_0001" });
    expect((await s.read()).tasks).toHaveLength(1);
    expect(nodeInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "sg-cloud-node-1",
        command: "system.run",
        idempotencyKey: "sync-task:task_remote_0001:1",
      }),
    );
    expect(appendEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "result",
        payload: expect.objectContaining({ status: "waiting_review" }),
      }),
    );
  });

  it("re-runs a rejected projected task through the node instead of a dead session", async () => {
    const s = store();
    const appendEvent = vi.fn().mockResolvedValue(undefined);
    const cloud = remote({ status: "waiting_review", version: 4, goal: "在 sg 节点执行 uname -a" });
    const listTasks = vi.fn().mockResolvedValue([cloud]);
    const nodeInvoke = vi
      .fn()
      .mockImplementation(async ({ command }) =>
        command === "system.run.prepare"
          ? { ok: true, payload: { plan: { argv: ["uname", "-a"], commandText: "uname -a" } } }
          : { ok: true, payload: { success: true, exitCode: 0, stdout: "Linux x86_64" } },
      );
    const adapter = new OwnerTaskSyncAdapter(
      { listTasks, createTask: vi.fn(), appendEvent },
      { store: s, nodeInvoke, now: () => 200 },
    );
    const imported = await adapter.importRemote(cloud);
    if (!imported) {
      throw new Error("import failed");
    }
    const reviewed = await transitionOwnerTask({
      store: s,
      taskId: imported.taskId,
      to: "needs_review",
      actor: "worker:cloud",
      resultText: "old",
    });
    expect(reviewed.ok).toBe(true);
    const rejected = await transitionOwnerTask({
      store: s,
      taskId: imported.taskId,
      to: "in_progress",
      actor: "owner:ou_owner",
      reviewNote: "please rerun",
      note: "please rerun",
    });
    expect(rejected.ok).toBe(true);
    expect(await adapter.redispatch((await s.read()).tasks[0])).toBe(true);
    expect(nodeInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "system.run.prepare",
        params: expect.objectContaining({ command: ["uname", "-a"] }),
      }),
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "result",
        idempotencyKey: expect.stringContaining("sync-redispatch:task_remote_0001:4"),
      }),
    );
    expect((await s.read()).tasks[0]?.status).toBe("needs_review");
  });

  it("does not import phone tasks and reprojects after restart using remote idempotency", async () => {
    const s = store();
    const createTask = vi.fn().mockResolvedValue({});
    const adapter = new OwnerTaskSyncAdapter(
      { listTasks: vi.fn(), createTask, appendEvent: vi.fn() },
      {
        store: s,
      },
    );
    expect(await adapter.importRemote(remote({ target: "phone" }))).toBeNull();
    const task = await createOwnerTask({
      store: s,
      ownerId: "ou_owner",
      routerSessionKey: "agent:main:main",
      title: "test",
      goal: "work",
      source: { kind: "user" },
      worker: { kind: "subagent", childSessionKey: "child" },
    });
    expect(await adapter.project(task)).toBe(true);
    const restarted = new OwnerTaskSyncAdapter(
      { listTasks: vi.fn(), createTask, appendEvent: vi.fn() },
      {
        store: s,
      },
    );
    expect(await restarted.project(task)).toBe(true);
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[0][1]).toBe(createTask.mock.calls[1][1]);
  });

  it("rejects insecure non-loopback gateway origins and redacts the token", async () => {
    expect(() =>
      createHttpSyncGatewayClient({ baseUrl: "http://example.com", token: "secret" }),
    ).toThrow("HTTPS");
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createHttpSyncGatewayClient({
      baseUrl: "https://sync.example.com",
      token: "secret",
      fetchImpl,
    });
    expect(await client.listTasks()).toEqual([]);
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe("Bearer secret");
  });
});
