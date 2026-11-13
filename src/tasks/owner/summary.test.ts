import { describe, expect, it } from "vitest";
import {
  OWNER_TASK_SUMMARY_LIMIT,
  OWNER_TASK_SUMMARY_MAX_AGE_MS,
  OWNER_TASK_SUMMARY_PROGRESS_MAX,
  OWNER_TASK_SUMMARY_TITLE_MAX,
  buildOwnerTaskSummarySection,
} from "./summary.js";
import type { OwnerTaskRecord, OwnerTaskStatus } from "./types.js";

const NOW = 1_700_000_000_000;
const RECENT = NOW - 60_000;

function makeTask(
  index: number,
  status: OwnerTaskStatus,
  overrides: Partial<OwnerTaskRecord> = {},
): OwnerTaskRecord {
  return {
    taskId: `task_${index}`,
    shortId: `s${String(index).padStart(5, "0")}`,
    ownerId: "ou_owner",
    routerSessionKey: "agent:main:main",
    title: `Task ${index}`,
    goal: `Goal ${index}`,
    source: { kind: "user" },
    worker: {
      kind: "subagent",
      runId: `run_${index}`,
      childSessionKey: `child_${index}`,
    },
    status,
    resultText: status === "needs_review" ? `result ${index}` : null,
    resultVersion: status === "needs_review" ? 1 : 0,
    artifacts: [],
    attemptCount: 1,
    revision: 1,
    createdAt: RECENT - 1_000,
    updatedAt: RECENT + index,
    events: [],
    ...overrides,
  };
}

describe("buildOwnerTaskSummarySection", () => {
  it("returns empty when no active tasks exist", () => {
    expect(
      buildOwnerTaskSummarySection(
        [makeTask(1, "done"), makeTask(2, "failed"), makeTask(3, "cancelled")],
        { now: NOW },
      ),
    ).toBe("");
  });

  it("injects only in_progress and needs_review tasks", () => {
    const text = buildOwnerTaskSummarySection(
      [
        makeTask(1, "in_progress", { updatedAt: RECENT + 3 }),
        makeTask(2, "needs_review", { updatedAt: RECENT + 2 }),
        makeTask(3, "done", { updatedAt: RECENT + 1 }),
      ],
      { now: NOW },
    );
    expect(text).toContain("s00001");
    expect(text).toContain("s00002");
    expect(text).not.toContain("s00003");
  });

  it("caps the number of injected entries at 8", () => {
    const tasks = Array.from({ length: 20 }, (_, index) =>
      makeTask(index, "in_progress", { updatedAt: RECENT + index }),
    );
    const text = buildOwnerTaskSummarySection(tasks, { now: NOW });
    const entries = text.split("\n").filter((line) => /^- \[s\d{5}\]/.test(line));
    expect(entries).toHaveLength(OWNER_TASK_SUMMARY_LIMIT);
    expect(entries[0]).toContain("s00019");
  });

  it("drops stale active tasks from the Router context", () => {
    const text = buildOwnerTaskSummarySection(
      [
        makeTask(1, "in_progress", { updatedAt: RECENT }),
        makeTask(2, "needs_review", {
          updatedAt: NOW - OWNER_TASK_SUMMARY_MAX_AGE_MS - 1,
        }),
      ],
      { now: NOW },
    );
    expect(text).toContain("s00001");
    expect(text).not.toContain("s00002");
    // No needs_review card survives, so the accept/reject instructions vanish too.
    expect(text).not.toContain("验收");
  });

  it("keeps a task exactly at the age boundary", () => {
    const text = buildOwnerTaskSummarySection(
      [makeTask(1, "needs_review", { updatedAt: NOW - OWNER_TASK_SUMMARY_MAX_AGE_MS })],
      { now: NOW },
    );
    expect(text).toContain("s00001");
  });

  it("truncates long titles and progress text", () => {
    const text = buildOwnerTaskSummarySection(
      [
        makeTask(1, "needs_review", {
          title: "x".repeat(200),
          resultText: "y".repeat(1000),
        }),
      ],
      { now: NOW },
    );
    const [titleLine, progressLine] = text.split("\n").slice(1);
    expect(titleLine).toBeDefined();
    expect(progressLine).toBeDefined();
    expect((titleLine!.match(/x/g) ?? []).length).toBeLessThanOrEqual(OWNER_TASK_SUMMARY_TITLE_MAX);
    expect((progressLine!.match(/y/g) ?? []).length).toBeLessThanOrEqual(
      OWNER_TASK_SUMMARY_PROGRESS_MAX,
    );
  });

  it("does not include worker transcripts or artifacts in the summary", () => {
    const text = buildOwnerTaskSummarySection(
      [
        makeTask(1, "in_progress", {
          artifacts: [{ kind: "file", path: "/secret/path/report.md" }],
        }),
      ],
      { now: NOW },
    );
    expect(text).not.toContain("/secret/path/report.md");
  });
});
