import { describe, expect, it } from "vitest";
import { safeParsePersona } from "../persona/persona-schema.js";
import { createDefaultPersona } from "../persona/store.js";
import type { PersonaTree, ProactiveOutcome, ProactiveOutcomeResponse } from "../types.js";
import {
  FATIGUE_NEGATIVE_MUTE_MS,
  FATIGUE_SILENCE_AFTER_NON_SUBSTANTIVE,
  FATIGUE_TOPIC_REPEAT_MS,
  OUTCOME_RESOLVE_GRACE_MS,
  appendProactiveOutcome,
  computeIgnoreRate,
  detectTopicMuteIntent,
  evaluateFatigueBrake,
  filterFatiguedOpportunities,
  getMutedDomains,
  mergeProactiveOutcomes,
  muteTopicsFromText,
  withMutedTopics,
  withOutcomeResponse,
} from "./fatigue-brake.js";
import type { Opportunity } from "./types.js";

const HR = 3_600_000;
const DAY = 24 * HR;
const NOW = 1_800_000_000_000;

function personaWithOutcomes(
  responses: Array<[ProactiveOutcomeResponse, number, string[]]>,
): PersonaTree {
  const persona = createDefaultPersona();
  persona.feedbackProfile.proactiveOutcomes = responses.map(([response, at, domains], i) => ({
    at,
    insightId: `i-${i}`,
    domains,
    response,
    ...(response === "pending" ? {} : { resolvedAt: Math.min(at + OUTCOME_RESOLVE_GRACE_MS, NOW) }),
  }));
  return persona;
}

function opportunity(targetDomains: string[]): Opportunity {
  return {
    type: "domain_depth",
    targetDomains,
    sourceDomains: [],
    pNeed: 0.8,
    pAccept: 0.8,
    pAct: 0.8,
  };
}

describe("fatigue brake outcome ledger", () => {
  it("persists timestamped outcomes through the persona schema", () => {
    const persona = createDefaultPersona();
    appendProactiveOutcome(persona, {
      at: NOW,
      insightId: "insight-1",
      domains: ["Rust"],
      response: "pending",
    });
    const parsed = safeParsePersona(JSON.parse(JSON.stringify(persona)));
    expect(parsed?.feedbackProfile.proactiveOutcomes).toEqual([
      { at: NOW, insightId: "insight-1", domains: ["Rust"], response: "pending" },
    ]);
  });

  it("does not double-append the same delivered insight", () => {
    const persona = createDefaultPersona();
    const outcome: ProactiveOutcome = {
      at: NOW,
      insightId: "same",
      domains: ["Rust"],
      response: "pending",
    };
    appendProactiveOutcome(persona, outcome);
    appendProactiveOutcome(persona, outcome);
    expect(persona.feedbackProfile.proactiveOutcomes).toHaveLength(1);
  });

  it("prefers explicit negative feedback over a late no-response penalty", () => {
    const persona = personaWithOutcomes([["pending", NOW - 3 * HR, ["Rust"]]]);
    const negative = withOutcomeResponse(persona, NOW - 3 * HR, "negative", NOW);
    const ignored = withOutcomeResponse(negative, NOW - 3 * HR, "ignored", NOW);
    expect(ignored.feedbackProfile.proactiveOutcomes?.[0]?.response).toBe("negative");
  });

  it("merges reply-path resolved outcomes over stale scheduler snapshots", () => {
    const snapshot = [{ at: NOW, insightId: "i", domains: ["Rust"], response: "pending" as const }];
    const current = [
      {
        at: NOW,
        insightId: "i",
        domains: ["Rust"],
        response: "engaged" as const,
        resolvedAt: NOW + HR,
      },
    ];
    expect(mergeProactiveOutcomes(current, snapshot)[0]?.response).toBe("engaged");
  });
});

describe("rolling 7-day ignore rate", () => {
  it("ignores outcomes outside the 7-day window and requires 3 samples", () => {
    const persona = personaWithOutcomes([
      ["ignored", NOW - 10 * DAY, ["A"]],
      ["ignored", NOW - 2 * DAY, ["A"]],
      ["ignored", NOW - DAY, ["A"]],
    ]);
    expect(computeIgnoreRate(persona, NOW).samples).toBe(2);
    expect(evaluateFatigueBrake(persona, NOW).thresholdBoost).toBe(0);
  });

  it("raises the gate threshold at 50% ignored and pauses at 67%", () => {
    const mild = personaWithOutcomes([
      ["ignored", NOW - 5 * HR, ["A"]],
      ["ignored", NOW - 4 * HR, ["A"]],
      ["normal", NOW - 3 * HR, ["A"]],
      ["engaged", NOW - 2 * HR, ["A"]],
    ]);
    const mildVerdict = evaluateFatigueBrake(mild, NOW);
    expect(mildVerdict.allowed).toBe(true);
    expect(mildVerdict.thresholdBoost).toBe(0.1);

    const severe = personaWithOutcomes([
      ["ignored", NOW - 5 * HR, ["A"]],
      ["ignored", NOW - 4 * HR, ["A"]],
      ["normal", NOW - 3 * HR, ["A"]],
    ]);
    const severeVerdict = evaluateFatigueBrake(severe, NOW);
    expect(severeVerdict.allowed).toBe(false);
    expect(severeVerdict.reason).toContain("paused");
  });

  it("pauses 24h on a single explicit negative feedback", () => {
    const persona = personaWithOutcomes([["negative", NOW - 10 * 60_000, ["A"]]]);
    persona.lifecycle.lastActiveAt = NOW - 10 * 60_000;
    const verdict = evaluateFatigueBrake(persona, NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("explicit negative");
    expect(verdict.samples).toBe(1);
  });

  it("releases the explicit-negative pause after the user re-engages", () => {
    const persona = personaWithOutcomes([["negative", NOW - 10 * 60_000, ["A"]]]);
    const outcome = persona.feedbackProfile.proactiveOutcomes?.[0];
    if (outcome) {
      outcome.resolvedAt = NOW - 10 * 60_000;
    }
    persona.lifecycle.lastActiveAt = NOW - 5 * 60_000;
    const verdict = evaluateFatigueBrake(persona, NOW);
    expect(verdict.allowed).toBe(true);
  });

  it("ages pending outcomes into ignored after the reply grace window", () => {
    const persona = personaWithOutcomes([
      ["pending", NOW - 4 * HR, ["A"]],
      ["pending", NOW - 3 * HR, ["A"]],
      ["pending", NOW - 2 * HR - 1, ["A"]],
    ]);
    expect(computeIgnoreRate(persona, NOW).rate).toBe(1);
    expect(evaluateFatigueBrake(persona, NOW).allowed).toBe(false);
  });

  it(`silences for 2h after ${FATIGUE_SILENCE_AFTER_NON_SUBSTANTIVE} consecutive bad outcomes`, () => {
    // 3/5 = 0.60 stays below the 24h pause rule, isolating the streak rule.
    const persona = personaWithOutcomes([
      ["engaged", NOW - 50 * 60_000, ["A"]],
      ["normal", NOW - 40 * 60_000, ["A"]],
      ["dismissive", NOW - 30 * 60_000, ["A"]],
      ["ignored", NOW - 20 * 60_000, ["B"]],
      ["dismissive", NOW - 10 * 60_000, ["C"]],
    ]);
    const verdict = evaluateFatigueBrake(persona, NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("consecutive non-substantive");
  });

  it("does not silence when the latest reply was substantive", () => {
    // 2/5 = 0.40 stays below the threshold-boost band too.
    const persona = personaWithOutcomes([
      ["engaged", NOW - 50 * 60_000, ["A"]],
      ["normal", NOW - 40 * 60_000, ["A"]],
      ["ignored", NOW - 30 * 60_000, ["A"]],
      ["dismissive", NOW - 20 * 60_000, ["B"]],
      ["engaged", NOW - 10 * 60_000, ["C"]],
    ]);
    expect(evaluateFatigueBrake(persona, NOW).allowed).toBe(true);
  });
});

describe("topic cooldowns and negative feedback", () => {
  it("blocks a domain pushed within 24h and two consecutive same-interest pushes", () => {
    const persona = personaWithOutcomes([
      ["normal", NOW - 2 * HR, ["Rust"]],
      ["normal", NOW - HR, ["Rust"]],
    ]);
    const muted = getMutedDomains(persona, NOW);
    expect(muted).toContain("rust");
    expect(filterFatiguedOpportunities([opportunity(["rust"])], muted)).toHaveLength(0);
    expect(filterFatiguedOpportunities([opportunity(["Design"])], muted)).toHaveLength(1);
  });

  it("releases a topic after 24h", () => {
    const persona = personaWithOutcomes([["normal", NOW - FATIGUE_TOPIC_REPEAT_MS - 1, ["Rust"]]]);
    expect(getMutedDomains(persona, NOW)).not.toContain("rust");
  });

  it("detects plain-text negative feedback and mutes the delivered topic for 7 days", () => {
    expect(detectTopicMuteIntent("别再推这个")).toBe(true);
    expect(detectTopicMuteIntent("不感兴趣")).toBe(true);
    expect(detectTopicMuteIntent("这条没用，别推了")).toBe(true);
    expect(detectTopicMuteIntent("别推了")).toBe(true);
    expect(detectTopicMuteIntent("这个观点挺有意思")).toBe(false);

    const persona = personaWithOutcomes([["pending", NOW - 5 * 60_000, ["Rust"]]]);
    const muted = muteTopicsFromText(persona, "别再推这个", NOW);
    expect(muted.feedbackProfile.proactiveOutcomes?.[0]?.response).toBe("negative");
    expect(muted.feedbackProfile.topicMutedUntil?.rust).toBe(NOW + FATIGUE_NEGATIVE_MUTE_MS);
    expect(getMutedDomains(muted, NOW + FATIGUE_NEGATIVE_MUTE_MS - 1)).toContain("rust");
    expect(getMutedDomains(muted, NOW + FATIGUE_NEGATIVE_MUTE_MS + 1)).not.toContain("rust");
  });

  it("turns the exact '这条没用，别推了' reply into a 24h pause", () => {
    const persona = personaWithOutcomes([["pending", NOW - 5 * 60_000, ["Rust"]]]);
    persona.feedbackProfile.lastProactiveAt = NOW - 5 * 60_000;
    const muted = muteTopicsFromText(persona, "这条没用，别推了", NOW);
    expect(muted.feedbackProfile.proactiveOutcomes?.[0]?.response).toBe("negative");
    const verdict = evaluateFatigueBrake(muted, NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("explicit negative");
  });

  it("mutes topics from explicit negative insight feedback", () => {
    const persona = personaWithOutcomes([["pending", NOW - HR, ["Rust"]]]);
    const muted = withMutedTopics(persona, ["Rust"], NOW);
    expect(muted.feedbackProfile.topicMutedUntil?.rust).toBe(NOW + FATIGUE_NEGATIVE_MUTE_MS);
  });
});
