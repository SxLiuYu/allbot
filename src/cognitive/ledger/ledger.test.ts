import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDecisionLedger } from "./ledger.js";
import type { DecisionLedger, LedgerEntry } from "./ledger.js";

const DAY_MS = 86_400_000;
const AGENT = "main";
const USER = "user-1";

let tempDir: string;
let ledger: DecisionLedger;

function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    traceId: "trace-1",
    agentId: AGENT,
    userId: USER,
    at: Date.now(),
    eventType: "proactive.send",
    decision: "sent",
    vetoReasons: [],
    pNeed: 0.8,
    pAccept: 0.7,
    pAct: 0.6,
    threshold: 0.5,
    llmCalls: 1,
    inputTokens: 120,
    outputTokens: 30,
    deliveryId: "delivery-1",
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "allbot-decision-ledger-"));
  ledger = createDecisionLedger({ dir: tempDir });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createDecisionLedger", () => {
  it("writes an entry and reads it back with all fields intact", async () => {
    const entry = makeEntry({
      traceId: "trace-roundtrip",
      decision: "vetoed",
      vetoReasons: ["too-recent"],
    });

    await ledger.record(entry);

    const recent = await ledger.listRecent(AGENT, USER, 10);
    expect(recent).toEqual([entry]);
  });

  it("returns [] when the user has no entries", async () => {
    expect(await ledger.listRecent(AGENT, "unknown-user", 10)).toEqual([]);
  });

  it("returns entries newest first and applies the limit", async () => {
    const now = Date.now();
    await ledger.record(makeEntry({ traceId: "oldest", at: now - 3_000 }));
    await ledger.record(makeEntry({ traceId: "middle", at: now - 2_000 }));
    await ledger.record(makeEntry({ traceId: "newest", at: now - 1_000 }));

    const recent = await ledger.listRecent(AGENT, USER, 2);
    expect(recent.map((entry) => entry.traceId)).toEqual(["newest", "middle"]);
  });

  it("drops entries older than the default 30-day retention", async () => {
    const now = Date.now();
    await ledger.record(makeEntry({ traceId: "expired", at: now - 31 * DAY_MS }));
    await ledger.record(makeEntry({ traceId: "fresh", at: now - 1 * DAY_MS }));

    const recent = await ledger.listRecent(AGENT, USER, 10);
    expect(recent.map((entry) => entry.traceId)).toEqual(["fresh"]);
  });

  it("honours a custom retentionDays window", async () => {
    const shortRetention = createDecisionLedger({ dir: tempDir, retentionDays: 1 });
    const now = Date.now();
    await shortRetention.record(makeEntry({ traceId: "two-days-old", at: now - 2 * DAY_MS }));
    await shortRetention.record(makeEntry({ traceId: "half-day-old", at: now - DAY_MS / 2 }));

    const recent = await shortRetention.listRecent(AGENT, USER, 10);
    expect(recent.map((entry) => entry.traceId)).toEqual(["half-day-old"]);
  });

  it("keeps every line when records run concurrently from separate ledger instances", async () => {
    const otherLedger = createDecisionLedger({ dir: tempDir });
    const total = 40;
    const writes: Promise<void>[] = [];
    for (let index = 0; index < total; index += 1) {
      const target = index % 2 === 0 ? ledger : otherLedger;
      writes.push(
        target.record(
          makeEntry({
            traceId: `trace-${index}`,
            at: Date.now() + index,
          }),
        ),
      );
    }

    await Promise.all(writes);

    const recent = await ledger.listRecent(AGENT, USER, total + 10);
    expect(recent).toHaveLength(total);
    const traceIds = new Set(recent.map((entry) => entry.traceId));
    expect(traceIds.size).toBe(total);
  });

  it("skips malformed lines instead of failing the whole read", async () => {
    await ledger.record(makeEntry({ traceId: "valid" }));
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(tempDir, AGENT, `${USER}.jsonl`), "not-json{{{\n");

    const recent = await ledger.listRecent(AGENT, USER, 10);
    expect(recent.map((entry) => entry.traceId)).toEqual(["valid"]);
  });
});
