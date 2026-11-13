import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importHistoricalSubagentRuns, type HistoricalSubagentRun } from "./import-history.js";
import { createOwnerTaskStore } from "./store.js";

const dirs: string[] = [];

function makeStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-tasks-import-"));
  dirs.push(dir);
  return createOwnerTaskStore({ filePath: path.join(dir, "owner-tasks.json") });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const runs: HistoricalSubagentRun[] = [
  {
    runId: "run-ok",
    childSessionKey: "agent:main:subagent:ok",
    requesterSessionKey: "agent:main:main",
    task: "finished work",
    createdAt: 1_000,
    endedAt: 2_000,
    outcomeStatus: "ok",
    resultText: "final answer",
  },
  {
    runId: "run-fail",
    childSessionKey: "agent:main:subagent:fail",
    requesterSessionKey: "agent:main:main",
    task: "broken work",
    createdAt: 1_000,
    endedAt: 2_000,
    outcomeStatus: "error",
    resultText: null,
  },
  {
    runId: "run-live",
    childSessionKey: "agent:main:subagent:live",
    requesterSessionKey: "agent:main:main",
    task: "still running",
    createdAt: 1_000,
  },
];

describe("importHistoricalSubagentRuns", () => {
  it("imports terminal runs as done/failed without touching the source", async () => {
    const store = makeStore();
    const sourceSnapshot = JSON.stringify(runs);
    const result = await importHistoricalSubagentRuns({ store, runs });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(JSON.stringify(runs)).toBe(sourceSnapshot);

    const tasks = (await store.read()).tasks;
    const byRun = new Map(tasks.map((task) => [task.worker.runId, task]));
    expect(byRun.get("run-ok")?.status).toBe("done");
    expect(byRun.get("run-ok")?.resultText).toBe("final answer");
    expect(byRun.get("run-fail")?.status).toBe("failed");
    expect(byRun.has("run-live")).toBe(false);
  });

  it("is idempotent on repeated imports", async () => {
    const store = makeStore();
    await importHistoricalSubagentRuns({ store, runs });
    const again = await importHistoricalSubagentRuns({ store, runs });
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(3);
    expect((await store.read()).tasks).toHaveLength(2);
  });
});
