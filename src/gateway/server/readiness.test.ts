import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import {
  setCognitiveSchedulerHealthProvider,
  resetCognitiveSchedulerHealthProvider,
} from "../cognitive-scheduler-health-registry.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "../server-channels.js";
import { createReadinessChecker } from "./readiness.js";

afterEach(() => {
  resetCognitiveSchedulerHealthProvider();
});

function withReadinessClockNoCache(run: () => void) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
}

function snapshotWith(
  accounts: Record<string, Partial<ChannelAccountSnapshot>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};

  for (const [channelId, accountSnapshot] of Object.entries(accounts)) {
    const resolved = { accountId: "default", ...accountSnapshot } as ChannelAccountSnapshot;
    channels[channelId as ChannelId] = resolved;
    channelAccounts[channelId as ChannelId] = { default: resolved };
  }

  return { channels, channelAccounts };
}

function createManager(snapshot: ChannelRuntimeSnapshot): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => snapshot),
    startChannels: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    markChannelLoggedOut: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
  };
}

function createHealthyDiscordManager(startedAt: number, lastEventAt: number): ChannelManager {
  return createManager(
    snapshotWith({
      discord: {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: startedAt,
        lastEventAt,
      },
    }),
  );
}

function withReadinessClock(run: () => void) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
}

function createReadinessHarness(params: {
  startedAgoMs: number;
  accounts: Record<string, Partial<ChannelAccountSnapshot>>;
  cacheTtlMs?: number;
}) {
  const startedAt = Date.now() - params.startedAgoMs;
  const manager = createManager(snapshotWith(params.accounts));
  return {
    manager,
    readiness: createReadinessChecker({
      channelManager: manager,
      startedAt,
      cacheTtlMs: params.cacheTtlMs,
    }),
  };
}

describe("createReadinessChecker", () => {
  it("reports ready when all managed channels are healthy", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 5 * 60_000;
      const manager = createHealthyDiscordManager(startedAt, Date.now() - 1_000);

      const readiness = createReadinessChecker({ channelManager: manager, startedAt });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    });
  });

  it("ignores disabled and unconfigured channels", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: false,
            enabled: false,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
          },
          telegram: {
            running: false,
            enabled: true,
            configured: false,
            lastStartAt: Date.now() - 5 * 60_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    });
  });

  it("uses startup grace before marking disconnected channels not ready", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        startedAgoMs: 30_000,
        accounts: {
          discord: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 30_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 30_000 });
    });
  });

  it("reports disconnected managed channels after startup grace", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: false, failing: ["discord"], uptimeMs: 300_000 });
    });
  });

  it("keeps restart-pending channels ready during reconnect backoff", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 5 * 60_000;
      const { readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: false,
            restartPending: true,
            reconnectAttempts: 3,
            enabled: true,
            configured: true,
            lastStartAt: startedAt - 30_000,
            lastStopAt: Date.now() - 5_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    });
  });

  it("treats stale-socket channels as ready to avoid pulling healthy idle pods", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 31 * 60_000;
      const { readiness } = createReadinessHarness({
        startedAgoMs: 31 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: startedAt,
            lastEventAt: Date.now() - 31 * 60_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 1_860_000 });
    });
  });

  it("keeps telegram long-polling channels ready without stale-socket classification", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 31 * 60_000;
      const { readiness } = createReadinessHarness({
        startedAgoMs: 31 * 60_000,
        accounts: {
          telegram: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: startedAt,
            lastEventAt: null,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 1_860_000 });
    });
  });

  it("caches readiness snapshots briefly to keep repeated probes cheap", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
            lastEventAt: Date.now() - 1_000,
          },
        },
        cacheTtlMs: 1_000,
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
      vi.advanceTimersByTime(500);
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_500 });
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 301_100 });
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("flags cognitive-scheduler in failing when the provider reports stale", () => {
    withReadinessClockNoCache(() => {
      setCognitiveSchedulerHealthProvider(() => ({
        enabled: true,
        running: false,
        startedAt: Date.now() - 60 * 60_000,
        lastHeartbeatAt: null,
        lastTickStartedAt: null,
        lastTickCompletedAt: null,
        lastEventAt: null,
        nextTickAt: null,
        tickInFlight: false,
        timerScheduled: false,
        expectedIntervalMs: 3600_000,
        tickCount: 0,
        eventCount: 0,
        consecutiveTickFailures: 0,
      }));
      const { readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
            lastEventAt: Date.now() - 1_000,
          },
        },
      });
      const result = readiness();
      expect(result.ready).toBe(false);
      expect(result.failing).toContain("cognitive-scheduler");
    });
  });

  it("does not flag cognitive-scheduler when the provider is disabled", () => {
    withReadinessClockNoCache(() => {
      setCognitiveSchedulerHealthProvider(() => ({
        enabled: false,
        running: false,
        startedAt: null,
        lastHeartbeatAt: null,
        lastTickStartedAt: null,
        lastTickCompletedAt: null,
        lastEventAt: null,
        nextTickAt: null,
        tickInFlight: false,
        timerScheduled: false,
        expectedIntervalMs: 0,
        tickCount: 0,
        eventCount: 0,
        consecutiveTickFailures: 0,
      }));
      const { readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
            lastEventAt: Date.now() - 1_000,
          },
        },
      });
      const result = readiness();
      expect(result.ready).toBe(true);
      expect(result.failing).not.toContain("cognitive-scheduler");
    });
  });

  it("recomputes cognitive-scheduler health on every probe (not masked by the 1s cache)", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
            lastEventAt: Date.now() - 1_000,
          },
        },
        cacheTtlMs: 1_000,
      });

      // First probe: scheduler healthy => ready. This populates the 1s cache.
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
      // Cache hit (within 1s): channel snapshot is not re-read.
      vi.advanceTimersByTime(500);
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_500 });
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

      // Now the scheduler stalls. The cognitive check is non-cached, so the very
      // next probe (still inside the 1s cache window) must surface it.
      setCognitiveSchedulerHealthProvider(() => ({
        enabled: true,
        running: false,
        startedAt: Date.now() - 60 * 60_000,
        lastHeartbeatAt: null,
        lastTickStartedAt: null,
        lastTickCompletedAt: null,
        lastEventAt: null,
        nextTickAt: null,
        tickInFlight: false,
        timerScheduled: false,
        expectedIntervalMs: 3600_000,
        tickCount: 0,
        eventCount: 0,
        consecutiveTickFailures: 0,
      }));

      vi.advanceTimersByTime(200); // still cached for channels, but not for cognitive
      const result = readiness();
      expect(result.ready).toBe(false);
      expect(result.failing).toContain("cognitive-scheduler");
      // Channel snapshot stays cached (single call); only the cognitive verdict refreshed.
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);
    });
  });
});
