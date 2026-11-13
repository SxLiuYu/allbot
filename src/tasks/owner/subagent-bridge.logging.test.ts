import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createOwnerTaskStore } from "./store.js";
import { syncOwnerTaskFromSubagentCompletion } from "./subagent-bridge.js";

// The logger is injected rather than module-mocked: in the local suite vitest
// runs without isolation for speed, so several files import subagent-bridge.js
// in the same worker. A vi.mock here only wins if this file happens to be the
// first to load the module -- otherwise the real logger is already bound and
// the assertion sees zero calls. Injection removes the load-order dependency.
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

const logger = loggerMocks as unknown as Pick<SubsystemLogger, "debug" | "warn">;

const dirs: string[] = [];

function makeStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-task-log-"));
  dirs.push(dir);
  return createOwnerTaskStore({ filePath: path.join(dir, "owner-tasks.json") });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe("owner task sync logging", () => {
  it("warns with the runId when the store throws", async () => {
    const store = makeStore();
    const broken = {
      filePath: store.filePath,
      read: vi.fn(async () => {
        throw new Error("store boom");
      }),
      update: store.update,
    };
    const result = await syncOwnerTaskFromSubagentCompletion({
      store: broken,
      cfg: { tasks: { enabled: true } } as AllBotConfig,
      runId: "run-log-test",
      childSessionKey: "agent:main:subagent:log",
      requesterSessionKey: "agent:main:main",
      outcomeStatus: "ok",
      resultText: "text",
      logger,
    });
    expect(result.synced).toBe(false);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "owner task sync failed",
      expect.objectContaining({
        runId: "run-log-test",
        childSessionKey: "agent:main:subagent:log",
        outcomeStatus: "ok",
        error: "store boom",
      }),
    );
  });
});
