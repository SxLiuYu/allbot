import type { SchedulerEvent } from "../types.js";

/**
 * Evolution-scan event source for the proactive scheduler.
 * Emits one event on start, then at fixed intervals, so a freshly started
 * gateway checks for skill-evolution opportunities without waiting a full
 * cycle.
 */
export class EvolutionSource {
  private handle: ReturnType<typeof setInterval> | undefined;
  private listeners: Array<(event: SchedulerEvent) => void> = [];
  private started = false;

  constructor(private readonly intervalMs: number) {}

  onEvent(listener: (event: SchedulerEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    const event: SchedulerEvent = {
      type: "evolution_scan",
      timestamp: Date.now(),
      payload: { scanIntervalMs: this.intervalMs },
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.emit();
    this.handle = setInterval(() => this.emit(), this.intervalMs);

    if (this.handle.unref) {
      this.handle.unref();
    }
  }

  stop(): void {
    if (this.handle !== undefined) {
      clearInterval(this.handle);
      this.handle = undefined;
    }
    this.started = false;
  }
}
