import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import { runWatchLoopTick } from "./watch-loop.js";

const dirs: string[] = [];

function makeStatePath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "watch-loop-"));
  dirs.push(dir);
  return path.join(dir, "state.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SPEC = {
  id: "release-notes",
  label: "Release notes",
  url: "https://example.com/releases",
  intervalMs: 60_000,
  sessionKey: "agent:main:main",
  instruction: "Summarize what changed.",
};

function makeCfg(): AllBotConfig {
  return { watchLoops: [SPEC] } as unknown as AllBotConfig;
}

function response(text: string) {
  return new Response(text, { status: 200 });
}

describe("runWatchLoopTick", () => {
  it("returns immediately when no watch loops are configured", async () => {
    const fetchImpl = vi.fn();
    const enqueue = vi.fn();
    const result = await runWatchLoopTick({
      cfg: {} as AllBotConfig,
      enqueueSystemEvent: enqueue,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      statePath: makeStatePath(),
    });
    expect(result).toEqual({ checked: 0, changed: [], failed: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("establishes a baseline without waking the Router", async () => {
    const statePath = makeStatePath();
    const enqueue = vi.fn();
    const result = await runWatchLoopTick({
      cfg: makeCfg(),
      enqueueSystemEvent: enqueue,
      fetchImpl: vi.fn(async () => response("v1")) as unknown as typeof fetch,
      statePath,
      now: () => 100_000,
    });
    expect(result).toEqual({ checked: 1, changed: [], failed: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not wake or call a model when the content is unchanged", async () => {
    const statePath = makeStatePath();
    const enqueue = vi.fn();
    const fetchImpl = vi.fn(async () => response("v1"));
    const base = {
      cfg: makeCfg(),
      enqueueSystemEvent: enqueue,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      statePath,
    };
    await runWatchLoopTick({ ...base, now: () => 100_000 });
    const second = await runWatchLoopTick({ ...base, now: () => 160_001 });
    expect(second).toEqual({ checked: 1, changed: [], failed: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("wakes the Router only when the content changes", async () => {
    const statePath = makeStatePath();
    const enqueue = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response("v1"))
      .mockResolvedValueOnce(response("v2"));
    const base = {
      cfg: makeCfg(),
      enqueueSystemEvent: enqueue,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      statePath,
    };
    await runWatchLoopTick({ ...base, now: () => 100_000 });
    const changed = await runWatchLoopTick({ ...base, now: () => 160_001 });
    expect(changed).toEqual({ checked: 1, changed: ["release-notes"], failed: [] });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining("Release notes changed"),
      { sessionKey: "agent:main:main", contextKey: "watch-loop:release-notes" },
    );
    expect(enqueue.mock.calls[0]?.[0]).toContain("Summarize what changed.");
  });

  it("persists a change and replays it on the next tick after a restart", async () => {
    const statePath = makeStatePath();
    const enqueue = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response("v1"))
      .mockResolvedValueOnce(response("v2"));
    const base = {
      cfg: makeCfg(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      statePath,
    };
    await runWatchLoopTick({
      ...base,
      enqueueSystemEvent: vi.fn(),
      now: () => 100_000,
    });
    await runWatchLoopTick({
      ...base,
      enqueueSystemEvent: enqueue,
      now: () => 160_001,
    });
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      pendingEvents?: unknown[];
    };
    expect(state.pendingEvents).toHaveLength(1);

    // Simulate a restart: no poll is due, but the persisted event replays.
    const replay = vi.fn();
    const result = await runWatchLoopTick({
      ...base,
      enqueueSystemEvent: replay,
      now: () => 160_002,
    });
    expect(result.checked).toBe(0);
    expect(replay).toHaveBeenCalledWith(
      expect.stringContaining("Release notes changed"),
      { sessionKey: "agent:main:main", contextKey: "watch-loop:release-notes" },
    );
  });

  it("rejects non-https URLs and reports failed polls without waking", async () => {
    const statePath = makeStatePath();
    const enqueue = vi.fn();
    const cfg = {
      watchLoops: [{ ...SPEC, url: "http://example.com/releases" }, SPEC],
    } as unknown as AllBotConfig;
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await runWatchLoopTick({
      cfg,
      enqueueSystemEvent: enqueue,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      statePath,
      now: () => 100_000,
    });
    expect(result.changed).toEqual([]);
    expect(result.failed).toContain("release-notes");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
