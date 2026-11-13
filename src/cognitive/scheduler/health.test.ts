import { describe, expect, it } from "vitest";
import {
  evaluateSchedulerHealth,
  SCHEDULER_MISSED_TICK_GRACE_MS,
  SCHEDULER_STARTUP_GRACE_MS,
} from "./health.js";
import type { SchedulerRuntimeHealth } from "./health.js";

function base(overrides: Partial<SchedulerRuntimeHealth> = {}): SchedulerRuntimeHealth {
  return {
    enabled: true,
    running: true,
    startedAt: 1_000_000,
    lastHeartbeatAt: 1_000_000,
    lastTickStartedAt: 1_000_000,
    lastTickCompletedAt: 1_000_000,
    lastEventAt: 1_000_000,
    nextTickAt: 1_000_000 + 10_000,
    tickInFlight: false,
    timerScheduled: true,
    expectedIntervalMs: 3600_000,
    tickCount: 1,
    eventCount: 1,
    consecutiveTickFailures: 0,
    ...overrides,
  };
}

describe("evaluateSchedulerHealth", () => {
  it("is ok when disabled", () => {
    const verdict = evaluateSchedulerHealth(base({ enabled: false }), 2_000_000);
    expect(verdict.ok).toBe(true);
    expect(verdict.stale).toBe(false);
  });

  it("is ok during startup grace", () => {
    const verdict = evaluateSchedulerHealth(
      base({ startedAt: 1_000_000 }),
      1_000_000 + SCHEDULER_STARTUP_GRACE_MS - 1,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toContain("startup-grace");
  });

  it("is stale when nextTickAt is overdue", () => {
    const now = 1_000_000 + SCHEDULER_MISSED_TICK_GRACE_MS + 5_000;
    const verdict = evaluateSchedulerHealth(base({ nextTickAt: 1_000_000 }), now);
    expect(verdict.ok).toBe(false);
    expect(verdict.stale).toBe(true);
    expect(verdict.reasons).toContain("next-tick-overdue");
    expect(verdict.overdueMs).toBe(now - 1_000_000);
  });

  it("is stale when stopped", () => {
    const verdict = evaluateSchedulerHealth(
      base({ running: false, startedAt: 1_000_000 }),
      2_000_000,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain("not-running");
  });

  it("is ok when healthy", () => {
    const now = 2_000_000;
    const verdict = evaluateSchedulerHealth(
      base({
        startedAt: now - 60 * 60_000,
        lastHeartbeatAt: now - 1000,
        lastTickStartedAt: now - 1000,
        lastTickCompletedAt: now - 500,
        lastEventAt: now - 1000,
        nextTickAt: now + 10_000,
      }),
      now,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.stale).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it("is stale when lastHeartbeat is overdue", () => {
    const now = 1_000_000 + SCHEDULER_MISSED_TICK_GRACE_MS + 5_000;
    const verdict = evaluateSchedulerHealth(base({ lastHeartbeatAt: 1_000_000 }), now);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain("watchdog-stale");
  });

  it("is stale when a tick is stuck in flight", () => {
    const now = 1_000_000 + SCHEDULER_MISSED_TICK_GRACE_MS + 5_000;
    const verdict = evaluateSchedulerHealth(
      base({ tickInFlight: true, lastTickStartedAt: 1_000_000, timerScheduled: true }),
      now,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain("tick-in-flight-stuck");
  });

  it("is stale when running but no timer scheduled", () => {
    const now = 2_000_000;
    const verdict = evaluateSchedulerHealth(
      base({
        startedAt: now - 60 * 60_000,
        timerScheduled: false,
        tickInFlight: false,
        lastHeartbeatAt: now - 1000,
        nextTickAt: now + 10_000,
      }),
      now,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain("no-timer-scheduled");
  });
});
