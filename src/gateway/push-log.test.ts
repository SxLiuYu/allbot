import { promises as fsPromises } from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendPushLog,
  readPushLog,
  recordPush,
  resolvePushLogPath,
  hasInsightSentLogEntry,
  recordInsightSentLog,
} from "./push-log.js";

const stateDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of stateDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "allbot-pushlog-"));
  stateDirs.push(dir);
  vi.stubEnv("ALLBOT_STATE_DIR", dir);
  return dir;
}

describe("push log", () => {
  const at = Date.parse("2026-11-06T01:23:45.000Z");
  const base = {
    at,
    iso: new Date(at).toISOString(),
    agentId: "main",
    userId: "ou_alice",
    kind: "first_contact" as const,
    outcome: "sent" as const,
    channel: "feishu",
    to: "ou_alice",
    candidateId: "first-contact-1",
    contentLength: 42,
  };

  it("appends one JSONL line per attempt", async () => {
    const dir = withStateDir();
    await appendPushLog(base);
    await appendPushLog({ ...base, candidateId: "first-contact-2", outcome: "failed" });

    const raw = readFileSync(join(dir, "proactive-push-log", "push-2026-11-06.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).candidateId).toBe("first-contact-1");
    expect(JSON.parse(lines[1]!).outcome).toBe("failed");
  });

  it("records refusals with a reason", async () => {
    withStateDir();
    await appendPushLog({
      ...base,
      outcome: "vetoed",
      reason: "profile too new",
      contentLength: undefined,
    });

    const entries = await readPushLog("2026-11-06");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("vetoed");
    expect(entries[0]?.reason).toBe("profile too new");
  });

  it("ignores malformed lines and missing files", async () => {
    const dir = withStateDir();
    const file = resolvePushLogPath(at);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "proactive-push-log"), { recursive: true });
    writeFileSync(file, `${JSON.stringify(base)}\nnot-json\n`);

    expect(await readPushLog("2026-11-06")).toHaveLength(1);
    expect(await readPushLog("2026-11-05")).toEqual([]);
  });

  it("does not throw when the log cannot be written", () => {
    withStateDir();
    vi.spyOn(fsPromises, "open").mockRejectedValue(new Error("disk full"));
    expect(() => recordPush(base)).not.toThrow();
  });

  it("hasInsightSentLogEntry matches only insight sent entries", () => {
    const entries = [
      { ...base, kind: "first_contact", outcome: "sent", candidateId: "x" },
      { ...base, kind: "insight", outcome: "queued", candidateId: "ins-1" },
      { ...base, kind: "insight", outcome: "sent", candidateId: "ins-1" },
    ] as const;
    expect(hasInsightSentLogEntry(entries as never, "ins-1")).toBe(true);
    expect(hasInsightSentLogEntry(entries as never, "ins-2")).toBe(false);
    expect(hasInsightSentLogEntry(entries as never, "x")).toBe(false);
  });

  it("recordInsightSentLog writes once with source/latency/messageId", async () => {
    withStateDir();
    const at = Date.parse("2026-11-06T02:00:00.000Z");
    const generatedAt = Date.parse("2026-11-06T01:00:00.000Z");
    const first = await recordInsightSentLog({
      agentId: "main",
      userId: "ou_alice",
      insightId: "ins-record-1",
      sessionKey: "agent:main:ou_alice",
      contentLength: 120,
      sourceCount: 3,
      messageId: "msg-abc",
      channel: "feishu",
      to: "ou_alice",
      generatedAt,
      at,
    });
    expect(first).toBe(true);
    const second = await recordInsightSentLog({
      agentId: "main",
      userId: "ou_alice",
      insightId: "ins-record-1",
      sessionKey: "agent:main:ou_alice",
      contentLength: 120,
      sourceCount: 3,
      messageId: "msg-abc",
      at,
      generatedAt,
    });
    expect(second).toBe(false);

    const day = "2026-11-06";
    const entries = await readPushLog(day);
    const sent = entries.filter(
      (e) => e.kind === "insight" && e.outcome === "sent" && e.candidateId === "ins-record-1",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sourceCount).toBe(3);
    expect(sent[0]?.deliveryLatencyMs).toBe(at - generatedAt);
    expect(sent[0]?.messageId).toBe("msg-abc");
  });
});
