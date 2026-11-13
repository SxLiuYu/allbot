/**
 * Module-level provider registry for the cognitive proactive scheduler health.
 *
 * The gateway's readiness probe and status endpoint need to read the live
 * scheduler health without holding a direct reference to the (lazily-created)
 * ProactiveScheduler instance. A provider is registered when the cognitive
 * layer initializes (first an "unstarted" placeholder, then the live
 * `() => proactiveScheduler.getHealth()`), and unregistered on shutdown to
 * avoid leaking across tests.
 *
 * If no provider is registered, the default is a disabled snapshot so that
 * readiness/status endpoints never fail-closed for the gateway as a whole.
 */

import type { SchedulerRuntimeHealth } from "../cognitive/scheduler/health.js";

export type SchedulerRuntimeHealthProvider = () => SchedulerRuntimeHealth;

let activeProvider: SchedulerRuntimeHealthProvider | undefined;

export function setCognitiveSchedulerHealthProvider(
  provider: SchedulerRuntimeHealthProvider,
): () => void {
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) {
      activeProvider = undefined;
    }
  };
}

export function resetCognitiveSchedulerHealthProvider(): void {
  activeProvider = undefined;
}

export function getCognitiveSchedulerHealth(): SchedulerRuntimeHealth {
  if (!activeProvider) {
    return disabledCognitiveSchedulerHealth();
  }
  try {
    return activeProvider();
  } catch (err) {
    // Fail-closed: never let a misbehaving provider 500 the probe.
    return {
      enabled: true,
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
      lastError: String(err),
    };
  }
}

export function disabledCognitiveSchedulerHealth(
  enabled = false,
  expectedIntervalMs = 0,
): SchedulerRuntimeHealth {
  return {
    enabled,
    running: false,
    startedAt: null,
    lastHeartbeatAt: null,
    lastTickStartedAt: null,
    lastTickCompletedAt: null,
    lastEventAt: null,
    nextTickAt: null,
    tickInFlight: false,
    timerScheduled: false,
    expectedIntervalMs,
    tickCount: 0,
    eventCount: 0,
    consecutiveTickFailures: 0,
  };
}
