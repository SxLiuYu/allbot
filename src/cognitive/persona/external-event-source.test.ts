import { describe, expect, it } from "vitest";
import { ExternalEventSource, emitExternalEventSignal } from "./feishu-activity-source.js";

describe("ExternalEventSource", () => {
  it("turns an opted-in system event into an external scheduler event", () => {
    const source = new ExternalEventSource();
    const events: Array<{ type: string; timestamp: number; payload?: unknown }> = [];
    source.onEvent((event) => events.push(event));
    source.start();

    emitExternalEventSignal({
      text: "Domestic flight prices changed",
      source: "price-watcher",
      at: 12_345,
      reason: "threshold",
      host: "mac",
      tags: ["proactive:external"],
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("external");
    expect(events[0].timestamp).toBe(12_345);
    expect(events[0].payload).toMatchObject({
      source: "price-watcher",
      text: "Domestic flight prices changed",
      reason: "threshold",
      host: "mac",
      tags: ["proactive:external"],
    });
    source.stop();
  });

  it("ignores bridge signals before start and after stop", () => {
    const source = new ExternalEventSource();
    const events: unknown[] = [];
    source.onEvent((event) => events.push(event));

    emitExternalEventSignal({ text: "before", at: 1 });
    source.start();
    source.stop();
    emitExternalEventSignal({ text: "after", at: 2 });

    expect(events).toHaveLength(0);
  });

  it("does not start twice", () => {
    const source = new ExternalEventSource();
    const events: unknown[] = [];
    source.onEvent((event) => events.push(event));
    source.start();
    source.start();
    emitExternalEventSignal({ text: "one event", at: 3 });
    expect(events).toHaveLength(1);
    source.stop();
  });
});
