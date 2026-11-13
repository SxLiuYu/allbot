import { describe, expect, it, vi } from "vitest";
import { createDefaultPersona } from "../persona/store.js";
import { FIRST_CONTACT_MIN_AGE_MS } from "./first-contact.js";
import { ProactiveScheduler } from "./proactive-scheduler.js";
import type { SchedulerConfig } from "./types.js";

const config: SchedulerConfig = {
  minIntervalHours: 1,
  minTrustScore: 0.3,
  costFalseNegative: 7,
  costFalseAlarm: 3,
};

/** A zero-exchange persona old enough to be past the first-contact delay. */
function freshPersona(now: number) {
  const persona = createDefaultPersona();
  persona.identity.userId = "ou_newcomer";
  persona.lifecycle.lastStageTransitionAt = now - FIRST_CONTACT_MIN_AGE_MS - 3_600_000;
  return persona;
}

describe("first contact in the scheduler", () => {
  const now = 1_800_000_000_000;

  it("opens the conversation for a peer who never wrote", async () => {
    const persona = freshPersona(now);
    const onInsightReady = vi.fn(async () => true);
    const savePersona = vi.fn(async () => {});
    const scheduler = new ProactiveScheduler(
      config,
      {
        loadPersona: async () => persona,
        onInsightReady,
        savePersona,
      },
      { insightGenerator: async () => [] },
    );

    const result = await scheduler.processEvent("ou_newcomer", {
      type: "timer",
      timestamp: now,
    });

    expect(result?.firstContact).toBe(true);
    expect(result?.sources).toEqual([]);
    expect(onInsightReady).toHaveBeenCalledTimes(1);
    expect(persona.feedbackProfile.firstContactAt).toBe(now);
    expect(savePersona).toHaveBeenCalledTimes(1);
  });

  it("never sends a second opening message", async () => {
    const persona = freshPersona(now);
    persona.feedbackProfile.firstContactAt = now - 1000;
    const onInsightReady = vi.fn(async () => true);
    const scheduler = new ProactiveScheduler(
      config,
      {
        loadPersona: async () => persona,
        onInsightReady,
        savePersona: async () => {},
      },
      { insightGenerator: async () => [] },
    );

    const result = await scheduler.processEvent("ou_newcomer", {
      type: "timer",
      timestamp: now,
    });

    expect(onInsightReady).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("does not record the greeting as delivered when delivery fails", async () => {
    const persona = freshPersona(now);
    const scheduler = new ProactiveScheduler(
      config,
      {
        loadPersona: async () => persona,
        onInsightReady: async () => false,
        savePersona: async () => {},
      },
      { insightGenerator: async () => [] },
    );

    const result = await scheduler.processEvent("ou_newcomer", {
      type: "timer",
      timestamp: now,
    });

    expect(result).toBeUndefined();
    expect(persona.feedbackProfile.firstContactAt).toBeUndefined();
  });

  it("can be disabled from config", async () => {
    const persona = freshPersona(now);
    const onInsightReady = vi.fn(async () => true);
    const scheduler = new ProactiveScheduler(
      config,
      {
        loadPersona: async () => persona,
        onInsightReady,
        savePersona: async () => {},
      },
      {
        insightGenerator: async () => [],
        botConfig: { cognitive: { proactive: { firstContactEnabled: false } } },
      },
    );

    await scheduler.processEvent("ou_newcomer", { type: "timer", timestamp: now });

    expect(onInsightReady).not.toHaveBeenCalled();
  });

  it("personalises the greeting with the configured name", async () => {
    const persona = freshPersona(now);
    let sent: string | undefined;
    const scheduler = new ProactiveScheduler(
      config,
      {
        loadPersona: async () => persona,
        onInsightReady: async (_agentId, _userId, candidate) => {
          sent = candidate.content;
          return true;
        },
        savePersona: async () => {},
      },
      {
        insightGenerator: async () => [],
        botConfig: { cognitive: { proactive: { firstContactName: "刘工" } } },
      },
    );

    await scheduler.processEvent("ou_newcomer", { type: "timer", timestamp: now });

    expect(sent).toContain("刘工");
  });
});
