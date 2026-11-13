import { describe, it, expect, vi, afterEach } from "vitest";
import { FeishuActivitySource, emitFeishuActivitySignal } from "./feishu-activity-source.js";

describe("FeishuActivitySource", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("constructs without error", () => {
    const source = new FeishuActivitySource(5000);
    expect(source).toBeInstanceOf(FeishuActivitySource);
  });

  it("emits periodic scans at the configured interval", () => {
    vi.useFakeTimers();
    const source = new FeishuActivitySource(1000);
    const events: Array<{ type: string; payload?: unknown }> = [];

    source.onEvent((event) => events.push(event));
    source.start();

    vi.advanceTimersByTime(2500);

    expect(events.length).toBe(2);
    expect(events[0].type).toBe("activity_scan");
    expect(events[0].payload).toMatchObject({ source: "periodic_scan", scanIntervalMs: 1000 });

    source.stop();
  });

  it("drives an activity_scan from a real Feishu message via the global bridge", () => {
    vi.useFakeTimers();
    const source = new FeishuActivitySource(60_000);
    const events: Array<{ type: string; timestamp: number; payload?: unknown }> = [];
    source.onEvent((event) => events.push(event));
    source.start();

    emitFeishuActivitySignal({
      senderOpenId: "ou_test",
      chatId: "oc_test",
      chatType: "p2p",
      at: 12_345,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("activity_scan");
    expect(events[0].timestamp).toBe(12_345);
    expect(events[0].payload).toMatchObject({
      source: "feishu_message",
      senderOpenId: "ou_test",
      chatId: "oc_test",
      chatType: "p2p",
    });
    source.stop();
  });

  it("ignores bridge signals before start and after stop", () => {
    vi.useFakeTimers();
    const source = new FeishuActivitySource(60_000);
    const events: unknown[] = [];
    source.onEvent((event) => events.push(event));

    emitFeishuActivitySignal({ senderOpenId: "ou_test", at: 1 });
    source.start();
    source.stop();
    emitFeishuActivitySignal({ senderOpenId: "ou_test", at: 2 });

    expect(events).toHaveLength(0);
  });

  it("does not start twice", () => {
    vi.useFakeTimers();
    const source = new FeishuActivitySource(1000);
    const events: unknown[] = [];
    source.onEvent((event) => events.push(event));
    source.start();
    source.start();
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(1);
    source.stop();
  });

  it("stops emitting after stop()", () => {
    vi.useFakeTimers();
    const source = new FeishuActivitySource(1000);
    const events: Array<{ type: string }> = [];

    source.onEvent((event) => events.push(event));
    source.start();

    vi.advanceTimersByTime(1000);
    source.stop();
    vi.advanceTimersByTime(3000);

    expect(events.length).toBe(1);
  });

  it("delivers events to all registered listeners", () => {
    vi.useFakeTimers();
    const source = new FeishuActivitySource(60_000);
    const events1: unknown[] = [];
    const events2: unknown[] = [];

    source.onEvent((e) => events1.push(e));
    source.onEvent((e) => events2.push(e));
    source.start();

    emitFeishuActivitySignal({ senderOpenId: "ou_test", at: 1 });

    expect(events1.length).toBe(1);
    expect(events2.length).toBe(1);

    source.stop();
  });

  it("unrefs the timer handle", () => {
    vi.useFakeTimers();
    const source = new FeishuActivitySource(1000);
    const unrefSpy = vi.fn();

    const originalSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((() => {
      const handle = originalSetInterval(() => {}, 99999) as ReturnType<typeof setInterval>;
      (handle as unknown as { unref: typeof unrefSpy }).unref = unrefSpy;
      return handle;
    }) as unknown as typeof setInterval);

    source.start();

    expect(unrefSpy).toHaveBeenCalledOnce();

    source.stop();
    vi.restoreAllMocks();
  });
});
