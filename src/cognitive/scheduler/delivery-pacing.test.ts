import { describe, it, expect, afterEach } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { AllBotConfig } from "../../config/types.js";
import { createDefaultPersona } from "../persona/store.js";
import type { PersonaTree } from "../types.js";
import {
  checkDailyBudget,
  bumpDailySend,
  checkStochasticSpacing,
  localDayIndex,
  DEFAULT_PACING_TIMEZONE,
  MIN_SEND_GAP_H,
} from "./delivery-pacing.js";

const DAY_MS = 24 * 3_600_000;
const HR = 3_600_000;
// Fixed anchor: 2023-11-14T00:00:00Z.
const UTC_DAY_START = Math.floor(1_700_000_005_000 / DAY_MS) * DAY_MS;
// 12:00 Asia/Shanghai, so +5h stays inside the same local day.
const T0 = UTC_DAY_START + 4 * HR;

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

function personaWith(overrides: Partial<PersonaTree["feedbackProfile"]> = {}): PersonaTree {
  const persona = createDefaultPersona();
  persona.feedbackProfile = {
    ...persona.feedbackProfile,
    optimalFrequencyHours: 24,
    ...overrides,
  };
  return persona;
}

describe("localDayIndex", () => {
  it("splits UTC days at UTC midnight", () => {
    expect(localDayIndex(UTC_DAY_START, "UTC")).toBe(localDayIndex(UTC_DAY_START - 1, "UTC") + 1);
  });

  it("splits Asia/Shanghai days at 16:00Z (= local midnight), not at UTC midnight", () => {
    const shanghaiMidnight = UTC_DAY_START + 16 * HR;
    expect(localDayIndex(shanghaiMidnight, "Asia/Shanghai")).toBe(
      localDayIndex(shanghaiMidnight - 1, "Asia/Shanghai") + 1,
    );
    // The same instant is still the previous UTC day, so the two zones disagree.
    expect(localDayIndex(shanghaiMidnight, "UTC")).toBe(localDayIndex(shanghaiMidnight - 1, "UTC"));
  });

  it("Asia/Shanghai is one day ahead of UTC between 16:00Z and 24:00Z", () => {
    const afterUtcMidnightInShanghai = UTC_DAY_START + 17 * HR;
    expect(localDayIndex(afterUtcMidnightInShanghai, "Asia/Shanghai")).toBe(
      localDayIndex(afterUtcMidnightInShanghai, "UTC") + 1,
    );
    const beforeShanghaiMidnight = UTC_DAY_START + 15 * HR;
    expect(localDayIndex(beforeShanghaiMidnight, "Asia/Shanghai")).toBe(
      localDayIndex(beforeShanghaiMidnight, "UTC"),
    );
  });

  it("defaults to Asia/Shanghai", () => {
    const t = UTC_DAY_START + 17 * HR;
    expect(localDayIndex(t)).toBe(localDayIndex(t, "Asia/Shanghai"));
    expect(DEFAULT_PACING_TIMEZONE).toBe("Asia/Shanghai");
  });

  it("falls back to the default timezone for an invalid zone id", () => {
    const t = UTC_DAY_START + 17 * HR;
    expect(localDayIndex(t, "Not/AZone")).toBe(localDayIndex(t, DEFAULT_PACING_TIMEZONE));
  });
});

describe("checkDailyBudget", () => {
  it("allows when no sends recorded", () => {
    expect(checkDailyBudget(personaWith(), T0, 2).allowed).toBe(true);
  });

  it("blocks at cap within the same local day", () => {
    const p = personaWith();
    bumpDailySend(p, T0);
    bumpDailySend(p, T0 + 3 * HR);
    expect(checkDailyBudget(p, T0 + 5 * HR, 2).allowed).toBe(false);
    expect(p.feedbackProfile.dailySendCount).toBe(2);
  });

  it("self-resets on local day rollover", () => {
    const p = personaWith();
    bumpDailySend(p, T0);
    bumpDailySend(p, T0 + 3 * HR);
    expect(checkDailyBudget(p, T0 + DAY_MS + HR, 2).allowed).toBe(true);
    expect(checkDailyBudget(p, T0 + DAY_MS + HR, 2).reason).toBe("new day");
  });

  it("resets at local midnight even though the UTC day has not rolled over", () => {
    const p = personaWith();
    const localLateEvening = UTC_DAY_START + 14 * HR; // 22:00 Asia/Shanghai
    const localAfterMidnight = UTC_DAY_START + 17 * HR; // 01:00 Asia/Shanghai, next day
    bumpDailySend(p, localLateEvening);
    bumpDailySend(p, localLateEvening + HR); // 23:00, second send of the local day
    expect(localDayIndex(localAfterMidnight, "UTC")).toBe(localDayIndex(localLateEvening, "UTC"));
    const verdict = checkDailyBudget(p, localAfterMidnight, 2);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("new day");
  });

  it("honors cognitive.proactive.activeHours.timezone", () => {
    setRuntimeConfigSnapshot({
      cognitive: { proactive: { activeHours: { timezone: "UTC" } } },
    } as unknown as AllBotConfig);
    const p = personaWith();
    const morningUtc = UTC_DAY_START + 10 * HR; // 18:00 Asia/Shanghai
    bumpDailySend(p, morningUtc);
    bumpDailySend(p, morningUtc + HR);
    // Shanghai has rolled into the next day here; UTC has not, so still blocked.
    expect(checkDailyBudget(p, UTC_DAY_START + 17 * HR, 2).allowed).toBe(false);
    // Actual UTC rollover resets the budget.
    expect(checkDailyBudget(p, UTC_DAY_START + DAY_MS + HR, 2).reason).toBe("new day");
  });

  it("partial budget still allows", () => {
    const p = personaWith();
    bumpDailySend(p, T0);
    expect(checkDailyBudget(p, T0 + 5 * HR, 2).allowed).toBe(true);
  });
});

describe("checkStochasticSpacing", () => {
  const lastSend = T0;
  const activeAfterSend = lastSend + HR;

  it("first contact passes unconditionally", () => {
    expect(checkStochasticSpacing(personaWith(), "timer", T0, 0.99).allowed).toBe(true);
  });

  it("absolute floor blocks sub-hour gaps even conversationally", () => {
    const p = personaWith({ lastProactiveAt: lastSend });
    p.lifecycle.lastActiveAt = lastSend + 30 * 60_000;
    const verdict = checkStochasticSpacing(p, "persona_change", lastSend + 45 * 60_000, 0);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("floor");
  });

  it("conversational moment (persona_change + user active <2h) bypasses hazard", () => {
    const p = personaWith({ lastProactiveAt: lastSend });
    p.lifecycle.lastActiveAt = activeAfterSend;
    expect(checkStochasticSpacing(p, "persona_change", lastSend + 2 * HR, 0.99).allowed).toBe(true);
  });

  it("timer events never take the conversational bypass", () => {
    const p = personaWith({ lastProactiveAt: lastSend });
    p.lifecycle.lastActiveAt = activeAfterSend;
    expect(checkStochasticSpacing(p, "timer", lastSend + 2 * HR, 0.99).allowed).toBe(false);
  });

  it("hazard rises with elapsed time at fixed roll", () => {
    const p = personaWith({ lastProactiveAt: lastSend });
    p.lifecycle.lastActiveAt = activeAfterSend;
    const roll = 0.5;
    // F=24 fast lane: hazard = (elapsedH-1)/24; passes when hazard > 0.5 → elapsed > 13h
    expect(checkStochasticSpacing(p, "timer", lastSend + 5 * HR, roll).allowed).toBe(false);
    expect(checkStochasticSpacing(p, "timer", lastSend + 12 * HR, roll).allowed).toBe(false);
    expect(checkStochasticSpacing(p, "timer", lastSend + 14 * HR, roll).allowed).toBe(true);
    expect(checkStochasticSpacing(p, "timer", lastSend + 30 * HR, roll).allowed).toBe(true);
  });

  it("unanswered send doubles the target gap (slow lane)", () => {
    // user last active BEFORE the send → unanswered → F*2 = 48h
    const p = personaWith({ lastProactiveAt: lastSend });
    p.lifecycle.lastActiveAt = lastSend - HR;
    const roll = 0.5;
    expect(checkStochasticSpacing(p, "timer", lastSend + 14 * HR, roll).allowed).toBe(false);
    expect(checkStochasticSpacing(p, "timer", lastSend + 26 * HR, roll).allowed).toBe(true);
  });

  it("elapsed beyond floor+targetGap always passes (bounded worst-case wait)", () => {
    const p = personaWith({ lastProactiveAt: lastSend });
    p.lifecycle.lastActiveAt = activeAfterSend;
    expect(
      checkStochasticSpacing(p, "timer", lastSend + (MIN_SEND_GAP_H + 24) * HR, 0.999).allowed,
    ).toBe(true);
  });
});
