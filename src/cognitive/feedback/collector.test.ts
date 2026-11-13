import { describe, it, expect } from "vitest";
import type { PersonaTree, InsightRecord } from "../types.js";
import {
  processInsightFeedback,
  processInsightDeliverySignal,
  processNoResponse,
  inferTopicFromContext,
  extractImplicitSignals,
  processImplicitFeedback,
  classifySentimentFromSignals,
  classifyResponseQuality,
  applyInsightReplyAttribution,
  INSIGHT_REPLY_WINDOW_MS,
} from "./collector.js";
import type { NoResponseContext } from "./collector.js";

function makePersona(overrides: Partial<PersonaTree["feedbackProfile"]> = {}): PersonaTree {
  return {
    identity: {
      coreTraits: {},
      expertDomains: [],
      interestDomains: [],
      curiosityDomains: [],
    },
    domains: {},
    recentFocus: [],
    feedbackProfile: {
      topicBandits: {
        "AI/机器学习": { alpha: 3, beta: 2 },
        软件架构: { alpha: 2, beta: 1 },
      },
      optimalFrequencyHours: 4,
      lastProactiveAt: 0,
      recentInsightIds: [],
      recentInsightContents: [],
      ...overrides,
    },
    rapport: {
      trustScore: 0.5,
      totalExchanges: 10,
      avgResponseLength: 50,
      selfDisclosureLevel: 0.3,
    },
    domainBlacklist: [],
    lifecycle: { stage: "new", lastActiveAt: 0, lastStageTransitionAt: 0, totalActiveDays: 0 },
    calibrationHistory: [],
    moodHistory: [],
  };
}

type InsightWithGateSnapshot = InsightRecord & {
  gateSnapshot?: { pAccept: number } | null;
};

function makeInsight(overrides: Partial<InsightWithGateSnapshot> = {}): InsightWithGateSnapshot {
  return {
    id: "insight-test",
    generatedAt: 1000,
    triggerSource: "scheduled",
    targetDomains: ["AI/机器学习"],
    sourceDomains: ["arxiv"],
    content: "Test insight",
    rationale: "Test rationale",
    sources: [],
    deliveredAt: 1500,
    ...overrides,
  };
}

function makeInsightWithVariant(overrides: Partial<InsightRecord> = {}): InsightRecord {
  return makeInsight({
    promptVariant: { fewShotSet: 1, frameIndex: 2, structureSeed: 42 },
    ...overrides,
  });
}

describe("processInsightFeedback", () => {
  it("increases bandit alpha for target domains on positive feedback", () => {
    const persona = makePersona();
    const insight = makeInsight({ targetDomains: ["AI/机器学习"] });

    const result = processInsightFeedback(persona, insight, "positive");

    expect(result.feedbackProfile.topicBandits["AI/机器学习"].alpha).toBe(4);
    expect(result.feedbackProfile.topicBandits["AI/机器学习"].beta).toBe(2);
  });

  it("increases bandit alpha for engaged feedback", () => {
    const persona = makePersona();
    const insight = makeInsight({ targetDomains: ["AI/机器学习"] });

    const result = processInsightFeedback(persona, insight, "engaged");

    expect(result.feedbackProfile.topicBandits["AI/机器学习"].alpha).toBe(4);
    expect(result.feedbackProfile.topicBandits["AI/机器学习"].beta).toBe(2);
  });

  it("increases bandit beta for target domains on negative feedback", () => {
    const persona = makePersona();
    const insight = makeInsight({ targetDomains: ["AI/机器学习"] });

    const result = processInsightFeedback(persona, insight, "negative");

    expect(result.feedbackProfile.topicBandits["AI/机器学习"].alpha).toBe(3);
    expect(result.feedbackProfile.topicBandits["AI/机器学习"].beta).toBe(3);
  });

  it("does not change bandits on neutral feedback", () => {
    const persona = makePersona();
    const insight = makeInsight({ targetDomains: ["AI/机器学习"] });

    const result = processInsightFeedback(persona, insight, "neutral");

    expect(result.feedbackProfile.topicBandits["AI/机器学习"]).toEqual({ alpha: 3, beta: 2 });
  });

  it("skips domains without existing bandits", () => {
    const persona = makePersona();
    const insight = makeInsight({ targetDomains: ["unknown-domain"] });

    const result = processInsightFeedback(persona, insight, "positive");

    expect(result.feedbackProfile.topicBandits["unknown-domain"]).toBeUndefined();
  });

  it("increases trust by 0.05 on engaged feedback", () => {
    const persona = makePersona();
    const insight = makeInsight();

    const result = processInsightFeedback(persona, insight, "engaged");

    expect(result.rapport.trustScore).toBeCloseTo(0.55);
  });

  it("increases trust by 0.03 on positive feedback", () => {
    const persona = makePersona();
    const insight = makeInsight();

    const result = processInsightFeedback(persona, insight, "positive");

    expect(result.rapport.trustScore).toBeCloseTo(0.53);
  });

  it("decreases trust by 0.05 on negative feedback", () => {
    const persona = makePersona();
    const insight = makeInsight();

    const result = processInsightFeedback(persona, insight, "negative");

    expect(result.rapport.trustScore).toBeCloseTo(0.45);
  });

  it("reduces optimalFrequencyHours on positive feedback", () => {
    const persona = makePersona({ optimalFrequencyHours: 5 });
    const insight = makeInsight();

    const result = processInsightFeedback(persona, insight, "positive");

    expect(result.feedbackProfile.optimalFrequencyHours).toBe(4.5);
  });

  it("increases optimalFrequencyHours on negative feedback", () => {
    const persona = makePersona({ optimalFrequencyHours: 5 });
    const insight = makeInsight();

    const result = processInsightFeedback(persona, insight, "negative");

    expect(result.feedbackProfile.optimalFrequencyHours).toBe(7);
  });

  it("clamps frequency to [1, 48] range", () => {
    const personaLow = makePersona({ optimalFrequencyHours: 1 });
    const insight = makeInsight();

    const resultLow = processInsightFeedback(personaLow, insight, "negative");
    expect(resultLow.feedbackProfile.optimalFrequencyHours).toBe(3);

    const personaHigh = makePersona({ optimalFrequencyHours: 47 });
    const resultHigh = processInsightFeedback(personaHigh, insight, "positive");
    expect(resultHigh.feedbackProfile.optimalFrequencyHours).toBe(46.5);

    const personaAtMax = makePersona({ optimalFrequencyHours: 46 });
    const resultAtMax = processInsightFeedback(personaAtMax, insight, "negative");
    expect(resultAtMax.feedbackProfile.optimalFrequencyHours).toBe(48);
  });

  it("updates lastProactiveAt from insight.deliveredAt", () => {
    const persona = makePersona({ lastProactiveAt: 100 });
    const insight = makeInsight({ deliveredAt: 500 });

    const result = processInsightFeedback(persona, insight, "positive");

    expect(result.feedbackProfile.lastProactiveAt).toBe(500);
  });

  it("preserves lastProactiveAt when insight has no deliveredAt", () => {
    const persona = makePersona({ lastProactiveAt: 100 });
    const insight = makeInsight({ deliveredAt: undefined });

    const result = processInsightFeedback(persona, insight, "positive");

    expect(result.feedbackProfile.lastProactiveAt).toBe(100);
  });

  it("does not mutate input persona", () => {
    const persona = makePersona();
    const originalBandits = { ...persona.feedbackProfile.topicBandits };
    const originalBanditRef = persona.feedbackProfile.topicBandits["AI/机器学习"];
    const originalTrust = persona.rapport.trustScore;
    const originalFreq = persona.feedbackProfile.optimalFrequencyHours;
    const insight = makeInsight();

    processInsightFeedback(persona, insight, "positive");

    expect(persona.feedbackProfile.topicBandits).toEqual(originalBandits);
    expect(persona.feedbackProfile.topicBandits["AI/机器学习"]).toBe(originalBanditRef);
    expect(persona.rapport.trustScore).toBe(originalTrust);
    expect(persona.feedbackProfile.optimalFrequencyHours).toBe(originalFreq);
  });

  it("updates prompt bandit alpha for all variant arms on positive feedback", () => {
    const persona = makePersona();
    const insight = makeInsightWithVariant();

    const result = processInsightFeedback(persona, insight, "positive");

    const pb = result.feedbackProfile.promptBandits!;
    expect(pb["fewShot:1"].alpha).toBe(3);
    expect(pb["fewShot:1"].beta).toBe(1);
    expect(pb["frame:2"].alpha).toBe(3);
    expect(pb["frame:2"].beta).toBe(1);
    expect(pb["seed:42"].alpha).toBe(3);
    expect(pb["seed:42"].beta).toBe(1);
  });

  it("updates prompt bandit beta for all variant arms on negative feedback", () => {
    const persona = makePersona();
    const insight = makeInsightWithVariant();

    const result = processInsightFeedback(persona, insight, "negative");

    const pb = result.feedbackProfile.promptBandits!;
    expect(pb["fewShot:1"].alpha).toBe(2);
    expect(pb["fewShot:1"].beta).toBe(2);
    expect(pb["frame:2"].alpha).toBe(2);
    expect(pb["frame:2"].beta).toBe(2);
    expect(pb["seed:42"].alpha).toBe(2);
    expect(pb["seed:42"].beta).toBe(2);
  });

  it("does not create prompt bandits when insight has no promptVariant", () => {
    const persona = makePersona();
    const insight = makeInsight();

    const result = processInsightFeedback(persona, insight, "positive");

    expect(result.feedbackProfile.promptBandits).toBeUndefined();
  });

  it("creates new arm entries when prompt bandit does not exist yet", () => {
    const persona = makePersona({
      promptBandits: { "fewShot:0": { alpha: 5, beta: 3, lastUpdated: 100 } },
    });
    const insight = makeInsightWithVariant();

    const result = processInsightFeedback(persona, insight, "engaged");

    const pb = result.feedbackProfile.promptBandits!;
    expect(pb["fewShot:0"]).toEqual({ alpha: 5, beta: 3, lastUpdated: 100 });
    expect(pb["fewShot:1"].alpha).toBe(3);
    expect(pb["frame:2"].alpha).toBe(3);
    expect(pb["seed:42"].alpha).toBe(3);
  });

  it("includes patternFrame arm when present in promptVariant", () => {
    const persona = makePersona();
    const insight = makeInsightWithVariant({
      promptVariant: { fewShotSet: 0, frameIndex: 1, patternFrame: 3 },
    });

    const result = processInsightFeedback(persona, insight, "positive");

    const pb = result.feedbackProfile.promptBandits!;
    expect(pb["fewShot:0"].alpha).toBe(3);
    expect(pb["frame:1"].alpha).toBe(3);
    expect(pb["pattern:3"].alpha).toBe(3);
    expect(pb["seed:3"]).toBeUndefined();
  });

  it("records calibration with the insight's gate snapshot pAccept", () => {
    const persona = makePersona();
    const insight = makeInsight({ gateSnapshot: { pAccept: 0.82 } });

    const result = processInsightFeedback(persona, insight, "positive");

    expect(result.calibrationHistory).toHaveLength(1);
    expect(result.calibrationHistory[0]).toMatchObject({
      insightId: "insight-test",
      predictedPAccept: 0.82,
      actualOutcome: "positive",
    });
  });

  it("falls back to 0.5 when the insight has no gate snapshot", () => {
    const persona = makePersona();
    const insight = makeInsight();

    const result = processInsightFeedback(persona, insight, "negative");

    expect(result.calibrationHistory[0]!.predictedPAccept).toBe(0.5);
  });

  it("ignores an invalid gate snapshot and falls back to 0.5", () => {
    const persona = makePersona();
    const insight = makeInsight({ gateSnapshot: { pAccept: Number.NaN } });

    const result = processInsightFeedback(persona, insight, "engaged");

    expect(result.calibrationHistory[0]!.predictedPAccept).toBe(0.5);
  });

  it("clamps an out-of-range gate pAccept into [0, 1]", () => {
    const insight = makeInsight({ gateSnapshot: { pAccept: 1.4 } });

    const result = processInsightFeedback(makePersona(), insight, "positive");

    expect(result.calibrationHistory[0]!.predictedPAccept).toBe(1);
  });
});

describe("processInsightDeliverySignal", () => {
  it("updates lastProactiveAt from insight.deliveredAt", () => {
    const persona = makePersona({ lastProactiveAt: 100 });
    const insight = makeInsight({ deliveredAt: 500 });

    const result = processInsightDeliverySignal(persona, insight);

    expect(result.feedbackProfile.lastProactiveAt).toBe(500);
  });

  it("keeps higher lastProactiveAt when persona already has a later timestamp", () => {
    const persona = makePersona({ lastProactiveAt: 900 });
    const insight = makeInsight({ deliveredAt: 500 });

    const result = processInsightDeliverySignal(persona, insight);

    expect(result.feedbackProfile.lastProactiveAt).toBe(900);
  });

  it("does not change bandits or trust", () => {
    const persona = makePersona();
    const insight = makeInsight({ deliveredAt: 500 });

    const result = processInsightDeliverySignal(persona, insight);

    expect(result.feedbackProfile.topicBandits).toEqual(persona.feedbackProfile.topicBandits);
    expect(result.rapport.trustScore).toBe(persona.rapport.trustScore);
    expect(result.feedbackProfile.optimalFrequencyHours).toBe(
      persona.feedbackProfile.optimalFrequencyHours,
    );
  });

  it("does not mutate input persona", () => {
    const persona = makePersona({ lastProactiveAt: 100 });
    const insight = makeInsight({ deliveredAt: 500 });

    processInsightDeliverySignal(persona, insight);

    expect(persona.feedbackProfile.lastProactiveAt).toBe(100);
  });
});

describe("processNoResponse", () => {
  it("without context only increments consecutiveNoResponses (backward compat)", () => {
    const persona = makePersona({ consecutiveNoResponses: 2 });

    const result = processNoResponse(persona);

    expect(result.feedbackProfile.consecutiveNoResponses).toBe(3);
    // bandits untouched
    expect(result.feedbackProfile.topicBandits).toEqual(persona.feedbackProfile.topicBandits);
    expect(result.feedbackProfile.modeBandits).toBeUndefined();
  });

  it("records a no_response calibration sample even without context", () => {
    const persona = makePersona({ lastProactiveAt: 777 });

    const result = processNoResponse(persona);

    expect(result.calibrationHistory[0]).toMatchObject({
      insightId: "no-response:777",
      predictedPAccept: 0.5,
      actualOutcome: "no_response",
    });
  });

  it("with domains — existing bandits get beta += 0.3", () => {
    const persona = makePersona();
    const ctx: NoResponseContext = { previousDomains: ["AI/机器学习"] };

    const result = processNoResponse(persona, ctx);

    const b = result.feedbackProfile.topicBandits["AI/机器学习"]!;
    expect(b.alpha).toBe(3);
    expect(b.beta).toBeCloseTo(2.3);
    expect(b.lastUpdated).toBeGreaterThan(0);
  });

  it("with domains — unknown domain gets cold-start bandit { alpha: 2, beta: 1.3 }", () => {
    const persona = makePersona();
    const ctx: NoResponseContext = { previousDomains: ["量子计算"] };

    const result = processNoResponse(persona, ctx);

    const b = result.feedbackProfile.topicBandits["量子计算"]!;
    expect(b.alpha).toBe(2);
    expect(b.beta).toBeCloseTo(1.3);
    expect(b.lastUpdated).toBeGreaterThan(0);
  });

  it("with mode — creates modeBandit with beta += 0.2", () => {
    const persona = makePersona();
    const ctx: NoResponseContext = { previousDomains: [], previousMode: "knowledge" };

    const result = processNoResponse(persona, ctx);

    const mb = result.feedbackProfile.modeBandits!["knowledge"]!;
    expect(mb.alpha).toBe(2);
    expect(mb.beta).toBeCloseTo(1.2);
    expect(mb.lastUpdated).toBeGreaterThan(0);
  });

  it("with domains + mode — both updated", () => {
    const persona = makePersona();
    const ctx: NoResponseContext = {
      previousDomains: ["AI/机器学习", "软件架构"],
      previousMode: "pattern",
    };

    const result = processNoResponse(persona, ctx);

    // topic bandits
    expect(result.feedbackProfile.topicBandits["AI/机器学习"]!.beta).toBeCloseTo(2.3);
    expect(result.feedbackProfile.topicBandits["软件架构"]!.beta).toBeCloseTo(1.3);
    // mode bandit
    expect(result.feedbackProfile.modeBandits!["pattern"]!.beta).toBeCloseTo(1.2);
    // counter incremented
    expect(result.feedbackProfile.consecutiveNoResponses).toBe(1);
  });

  it("does not mutate input persona (immutability)", () => {
    const persona = makePersona();
    const origBandits = { ...persona.feedbackProfile.topicBandits };
    const origAIRef = persona.feedbackProfile.topicBandits["AI/机器学习"];
    const ctx: NoResponseContext = { previousDomains: ["AI/机器学习"], previousMode: "knowledge" };

    processNoResponse(persona, ctx);

    expect(persona.feedbackProfile.topicBandits).toEqual(origBandits);
    expect(persona.feedbackProfile.topicBandits["AI/机器学习"]).toBe(origAIRef);
    expect(persona.feedbackProfile.modeBandits).toBeUndefined();
    expect(persona.calibrationHistory).toEqual([]);
  });

  it("always increments consecutiveNoResponses regardless of context", () => {
    const persona = makePersona({ consecutiveNoResponses: 4 });

    const withCtx = processNoResponse(persona, {
      previousDomains: ["AI/机器学习"],
      previousMode: "surprise",
    });
    expect(withCtx.feedbackProfile.consecutiveNoResponses).toBe(5);

    const withoutCtx = processNoResponse(persona);
    expect(withoutCtx.feedbackProfile.consecutiveNoResponses).toBe(5);
  });

  it("empty previousDomains — only mode update if provided", () => {
    const persona = makePersona();
    const ctx: NoResponseContext = { previousDomains: [], previousMode: "extend" };

    const result = processNoResponse(persona, ctx);

    // no new topic bandits
    expect(Object.keys(result.feedbackProfile.topicBandits)).toEqual(["AI/机器学习", "软件架构"]);
    // mode bandit created
    expect(result.feedbackProfile.modeBandits!["extend"]!.beta).toBeCloseTo(1.2);
    expect(result.feedbackProfile.consecutiveNoResponses).toBe(1);
  });

  it("writes a no_response calibration sample using the gate snapshot", () => {
    const persona = makePersona({
      lastProactiveAt: 1_700_000_000_000,
      recentInsightIds: ["insight-42"],
    });
    const ctx: NoResponseContext = {
      previousDomains: ["AI/机器学习"],
      gateSnapshot: { pAccept: 0.72 },
    };

    const result = processNoResponse(persona, ctx);

    expect(result.calibrationHistory).toHaveLength(1);
    expect(result.calibrationHistory[0]).toMatchObject({
      insightId: "insight-42",
      predictedPAccept: 0.72,
      actualOutcome: "no_response",
    });
  });

  it("prefers an explicit insightId in the context", () => {
    const persona = makePersona({ recentInsightIds: ["older-insight"] });

    const result = processNoResponse(persona, {
      previousDomains: [],
      insightId: "insight-7",
      gateSnapshot: { pAccept: 0.4 },
    });

    expect(result.calibrationHistory[0]).toMatchObject({
      insightId: "insight-7",
      predictedPAccept: 0.4,
    });
  });

  it("derives a stable id from lastProactiveAt and falls back to 0.5 without a snapshot", () => {
    const persona = makePersona({ lastProactiveAt: 1234 });

    const result = processNoResponse(persona, { previousDomains: [] });

    expect(result.calibrationHistory[0]).toMatchObject({
      insightId: "no-response:1234",
      predictedPAccept: 0.5,
      actualOutcome: "no_response",
    });
  });

  it("keeps at most 50 calibration records when appending silence samples", () => {
    const seed = Array.from({ length: 50 }, (_, i) => ({
      insightId: `seed-${i}`,
      predictedPAccept: 0.5,
      actualOutcome: "positive" as const,
      timestamp: i,
    }));
    const persona = makePersona();
    persona.calibrationHistory = seed;

    const result = processNoResponse(persona, { previousDomains: [] });

    expect(result.calibrationHistory).toHaveLength(50);
    expect(result.calibrationHistory[0]?.insightId).toBe("seed-1");
    expect(result.calibrationHistory.at(-1)?.actualOutcome).toBe("no_response");
  });
});

describe("inferTopicFromContext", () => {
  it("returns first LLM-extracted domain (Level 1)", () => {
    const persona = makePersona();
    const extraction = { domains: [{ name: "Rust" }, { name: "WebAssembly" }] };

    const result = inferTopicFromContext(persona, extraction, "some user text");

    expect(result).toBe("Rust");
  });

  it("returns undefined when extraction has empty domains and no fallbacks", () => {
    const persona = makePersona();
    const extraction = { domains: [] };

    const result = inferTopicFromContext(persona, extraction, "random text");

    expect(result).toBeUndefined();
  });

  it("falls back to persona domain keyword match (Level 2)", () => {
    const persona = makePersona();
    persona.domains = {
      量子计算: {
        depth: 2,
        recurrence: 1,
        lastMentioned: Date.now(),
        keyInsights: [],
        activeQuestions: [],
        negationSignals: 0,
      },
    };
    const extraction = { domains: [] as Array<{ name: string }> };

    const result = inferTopicFromContext(persona, extraction, "我在研究量子计算的应用");

    expect(result).toBe("量子计算");
  });

  it("falls back to persona recentFocus (Level 3)", () => {
    const persona = makePersona();
    persona.recentFocus = ["分布式系统"];
    const extraction = { domains: [] as Array<{ name: string }> };

    const result = inferTopicFromContext(persona, extraction, "some unrelated text");

    expect(result).toBe("分布式系统");
  });

  it("returns undefined when all levels exhausted", () => {
    const persona = makePersona();
    const extraction = { domains: [] as Array<{ name: string }> };

    const result = inferTopicFromContext(persona, extraction, "nothing matchable");

    expect(result).toBeUndefined();
  });
});

describe("extractImplicitSignals with previousTopics", () => {
  it("generates topic_continuation when topic matches recent topic", () => {
    const signals = extractImplicitSignals("tell me more about that", undefined, "AI/机器学习", [
      "AI/机器学习",
      "软件架构",
    ]);

    const continuation = signals.find((s) => s.type === "topic_continuation");
    expect(continuation).toBeDefined();
    expect(continuation!.topic).toBe("AI/机器学习");
    expect(continuation!.value).toBe(1);
  });

  it("generates topic_abandonment when topic differs from recent topics", () => {
    const signals = extractImplicitSignals(
      "let's switch to something else",
      undefined,
      "量子计算",
      ["AI/机器学习", "软件架构"],
    );

    const abandonment = signals.find((s) => s.type === "topic_abandonment");
    expect(abandonment).toBeDefined();
    // recentFocus is newest-first: the abandoned topic is the head, not the tail.
    expect(abandonment!.topic).toBe("AI/机器学习");
    expect(abandonment!.value).toBe(1);
  });

  it("regression: continuing the current topic does not emit abandonment (newest-first focus list)", () => {
    // The continuation window used to read slice(-3) — the three OLDEST
    // entries of the capped newest-first list — so a user repeating their
    // current topic got topic_abandonment (-0.02), cancelling the
    // response_length credit (+0.02) and freezing trust at the 0.1 floor.
    // Observed live: 12 exchanges, avgResponseLength 207, trustScore 0.1.
    const previousTopics = ["端侧模型", "小参数量模型", "RSI 递归自我改进", "旧话题A", "旧话题B"];
    const signals = extractImplicitSignals(
      "RSI 递归自我改进这个方向，为什么最近进展这么快？帮我盯紧新论文和benchmark突破，特别是能力跃升方面的。",
      undefined,
      "RSI 递归自我改进",
      previousTopics,
    );

    expect(signals.some((s) => s.type === "topic_continuation")).toBe(true);
    expect(signals.some((s) => s.type === "topic_abandonment")).toBe(false);
  });

  it("does not generate continuation/abandonment without previousTopics", () => {
    const signals = extractImplicitSignals("hello", undefined, "AI/机器学习");

    const continuation = signals.find((s) => s.type === "topic_continuation");
    const abandonment = signals.find((s) => s.type === "topic_abandonment");
    expect(continuation).toBeUndefined();
    expect(abandonment).toBeUndefined();
  });

  it("does not generate continuation/abandonment without topic", () => {
    const signals = extractImplicitSignals("hello", undefined, undefined, ["AI/机器学习"]);

    const continuation = signals.find((s) => s.type === "topic_continuation");
    const abandonment = signals.find((s) => s.type === "topic_abandonment");
    expect(continuation).toBeUndefined();
    expect(abandonment).toBeUndefined();
  });

  it("still generates response_length and question_depth signals", () => {
    const signals = extractImplicitSignals("为什么这个设计是这样的？", undefined, "AI/机器学习", [
      "AI/机器学习",
    ]);

    expect(signals.some((s) => s.type === "response_length")).toBe(true);
    expect(signals.some((s) => s.type === "question_depth")).toBe(true);
    expect(signals.some((s) => s.type === "topic_continuation")).toBe(true);
  });

  it("regex fix: does NOT trigger question_depth for plain English (old char-class bug)", () => {
    const signals = extractImplicitSignals("hello world thanks", undefined, "AI/机器学习", [
      "AI/机器学习",
    ]);

    expect(signals.some((s) => s.type === "question_depth")).toBe(false);
  });
});

describe("extractImplicitSignals responseLatencyMs", () => {
  it("accepts a real latency through the named-options form", () => {
    const signals = extractImplicitSignals("hello", {
      responseLatencyMs: 12_000,
      topic: "AI/机器学习",
    });

    const latency = signals.find((s) => s.type === "response_latency");
    expect(latency?.value).toBe(12_000);
    expect(latency?.topic).toBe("AI/机器学习");
  });

  it("still accepts the legacy positional latency argument", () => {
    const signals = extractImplicitSignals("hello", 5_000, "AI/机器学习");

    expect(signals.find((s) => s.type === "response_latency")?.value).toBe(5_000);
  });

  it("ignores a non-finite or negative latency", () => {
    expect(
      extractImplicitSignals("hello", { responseLatencyMs: Number.NaN }).some(
        (s) => s.type === "response_latency",
      ),
    ).toBe(false);
    expect(
      extractImplicitSignals("hello", { responseLatencyMs: -1 }).some(
        (s) => s.type === "response_latency",
      ),
    ).toBe(false);
  });
});

describe("processImplicitFeedback with response_length/question_depth bandit updates", () => {
  it("reinforces bandit alpha for long responses (>100 chars)", () => {
    const persona = makePersona();
    const signals = [
      { type: "response_length" as const, topic: "AI/机器学习", value: 200, timestamp: Date.now() },
    ];

    const result = processImplicitFeedback(persona, signals);

    expect(result.feedbackProfile.topicBandits["AI/机器学习"]!.alpha).toBeCloseTo(3.3);
    expect(result.feedbackProfile.topicBandits["AI/机器学习"]!.beta).toBe(2);
  });

  it("penalizes bandit beta for very short responses (<20 chars)", () => {
    const persona = makePersona();
    const signals = [
      { type: "response_length" as const, topic: "AI/机器学习", value: 10, timestamp: Date.now() },
    ];

    const result = processImplicitFeedback(persona, signals);

    expect(result.feedbackProfile.topicBandits["AI/机器学习"]!.alpha).toBe(3);
    expect(result.feedbackProfile.topicBandits["AI/机器学习"]!.beta).toBeCloseTo(2.2);
  });

  it("reinforces bandit alpha for deep follow-up questions", () => {
    const persona = makePersona();
    const signals = [
      { type: "question_depth" as const, topic: "AI/机器学习", value: 1, timestamp: Date.now() },
    ];

    const result = processImplicitFeedback(persona, signals);

    expect(result.feedbackProfile.topicBandits["AI/机器学习"]!.alpha).toBeCloseTo(3.4);
    expect(result.feedbackProfile.topicBandits["AI/机器学习"]!.beta).toBe(2);
  });

  it("does not update bandits for medium-length responses (20-100)", () => {
    const persona = makePersona();
    const signals = [
      { type: "response_length" as const, topic: "AI/机器学习", value: 50, timestamp: Date.now() },
    ];

    const result = processImplicitFeedback(persona, signals);

    expect(result.feedbackProfile.topicBandits["AI/机器学习"]).toEqual({ alpha: 3, beta: 2 });
  });

  it("creates new bandit arm for unknown topic on long response", () => {
    const persona = makePersona();
    const signals = [
      { type: "response_length" as const, topic: "量子计算", value: 200, timestamp: Date.now() },
    ];

    const result = processImplicitFeedback(persona, signals);

    expect(result.feedbackProfile.topicBandits["量子计算"]).toBeDefined();
    expect(result.feedbackProfile.topicBandits["量子计算"]!.alpha).toBeCloseTo(2.3);
    expect(result.feedbackProfile.topicBandits["量子计算"]!.beta).toBe(1);
  });

  it("combines topic_continuation and response_length reinforcement", () => {
    const persona = makePersona();
    const signals = [
      {
        type: "topic_continuation" as const,
        topic: "AI/机器学习",
        value: 1,
        timestamp: Date.now(),
      },
      { type: "response_length" as const, topic: "AI/机器学习", value: 200, timestamp: Date.now() },
    ];

    const result = processImplicitFeedback(persona, signals);

    // topic_continuation: alpha +0.5, response_length >100: alpha +0.3 = total +0.8
    expect(result.feedbackProfile.topicBandits["AI/机器学习"]!.alpha).toBeCloseTo(3.8);
  });
});

describe("classifySentimentFromSignals", () => {
  it("returns 'engaged' for long responses (>100 chars)", () => {
    const signals = extractImplicitSignals("x".repeat(150), undefined, "AI/机器学习");
    expect(classifySentimentFromSignals(signals)).toBe("engaged");
  });

  it("returns 'engaged' when question_depth is present even with short response", () => {
    const signals = extractImplicitSignals("为什么？", undefined, "AI/机器学习");
    expect(classifySentimentFromSignals(signals)).toBe("engaged");
  });

  it("returns 'negative' for very short responses (<20 chars) without question_depth", () => {
    const signals = extractImplicitSignals("ok", undefined, "AI/机器学习");
    expect(classifySentimentFromSignals(signals)).toBe("negative");
  });

  it("returns 'neutral' for medium-length responses (20-100 chars) without question_depth", () => {
    const signals = extractImplicitSignals(
      "This is a medium length response with no deep question.",
      undefined,
      "AI/机器学习",
    );
    expect(classifySentimentFromSignals(signals)).toBe("neutral");
  });

  it("returns 'neutral' for empty signals array", () => {
    expect(classifySentimentFromSignals([])).toBe("neutral");
  });

  it("prioritizes engaged over negative when both long-response and short-response somehow present", () => {
    const signals = [
      { type: "response_length" as const, topic: "test", value: 5, timestamp: Date.now() },
      { type: "question_depth" as const, topic: "test", value: 1, timestamp: Date.now() },
    ];
    expect(classifySentimentFromSignals(signals)).toBe("engaged");
  });
});

// ── Insight-reply attribution (goal 洞察投放人化重构 Phase 3) ────────

describe("classifyResponseQuality", () => {
  it("engaged: long reply", () => {
    expect(
      classifyResponseQuality(
        "这个问题很有意思,我想了很久,我觉得可以从三个角度来展开讨论,首先是概念层面,其次是实践层面".repeat(
          3,
        ),
      ),
    ).toBe("engaged");
  });

  it("engaged: deep follow-up question even when short", () => {
    expect(classifyResponseQuality("为什么会这样?")).toBe("engaged");
  });

  it("dismissive: very short reply", () => {
    expect(classifyResponseQuality("嗯")).toBe("dismissive");
    expect(classifyResponseQuality("ok")).toBe("dismissive");
  });

  it("normal: medium reply", () => {
    expect(classifyResponseQuality("这个观点不错,我回头看看相关的资料再说。")).toBe("normal");
  });
});

describe("applyInsightReplyAttribution", () => {
  const NOW = 1_700_000_005_000;
  const base = {
    lastProactiveAt: NOW - 3_600_000,
    recentInsightDomains: [["AI/机器学习", "认知科学"]],
  };

  it("engaged reply rewards the insight's domain bandits and tightens frequency", () => {
    const persona = makePersona(base);
    const next = applyInsightReplyAttribution(
      persona,
      "这个洞察很有意思,为什么认知科学和机器学习会有这样的交叉?我想深入了解一下背后的机制",
      NOW,
    );
    expect(next.feedbackProfile.topicBandits["AI/机器学习"]!.alpha).toBeCloseTo(3.5, 5);
    expect(next.feedbackProfile.topicBandits["认知科学"]!.alpha).toBeCloseTo(2.5, 5);
    expect(next.feedbackProfile.optimalFrequencyHours).toBeCloseTo(3.75, 5);
  });

  it("dismissive reply penalizes the insight's domain bandits and loosens frequency", () => {
    const persona = makePersona(base);
    const next = applyInsightReplyAttribution(persona, "嗯", NOW);
    expect(next.feedbackProfile.topicBandits["AI/机器学习"]!.beta).toBeCloseTo(2.4, 5);
    expect(next.feedbackProfile.optimalFrequencyHours).toBeCloseTo(5, 5);
  });

  it("normal reply leaves bandits untouched", () => {
    const persona = makePersona(base);
    const next = applyInsightReplyAttribution(
      persona,
      "这个观点不错,我回头看看相关的资料再说。",
      NOW,
    );
    expect(next).toBe(persona);
  });

  it("no attribution outside the 48h reply window", () => {
    const persona = makePersona({
      ...base,
      lastProactiveAt: NOW - (INSIGHT_REPLY_WINDOW_MS + 1),
    });
    const next = applyInsightReplyAttribution(persona, "嗯", NOW);
    expect(next).toBe(persona);
  });

  it("no attribution without delivered-insight domains", () => {
    const persona = makePersona({ lastProactiveAt: NOW - 3_600_000 });
    const next = applyInsightReplyAttribution(persona, "嗯", NOW);
    expect(next).toBe(persona);
  });
});
