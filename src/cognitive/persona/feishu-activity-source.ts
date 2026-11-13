import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SchedulerEvent } from "../scheduler/types.js";

const log = createSubsystemLogger("feishu-activity");

export type FeishuActivitySignal = {
  senderOpenId: string;
  chatId?: string;
  chatType?: string;
  at: number;
};

const ACTIVITY_BRIDGE_KEY = Symbol.for("allbot.cognitive.feishuActivityBridge");

type ActivityBridge = {
  emit: (signal: FeishuActivitySignal) => void;
};

type GlobalWithBridge = typeof globalThis & { [ACTIVITY_BRIDGE_KEY]?: ActivityBridge };

/** Called by the Feishu extension on a real inbound message. */
export function emitFeishuActivitySignal(signal: FeishuActivitySignal): void {
  (globalThis as GlobalWithBridge)[ACTIVITY_BRIDGE_KEY]?.emit(signal);
}

function installBridge(bridge: ActivityBridge | undefined): void {
  (globalThis as GlobalWithBridge)[ACTIVITY_BRIDGE_KEY] = bridge;
}

/**
 * Explicitly tagged gateway system events drive the scheduler's `external`
 * branch. Ordinary `system-event` calls keep their existing behavior.
 */
export type ExternalEventSignal = {
  text: string;
  source?: string;
  at: number;
  reason?: string;
  host?: string;
  tags?: string[];
};

const EXTERNAL_EVENT_BRIDGE_KEY = Symbol.for("allbot.cognitive.externalEventBridge");

type ExternalEventBridge = {
  emit: (signal: ExternalEventSignal) => void;
};

function installExternalBridge(bridge: ExternalEventBridge | undefined): void {
  Reflect.set(globalThis, EXTERNAL_EVENT_BRIDGE_KEY, bridge);
}

/** Called by the gateway when a system event opts into proactive processing. */
export function emitExternalEventSignal(signal: ExternalEventSignal): void {
  const bridge = Reflect.get(globalThis, EXTERNAL_EVENT_BRIDGE_KEY) as
    | ExternalEventBridge
    | undefined;
  bridge?.emit(signal);
}

/**
 * Drives `activity_scan` events from real Feishu activity. A periodic scan
 * remains available as a low-frequency fallback.
 */
export class FeishuActivitySource {
  private handle: ReturnType<typeof setInterval> | undefined;
  private listeners: Array<(event: SchedulerEvent) => void> = [];
  private started = false;

  constructor(private readonly intervalMs: number) {}

  onEvent(listener: (event: SchedulerEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Emit an activity_scan for one real inbound Feishu message. */
  emitFromMessage(signal: FeishuActivitySignal): void {
    if (!this.started) {
      return;
    }
    log.info("real feishu activity received", {
      senderOpenId: signal.senderOpenId,
      chatId: signal.chatId,
      chatType: signal.chatType,
      at: signal.at,
    });
    this.emit({
      type: "activity_scan",
      timestamp: signal.at,
      payload: {
        source: "feishu_message",
        senderOpenId: signal.senderOpenId,
        chatId: signal.chatId,
        chatType: signal.chatType,
      },
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    installBridge({ emit: (signal) => this.emitFromMessage(signal) });
    this.handle = setInterval(() => {
      this.emit({
        type: "activity_scan",
        timestamp: Date.now(),
        payload: { source: "periodic_scan", scanIntervalMs: this.intervalMs },
      });
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
    this.started = false;
    installBridge(undefined);
  }
}

/**
 * Turns opted-in gateway system events into `external` scheduler events.
 * No timer is started here: events are produced only by explicit RPC calls.
 */
export class ExternalEventSource {
  private listeners: Array<(event: SchedulerEvent) => void> = [];
  private started = false;

  onEvent(listener: (event: SchedulerEvent) => void): void {
    this.listeners.push(listener);
  }

  emitFromSystemEvent(signal: ExternalEventSignal): void {
    if (!this.started) {
      return;
    }
    const event: SchedulerEvent = {
      type: "external",
      timestamp: signal.at,
      payload: {
        source: signal.source ?? "system_event",
        text: signal.text,
        reason: signal.reason,
        host: signal.host,
        tags: signal.tags,
      },
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
    installExternalBridge({ emit: (signal) => this.emitFromSystemEvent(signal) });
  }

  stop(): void {
    this.started = false;
    installExternalBridge(undefined);
  }
}
