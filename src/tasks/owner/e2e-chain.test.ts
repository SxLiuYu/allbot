import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentRegistryLifecycleController } from "../../agents/subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { AllBotConfig } from "../../config/config.js";
import { createOwnerTaskForSubagentSpawn } from "../../tasks/owner/spawn-bridge.js";
import { createOwnerTaskStore } from "../../tasks/owner/store.js";
import { syncOwnerTaskFromSubagentCompletion } from "../../tasks/owner/subagent-bridge.js";

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const helperMocks = vi.hoisted(() => ({
  persistSubagentSessionTiming: vi.fn(async () => {}),
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
  logAnnounceGiveUp: vi.fn(),
}));

vi.mock("../../tasks/task-executor.js", () => ({
  completeTaskRunByRunId: taskExecutorMocks.completeTaskRunByRunId,
  failTaskRunByRunId: taskExecutorMocks.failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId: taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId,
}));

vi.mock("../../agents/subagent-registry-completion.js", () => ({
  runOutcomesEqual: (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right),
}));

vi.mock("../../agents/subagent-registry-cleanup.js", () => ({
  resolveCleanupCompletionReason: () => "complete",
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "retry-limit" }),
}));

vi.mock("../../agents/subagent-registry-helpers.js", () => ({
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: 30 * 60_000,
  ANNOUNCE_EXPIRY_MS: 5 * 60_000,
  MAX_ANNOUNCE_RETRY_COUNT: 3,
  MIN_ANNOUNCE_RETRY_DELAY_MS: 1_000,
  capFrozenResultText: (text: string) => text.trim(),
  logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
  persistSubagentSessionTiming: helperMocks.persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs: () => 1_000,
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
}));

vi.mock("../../agents/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => "final result"),
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: { log: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: vi.fn(),
}));
vi.mock("../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));
vi.mock("../../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (origin: unknown) => origin,
}));

const originalStateDir = process.env.ALLBOT_STATE_DIR;
let dir = "";

const ENABLED = {
  tasks: { enabled: true, maxAttempts: 3 },
} as AllBotConfig;
const DISABLED = {} as AllBotConfig;

function makeStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), "owner-task-e2e-"));
  dir = root;
  process.env.ALLBOT_STATE_DIR = root;
  return createOwnerTaskStore();
}

function runEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-e2e",
    childSessionKey: "agent:main:subagent:e2e",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "e2e task",
    cleanup: "keep",
    createdAt: 1_000,
    startedAt: 2_000,
    ...overrides,
  };
}

/**
 * E2E seam: spawn -> registry completion -> OwnerTask review -> announce.
 * On the pre-fix implementation no OwnerTask is created at spawn, so the
 * bridge cannot find a task and `reviewRequired` stays false.
 */
describe("owner task e2e: spawn to review to announce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makeStore();
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.ALLBOT_STATE_DIR;
    } else {
      process.env.ALLBOT_STATE_DIR = originalStateDir;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("creates a task at spawn, stores the worker result, and announces reviewRequired=true", async () => {
    const store = createOwnerTaskStore();
    const entry = runEntry();
    const created = await createOwnerTaskForSubagentSpawn({
      childRunId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterInternalKey: entry.requesterSessionKey,
      agentTo: "operator",
      task: entry.task,
      label: "E2E",
      cfg: ENABLED,
      store,
      now: 1_000,
    });
    expect(created).not.toBeNull();
    expect(created?.status).toBe("in_progress");

    const sync = await syncOwnerTaskFromSubagentCompletion({
      store,
      cfg: ENABLED,
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
      outcomeStatus: "ok",
      resultText: "final result",
      now: 2_000,
    });
    expect(sync).toEqual({
      synced: true,
      reviewRequired: true,
      taskId: created!.taskId,
    });

    const stored = (await store.read()).tasks[0]!;
    expect(stored.status).toBe("needs_review");
    expect(stored.resultText).toBe("final result");
    expect(stored.resultVersion).toBe(1);

    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const controller = createSubagentRegistryLifecycleController({
      runs: new Map([[entry.runId, entry]]),
      resumedRuns: new Set(),
      subagentAnnounceTimeoutMs: 1_000,
      persist: vi.fn(),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      suppressAnnounceForSteerRestart: () => false,
      shouldEmitEndedHookForRun: () => false,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      resumeSubagentRun: vi.fn(),
      captureSubagentCompletionReply: vi.fn(async () => "final result"),
      runSubagentAnnounceFlow,
      warn: vi.fn(),
    });
    const startResult = controller.startSubagentAnnounceCleanupFlow(entry.runId, {
      ...entry,
      endedAt: 2_000,
      outcome: { status: "ok" },
      frozenResultText: "final result",
    });
    expect(startResult).toBe(true);
    await vi.waitFor(() => {
      expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({ reviewRequired: true }),
      );
    });
  });

  it("does not create a task for nested worker spawn", async () => {
    const store = createOwnerTaskStore();
    const created = await createOwnerTaskForSubagentSpawn({
      childRunId: "nested-run",
      childSessionKey: "agent:main:subagent:nested:subagent:child",
      requesterInternalKey: "agent:main:subagent:nested",
      agentTo: "user:ou_abc",
      task: "nested",
      cfg: ENABLED,
      store,
    });
    expect(created).toBeNull();
    expect((await store.read()).tasks).toHaveLength(0);
  });

  it("writes no task file when tasks.enabled is false", async () => {
    const store = createOwnerTaskStore();
    const created = await createOwnerTaskForSubagentSpawn({
      childRunId: "off-run",
      childSessionKey: "agent:main:subagent:off",
      requesterInternalKey: "agent:main:main",
      agentTo: "operator",
      task: "off",
      cfg: DISABLED,
      store,
    });
    expect(created).toBeNull();
    expect((await store.read()).tasks).toHaveLength(0);
  });

  it("stops creating owner tasks once maxActive is reached", async () => {
    const store = createOwnerTaskStore();
    const cfg = { tasks: { enabled: true, maxActive: 1 } } as AllBotConfig;
    const first = await createOwnerTaskForSubagentSpawn({
      childRunId: "active-run",
      childSessionKey: "agent:main:subagent:active",
      requesterInternalKey: "agent:main:main",
      agentTo: "operator",
      task: "active",
      cfg,
      store,
    });
    expect(first).not.toBeNull();
    const second = await createOwnerTaskForSubagentSpawn({
      childRunId: "blocked-run",
      childSessionKey: "agent:main:subagent:blocked",
      requesterInternalKey: "agent:main:main",
      agentTo: "operator",
      task: "blocked",
      cfg,
      store,
    });
    expect(second).toBeNull();
    expect((await store.read()).tasks).toHaveLength(1);
  });

  it("resume announce derives reviewRequired from the task store", async () => {
    const store = createOwnerTaskStore();
    await createOwnerTaskForSubagentSpawn({
      childRunId: "resume-run",
      childSessionKey: "agent:main:subagent:resume",
      requesterInternalKey: "agent:main:main",
      agentTo: "operator",
      task: "resume task",
      cfg: ENABLED,
      store,
    });
    await syncOwnerTaskFromSubagentCompletion({
      store,
      cfg: ENABLED,
      runId: "resume-run",
      childSessionKey: "agent:main:subagent:resume",
      requesterSessionKey: "agent:main:main",
      outcomeStatus: "ok",
      resultText: "resume result",
    });

    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const entry = runEntry({
      runId: "resume-run",
      childSessionKey: "agent:main:subagent:resume",
      endedAt: 2_000,
      outcome: { status: "ok" },
      frozenResultText: "resume result",
    });
    const controller = createSubagentRegistryLifecycleController({
      runs: new Map([[entry.runId, entry]]),
      resumedRuns: new Set(),
      subagentAnnounceTimeoutMs: 1_000,
      persist: vi.fn(),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      suppressAnnounceForSteerRestart: () => false,
      shouldEmitEndedHookForRun: () => false,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      resumeSubagentRun: vi.fn(),
      captureSubagentCompletionReply: vi.fn(async () => "resume result"),
      runSubagentAnnounceFlow,
      warn: vi.fn(),
    });
    expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
    await vi.waitFor(() => {
      expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({ reviewRequired: true }),
      );
    });
  });
});
