import { describe, expect, it } from "vitest";
import type { PersonaTree } from "../types.js";
import {
  FIRST_CONTACT_MIN_AGE_MS,
  buildFirstContactCandidate,
  evaluateFirstContact,
  firstContactDelayMs,
} from "./first-contact.js";

function makePersona(overrides: Partial<PersonaTree> = {}): PersonaTree {
  return {
    identity: { coreTraits: {}, expertDomains: [], interestDomains: [], curiosityDomains: [] },
    domains: {},
    recentFocus: [],
    feedbackProfile: {
      topicBandits: {},
      optimalFrequencyHours: 4,
      lastProactiveAt: 0,
      recentInsightIds: [],
      recentInsightContents: [],
      recentInsightDomains: [],
      recentInsightTypes: [],
    },
    rapport: {
      trustScore: 0.1,
      totalExchanges: 0,
      avgResponseLength: 0,
      selfDisclosureLevel: 0,
    },
    moodHistory: [],
    domainBlacklist: [],
    lifecycle: {
      stage: "new",
      lastActiveAt: 0,
      lastStageTransitionAt: 0,
      totalActiveDays: 0,
    },
    calibrationHistory: [],
    ...overrides,
  };
}

describe("first contact", () => {
  const now = 1_800_000_000_000;

  it("never fires twice", () => {
    const persona = makePersona({
      lifecycle: {
        stage: "active",
        lastActiveAt: now,
        lastStageTransitionAt: now - 3_600_000,
        totalActiveDays: 1,
      },
    });
    persona.feedbackProfile.firstContactAt = now - 1000;

    expect(evaluateFirstContact(persona, now, 1).allowed).toBe(false);
  });

  it("never fires for a user who already conversed", () => {
    const persona = makePersona({
      lifecycle: {
        stage: "new",
        lastActiveAt: now,
        lastStageTransitionAt: now - 3_600_000,
        totalActiveDays: 1,
      },
      rapport: {
        trustScore: 0.3,
        totalExchanges: 1,
        avgResponseLength: 20,
        selfDisclosureLevel: 0,
      },
    });

    expect(evaluateFirstContact(persona, now, 1).allowed).toBe(false);
  });

  it("respects the unanswered ledger", () => {
    const persona = makePersona({
      lifecycle: {
        stage: "new",
        lastActiveAt: 0,
        lastStageTransitionAt: now - 3_600_000,
        totalActiveDays: 0,
      },
    });
    persona.feedbackProfile.consecutiveNoResponses = 1;

    expect(evaluateFirstContact(persona, now, 1).allowed).toBe(false);
  });

  it("waits out the profile age before speaking", () => {
    const persona = makePersona({
      lifecycle: {
        stage: "new",
        lastActiveAt: 0,
        lastStageTransitionAt: now - 60_000,
        totalActiveDays: 0,
      },
    });

    expect(evaluateFirstContact(persona, now, 0).allowed).toBe(false);
  });

  it("fires for a fresh, silent peer once the delay has passed", () => {
    const persona = makePersona({
      lifecycle: {
        stage: "new",
        lastActiveAt: 0,
        lastStageTransitionAt: now - FIRST_CONTACT_MIN_AGE_MS - 3_600_000,
        totalActiveDays: 0,
      },
    });

    expect(evaluateFirstContact(persona, now, 0).allowed).toBe(true);
  });

  it("rejects a profile with no creation timestamp instead of guessing", () => {
    const persona = makePersona();

    expect(evaluateFirstContact(persona, now, 1).allowed).toBe(false);
  });

  it("will not greet someone outside the active-hours window", () => {
    const persona = makePersona({
      lifecycle: {
        stage: "new",
        lastActiveAt: 0,
        lastStageTransitionAt: now - FIRST_CONTACT_MIN_AGE_MS - 3_600_000,
        totalActiveDays: 0,
      },
    });
    // 2026-11-06 03:00 Asia/Shanghai, well outside 09:00-23:00.
    const night = Date.parse("2026-11-05T19:00:00.000Z");
    const config = {
      minIntervalHours: 1,
      minTrustScore: 0.3,
      activeHoursStart: "09:00",
      activeHoursEnd: "23:00",
      timezone: "Asia/Shanghai",
    };
    persona.lifecycle.lastStageTransitionAt = night - FIRST_CONTACT_MIN_AGE_MS - 3_600_000;

    expect(evaluateFirstContact(persona, night, 0, config).allowed).toBe(false);
  });

  it("derives a stable per-user delay from the roll", () => {
    expect(firstContactDelayMs(0)).toBe(FIRST_CONTACT_MIN_AGE_MS);
    expect(firstContactDelayMs(0)).toBe(firstContactDelayMs(0));
    expect(firstContactDelayMs(1)).toBeGreaterThan(firstContactDelayMs(0));
    expect(firstContactDelayMs(-1)).toBe(FIRST_CONTACT_MIN_AGE_MS);
    expect(firstContactDelayMs(2)).toBe(firstContactDelayMs(1));
  });

  it("asks the user what they care about and carries no sources", () => {
    const candidate = buildFirstContactCandidate(makePersona(), now);

    expect(candidate.sources).toEqual([]);
    expect(candidate.content).toContain("AllBot");
    expect(candidate.content.length).toBeGreaterThan(10);
  });
});
