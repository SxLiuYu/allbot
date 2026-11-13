/**
 * Health model + evaluation for the cognitive proactive scheduler.
 *
 * The gateway needs a cheap, fail-closed way to answer "is the proactive
 * scheduler actually making progress?" without coupling /health probes to the
 * scheduler's internal timer. The scheduler publishes a {@link SchedulerRuntimeHealth}
 * snapshot via {@link SchedulerRuntimeHealthProvider}; {@link evaluateSchedulerHealth}
 * turns that snapshot into an ok/stale verdict with short English reasons.
 */

export const SCHEDULER_MISSED_TICK_GRACE_MS = 15 * 60_000;
export const SCHEDULER_WATCHDOG_INTERVAL_MS = 60_000;
export const SCHEDULER_STARTUP_GRACE_MS = 15 * 60_000;

export type SchedulerRuntimeHealth = {
  enabled: boolean;
  running: boolean;
  startedAt: number | null;
  lastHeartbeatAt: number | null;
  lastTickStartedAt: number | null;
  lastTickCompletedAt: number | null;
  lastEventAt: number | null;
  nextTickAt: number | null;
  tickInFlight: boolean;
  timerScheduled: boolean;
  expectedIntervalMs: number;
  tickCount: number;
  eventCount: number;
  consecutiveTickFailures: number;
  lastError?: string;
};

export type SchedulerHealthEvaluation = {
  ok: boolean;
  stale: boolean;
  reasons: string[];
  overdueMs: number | null;
  checkedAt: number;
};

export type EvaluateSchedulerHealthOpts = {
  missedTickGraceMs?: number;
  startupGraceMs?: number;
};

export function evaluateSchedulerHealth(
  health: SchedulerRuntimeHealth,
  now: number,
  opts?: EvaluateSchedulerHealthOpts,
): SchedulerHealthEvaluation {
  const missedTickGraceMs = opts?.missedTickGraceMs ?? SCHEDULER_MISSED_TICK_GRACE_MS;
  const startupGraceMs = opts?.startupGraceMs ?? SCHEDULER_STARTUP_GRACE_MS;
  const reasons: string[] = [];
  let overdueMs: number | null = null;

  if (!health.enabled) {
    return { ok: true, stale: false, reasons: ["disabled"], overdueMs: null, checkedAt: now };
  }

  if (health.startedAt !== null && now - health.startedAt < startupGraceMs) {
    return { ok: true, stale: false, reasons: ["startup-grace"], overdueMs: null, checkedAt: now };
  }

  if (!health.running) {
    reasons.push("not-running");
  }

  if (health.tickInFlight && health.lastTickStartedAt !== null) {
    const inFlightMs = now - health.lastTickStartedAt;
    if (inFlightMs > missedTickGraceMs) {
      reasons.push("tick-in-flight-stuck");
    }
  }

  if (health.nextTickAt !== null) {
    const nextOverdue = now - health.nextTickAt;
    if (nextOverdue > missedTickGraceMs) {
      reasons.push("next-tick-overdue");
      overdueMs = Math.max(overdueMs ?? 0, nextOverdue);
    }
  }

  if (health.lastHeartbeatAt !== null) {
    const sinceHeartbeat = now - health.lastHeartbeatAt;
    if (sinceHeartbeat > missedTickGraceMs) {
      reasons.push("watchdog-stale");
    }
  }

  if (health.running && !health.tickInFlight && !health.timerScheduled) {
    reasons.push("no-timer-scheduled");
  }

  const stale = reasons.length > 0;
  return { ok: !stale, stale, reasons, overdueMs, checkedAt: now };
}
