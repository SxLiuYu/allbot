import { describe, expect, it } from "vitest";
import type { InsightCandidate } from "../cognitive/insight/types.js";
import { bumpDailySend } from "../cognitive/scheduler/delivery-pacing.js";
import type { FeedbackProfile, PersonaTree } from "../cognitive/types.js";
import {
  applyUndeliveredInsightOutcome,
  createInsightRecord,
  mergeSchedulerFeedbackProfile,
  resolveInsightTriggerSource,
} from "./cognitive-persona-merge.js";

function baseProfile(overrides: Partial<FeedbackProfile> = {}): FeedbackProfile {
  return {
    topicBandits: {},
    optimalFrequencyHours: 48,
    lastProactiveAt: 0,
    recentInsightIds: [],
    recentInsightContents: [],
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<InsightCandidate> = {}): InsightCandidate {
  return {
    id: "c1",
    content: "content",
    rationale: "rationale",
    targetDomains: ["ai"],
    sourceDomains: ["ml"],
    relevanceScore: 0.8,
    surpriseScore: 0.7,
    compositeScore: 0.75,
    sources: [{ url: "https://example.com", title: "source", credibility: 0.9 }],
    verificationStatus: "verified",
    ...overrides,
  };
}

function makePersona(profile: FeedbackProfile): PersonaTree {
  return { feedbackProfile: profile } as unknown as PersonaTree;
}

describe("mergeSchedulerFeedbackProfile", () => {
  it("keeps reply-path-owned fields from current (bandits, ledger, frequency, suppression)", () => {
    const current = baseProfile({
      topicBandits: { ai: { alpha: 3, beta: 1, lastUpdated: 2 } },
      promptBandits: { v1: { alpha: 1, beta: 0, lastUpdated: 3 } },
      modeBandits: { pattern: { alpha: 2, beta: 2, lastUpdated: 4 } },
      optimalFrequencyHours: 24,
      suppressUntil: 123,
      consecutiveNoResponses: 0,
      lastNoResponseAt: undefined,
    });
    const snapshot = baseProfile({
      topicBandits: {},
      optimalFrequencyHours: 48,
      consecutiveNoResponses: 3,
      lastNoResponseAt: 999,
    });

    const merged = mergeSchedulerFeedbackProfile(current, snapshot);

    // A user reply reset the ledger mid-resolve; the scheduler's stale
    // snapshot must NOT resurrect it (hard-veto invariant).
    expect(merged.consecutiveNoResponses).toBe(0);
    expect(merged.lastNoResponseAt).toBeUndefined();
    expect(merged.topicBandits).toEqual(current.topicBandits);
    expect(merged.promptBandits).toEqual(current.promptBandits);
    expect(merged.modeBandits).toEqual(current.modeBandits);
    expect(merged.optimalFrequencyHours).toBe(24);
    expect(merged.suppressUntil).toBe(123);
  });

  it("copies scheduler-owned pacing/dedup fields from the snapshot", () => {
    const current = baseProfile({
      pendingInsightDelivery: null,
      awaitingDeliveryConfirmation: null,
      dailySendCount: 0,
    });
    const snapshot = baseProfile({
      lastProactiveAt: 500,
      pendingInsightDelivery: {
        candidate: { id: "c1" } as never,
        generatedAt: 400,
        opportunityType: "cross_domain",
      },
      awaitingDeliveryConfirmation: {
        candidate: { id: "c1" } as never,
        opportunityType: "cross_domain",
        eventTimestamp: 500,
      },
      recentInsightIds: ["c1"],
      recentInsightContents: ["content"],
      recentInsightDomains: [["ai"]],
      recentInsightTypes: ["cross_domain"],
      recentInsightModes: ["surprise"],
      recentInsightQueryHistory: ["q"],
      consecutiveResolveFailures: 2,
      dailySendAnchorDay: 20,
      dailySendCount: 1,
      lastReEngageAttemptAt: 300,
    });

    const merged = mergeSchedulerFeedbackProfile(current, snapshot);

    expect(merged.lastProactiveAt).toBe(500);
    expect(merged.pendingInsightDelivery).toEqual(snapshot.pendingInsightDelivery);
    expect(merged.awaitingDeliveryConfirmation).toEqual(snapshot.awaitingDeliveryConfirmation);
    expect(merged.recentInsightIds).toEqual(["c1"]);
    expect(merged.recentInsightContents).toEqual(["content"]);
    expect(merged.recentInsightDomains).toEqual([["ai"]]);
    expect(merged.recentInsightTypes).toEqual(["cross_domain"]);
    expect(merged.recentInsightModes).toEqual(["surprise"]);
    expect(merged.recentInsightQueryHistory).toEqual(["q"]);
    expect(merged.consecutiveResolveFailures).toBe(2);
    expect(merged.dailySendAnchorDay).toBe(20);
    expect(merged.dailySendCount).toBe(1);
    expect(merged.lastReEngageAttemptAt).toBe(300);
  });

  it("takes the newer lastProactiveAt instead of overwriting it with the stale snapshot", () => {
    const current = baseProfile({ lastProactiveAt: 900 });
    const snapshot = baseProfile({ lastProactiveAt: 500 });

    const merged = mergeSchedulerFeedbackProfile(current, snapshot);

    expect(merged.lastProactiveAt).toBe(900);
  });

  it("takes the newer lastReEngageAttemptAt from either side", () => {
    const current = baseProfile({ lastReEngageAttemptAt: 900 });
    const snapshot = baseProfile({ lastReEngageAttemptAt: 500 });

    expect(mergeSchedulerFeedbackProfile(current, snapshot).lastReEngageAttemptAt).toBe(900);
    expect(
      mergeSchedulerFeedbackProfile(
        baseProfile({ lastReEngageAttemptAt: 500 }),
        baseProfile({ lastReEngageAttemptAt: 900 }),
      ).lastReEngageAttemptAt,
    ).toBe(900);
  });

  it("unions recent insight windows written on both sides of the resolve loop", () => {
    const current = baseProfile({
      recentInsightIds: ["a", "b", "c"],
      recentInsightContents: ["one", "two", "three"],
      recentInsightDomains: [["ai"], ["bio"]],
      recentInsightTypes: ["timer", "info_scan"],
      recentInsightModes: ["surprise", "pattern"],
      recentInsightQueryHistory: ["q1", "q2"],
    });
    // Snapshot predates the resolve loop; it shares the prefix and lacks the
    // entries written meanwhile.
    const snapshot = baseProfile({
      recentInsightIds: ["a", "b"],
      recentInsightContents: ["one", "two"],
      recentInsightDomains: [["ai"]],
      recentInsightTypes: ["timer"],
      recentInsightModes: ["surprise"],
      recentInsightQueryHistory: ["q1"],
    });

    const merged = mergeSchedulerFeedbackProfile(current, snapshot);

    expect(merged.recentInsightIds).toEqual(["a", "b", "c"]);
    expect(merged.recentInsightContents).toEqual(["one", "two", "three"]);
    expect(merged.recentInsightDomains).toEqual([["ai"], ["bio"]]);
    expect(merged.recentInsightTypes).toEqual(["timer", "info_scan"]);
    expect(merged.recentInsightModes).toEqual(["surprise", "pattern"]);
    expect(merged.recentInsightQueryHistory).toEqual(["q1", "q2"]);
  });

  it("keeps snapshot-only entries that current has already truncated away", () => {
    const snapshot = baseProfile({ recentInsightContents: ["a", "b", "c"] });
    const current = baseProfile({ recentInsightContents: ["a", "b"] });

    const merged = mergeSchedulerFeedbackProfile(current, snapshot);

    expect(merged.recentInsightContents).toEqual(["a", "b", "c"]);
  });

  it("truncates the union to the newest entries of each window", () => {
    const snapshotContents = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const currentContents = [...snapshotContents, "s10", "s11", "s12"];
    const snapshotIds = Array.from({ length: 20 }, (_, i) => `id${i}`);
    const currentIds = [...snapshotIds, "id20"];

    const merged = mergeSchedulerFeedbackProfile(
      baseProfile({ recentInsightContents: currentContents, recentInsightIds: currentIds }),
      baseProfile({ recentInsightContents: snapshotContents, recentInsightIds: snapshotIds }),
    );

    expect(merged.recentInsightContents).toEqual([
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
      "s9",
      "s10",
      "s11",
      "s12",
    ]);
    expect(merged.recentInsightIds).toHaveLength(20);
    expect(merged.recentInsightIds[0]).toBe("id1");
    expect(merged.recentInsightIds.at(-1)).toBe("id20");
  });
});

describe("resolveInsightTriggerSource", () => {
  it("maps timer ticks (and unknown events) to scheduled", () => {
    expect(resolveInsightTriggerSource("timer")).toBe("scheduled");
    expect(resolveInsightTriggerSource(undefined)).toBe("scheduled");
  });

  it("maps event-source triggers to event", () => {
    for (const type of [
      "persona_change",
      "info_scan",
      "evolution_scan",
      "activity_scan",
      "external",
    ] as const) {
      expect(resolveInsightTriggerSource(type)).toBe("event");
    }
  });
});

describe("createInsightRecord", () => {
  it("stores the real trigger source and omits deliveredAt until delivery", () => {
    const candidate = makeCandidate({ resolvedMode: "surprise" });

    const record = createInsightRecord(candidate, "event", 1234);

    expect(record.triggerSource).toBe("event");
    expect(record.generatedAt).toBe(1234);
    expect(record.deliveredAt).toBeUndefined();
    expect(record.resolvedMode).toBe("surprise");
    expect(record.content).toBe(candidate.content);
    expect(record.sources).toEqual(candidate.sources);
  });

  it("persists the gate snapshot used as the calibration prediction", () => {
    const candidate = makeCandidate({ gateSnapshot: { pAccept: 0.73 } });

    const record = createInsightRecord(candidate, "event", 1234);

    expect(record.gateSnapshot).toEqual({ pAccept: 0.73 });
  });
});

describe("applyUndeliveredInsightOutcome", () => {
  it("keeps the insight pending without advancing pacing or dedup state", () => {
    const profile = baseProfile({
      lastProactiveAt: 500,
      recentInsightIds: ["a"],
      recentInsightContents: ["one"],
      recentInsightDomains: [["ai"]],
    });
    const persona = makePersona(profile);
    const record = createInsightRecord(makeCandidate({ id: "c9" }), "event", 700);

    applyUndeliveredInsightOutcome(persona, "c9", record);

    expect(persona.feedbackProfile.pendingInsightDelivery).toMatchObject({
      generatedAt: 700,
      opportunityType: "redelivery",
      attemptCount: 1,
    });
    expect(persona.feedbackProfile.pendingInsightDelivery?.candidate.id).toBe("c9");
    // Undelivered insight must not consume the pacing/dedup window.
    expect(persona.feedbackProfile.lastProactiveAt).toBe(500);
    expect(persona.feedbackProfile.recentInsightIds).toEqual(["a"]);
    expect(persona.feedbackProfile.recentInsightContents).toEqual(["one"]);
    expect(persona.feedbackProfile.recentInsightDomains).toEqual([["ai"]]);
  });

  it("clears the awaiting confirmation for the failed insight and increments attempts", () => {
    const profile = baseProfile({
      awaitingDeliveryConfirmation: {
        candidate: { id: "c9" } as never,
        opportunityType: "cross_domain",
        eventTimestamp: 660,
      },
      pendingInsightDelivery: {
        candidate: { id: "c9" } as never,
        generatedAt: 650,
        opportunityType: "cross_domain",
        attemptCount: 1,
      },
    });
    const persona = makePersona(profile);
    const record = createInsightRecord(makeCandidate({ id: "c9" }), "event", 700);

    applyUndeliveredInsightOutcome(persona, "c9", record);

    expect(persona.feedbackProfile.awaitingDeliveryConfirmation).toBeNull();
    expect(persona.feedbackProfile.pendingInsightDelivery).toMatchObject({
      generatedAt: 660,
      opportunityType: "cross_domain",
      attemptCount: 2,
    });
  });

  it("releases the dedup slot and daily send when the channel rejects an enqueued insight", () => {
    const now = Date.now();
    const persona = makePersona(
      baseProfile({
        recentInsightDomains: [["ai"], ["bio"]],
        recentInsightTypes: ["cross_domain", "domain_depth"],
      }),
    );
    const candidate = makeCandidate({ id: "c10", targetDomains: ["bio"] });
    persona.feedbackProfile.awaitingDeliveryConfirmation = {
      candidate,
      opportunityType: "domain_depth",
      eventTimestamp: now,
    };
    bumpDailySend(persona, now);

    applyUndeliveredInsightOutcome(
      persona,
      "c10",
      createInsightRecord(candidate, "event", now),
    );

    expect(persona.feedbackProfile.recentInsightDomains).toEqual([["ai"]]);
    expect(persona.feedbackProfile.recentInsightTypes).toEqual(["cross_domain"]);
    expect(persona.feedbackProfile.dailySendCount).toBe(0);
  });

  it("does not replace a newer pending insight with an older failed one", () => {    const pendingCandidate = { id: "newer" } as never;
    const persona = makePersona(
      baseProfile({
        pendingInsightDelivery: {
          candidate: pendingCandidate,
          generatedAt: 900,
          opportunityType: "timer",
          attemptCount: 0,
        },
      }),
    );
    const record = createInsightRecord(makeCandidate({ id: "older" }), "event", 700);

    applyUndeliveredInsightOutcome(persona, "older", record);

    expect(persona.feedbackProfile.pendingInsightDelivery).toMatchObject({
      candidate: pendingCandidate,
      generatedAt: 900,
      opportunityType: "timer",
    });
  });
});
