import type { SchedulerEvent } from "../types.js";

/**
 * Standalone timer event source, kept for scheduler unit tests and as a
 * reference implementation. Production gateways must NOT wire this class:
 * `ProactiveScheduler.start()` already owns a jittered, active-hours-aware,
 * multi-user timer chain (see proactive-scheduler.ts). Registering both would
 * double-fire `timer` events and duplicate proactive work.
 *
 * Real production event sources are InfoScanSource, PersonaChangeSource,
 * EvolutionSource, and FeishuActivitySource, all installed in server.impl.ts.
 */
export class TimerSource {
  private handle: ReturnType<typeof setInterval> | undefined;
  private listeners: Array<(event: SchedulerEvent) => void> = [];

  constructor(private readonly intervalMs: number) {}

  onEvent(listener: (event: SchedulerEvent) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    this.handle = setInterval(() => {
      const event: SchedulerEvent = { type: "timer", timestamp: Date.now() };
      for (const listener of this.listeners) {
        listener(event);
      }
    }, this.intervalMs);

    if (this.handle.unref) {
      this.handle.unref();
    }
  }

  stop(): void {
    if (this.handle !== undefined) {
      clearInterval(this.handle);
      this.handle = undefined;
    }
  }
}
