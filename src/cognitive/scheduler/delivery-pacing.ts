import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { PersonaTree } from "../types.js";
import type { SchedulerEvent } from "./types.js";

/**
 * Delivery pacing — replaces the deterministic min-interval metronom (goal
 * 洞察投放人化重构, iteration 2 "1-2 条/天 + 非定时感").
 *
 * A deterministic spacing floor turns delivery rhythm INTO the floor value
 * (every eligible tick sends → metronomic "scheduled task" feel). Real
 * friend messaging is event-driven bursts under a daily self-restraint:
 * sometimes two shares in one conversation, then nothing for a day.
 *
 * Three mechanisms:
 *   1. Legacy daily-budget bookkeeping retained for persona compatibility
 *      (no longer used as a send gate; the dynamic fatigue brake replaced it).
 *   2. Stochastic hazard gate: between sends, P(send now) rises linearly
 *      from 0 (at the 1h floor) to 1 (at floor + targetGap). Drawn per-event
 *      from a seeded roll → some days 0 sends, some 2; never a fixed rhythm.
 *      targetGap couples to the LEARNED frequency: replied-since-send → F,
 *      unanswered → 2F (eagerness tracks intimacy, ceiling stays the cap).
 *   3. Conversational moment: a persona_change event while the user was
 *      active <2h ago bypasses the hazard ("you're into X? see this") —
 *      still bound by the 1h absolute floor and the fatigue brake.
 */

export const MIN_SEND_GAP_H = 1;
export const CONVERSATIONAL_WINDOW_H = 2;
/** Fallback when cognitive.proactive.activeHours.timezone is unset/invalid. */
export const DEFAULT_PACING_TIMEZONE = "Asia/Shanghai";
const DAY_MS = 24 * 3_600_000;
const HR_MS = 3_600_000;

export type PacingVerdict = {
  allowed: boolean;
  reason: string;
};

const dayFormatterCache = new Map<string, Intl.DateTimeFormat | null>();

function getDayFormatter(timezone: string): Intl.DateTimeFormat | null {
  const cached = dayFormatterCache.get(timezone);
  if (cached !== undefined) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = null;
  }
  dayFormatterCache.set(timezone, formatter);
  return formatter;
}

/**
 * Calendar-day ordinal in `timezone` (days since 1970-01-01 local). Two
 * instants share a value iff they fall on the same local calendar date, so
 * the budget resets at local midnight instead of UTC midnight.
 *
 * Computing via calendar parts (not a fixed UTC offset) keeps the boundary
 * correct for zones with DST. Invalid zone ids fall back to
 * DEFAULT_PACING_TIMEZONE.
 */
export function localDayIndex(nowMs: number, timezone: string = DEFAULT_PACING_TIMEZONE): number {
  const trimmed = timezone.trim();
  const requested = trimmed.length > 0 ? trimmed : DEFAULT_PACING_TIMEZONE;
  const formatter =
    getDayFormatter(requested) ?? getDayFormatter(DEFAULT_PACING_TIMEZONE) ?? undefined;
  if (!formatter) {
    // Extremely old ICU without Asia/Shanghai — degrade to UTC rather than throw.
    return Math.floor(nowMs / DAY_MS);
  }
  const parts = formatter.formatToParts(new Date(nowMs));
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === "year") {
      year = Number(part.value);
    } else if (part.type === "month") {
      month = Number(part.value);
    } else if (part.type === "day") {
      day = Number(part.value);
    }
  }
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function pacingTimezone(): string {
  const configured =
    getRuntimeConfigSnapshot()?.cognitive?.proactive?.activeHours?.timezone?.trim();
  if (!configured) {
    return DEFAULT_PACING_TIMEZONE;
  }
  return getDayFormatter(configured) ? configured : DEFAULT_PACING_TIMEZONE;
}

function dayIndex(ts: number): number {
  // Local-day boundary from activeHours.timezone so a calendar day cannot
  // receive two batches (UTC midnight = 08:00 Asia/Shanghai did exactly that).
  return localDayIndex(ts, pacingTimezone());
}

/**
 * Daily send budget. `dailySendAnchorDay`/`dailySendCount` live on
 * feedbackProfile; the counter self-resets on day rollover (no cron needed).
 */
export function checkDailyBudget(persona: PersonaTree, now: number, cap: number): PacingVerdict {
  const anchor = persona.feedbackProfile.dailySendAnchorDay;
  const count = persona.feedbackProfile.dailySendCount;
  if (anchor !== dayIndex(now)) {
    return { allowed: true, reason: "new day" };
  }
  if ((count ?? 0) >= cap) {
    return { allowed: false, reason: `daily budget exhausted (${count}/${cap})` };
  }
  return { allowed: true, reason: `daily budget ${count}/${cap}` };
}

/** Record one delivered send against today's budget. Mutates the persona. */
export function bumpDailySend(persona: PersonaTree, now: number): void {
  const day = dayIndex(now);
  if (persona.feedbackProfile.dailySendAnchorDay !== day) {
    persona.feedbackProfile.dailySendAnchorDay = day;
    persona.feedbackProfile.dailySendCount = 1;
    return;
  }
  persona.feedbackProfile.dailySendCount = (persona.feedbackProfile.dailySendCount ?? 0) + 1;
}

/**
 * Release one send from the daily budget after a delivery that looked accepted
 * at enqueue time was rejected by the channel. Only decrements when the
 * counter still belongs to the day of the original send.
 */
export function releaseDailySend(persona: PersonaTree, sentAt: number): void {
  if (persona.feedbackProfile.dailySendAnchorDay !== dayIndex(sentAt)) {
    return;
  }
  const count = persona.feedbackProfile.dailySendCount ?? 0;
  if (count > 0) {
    persona.feedbackProfile.dailySendCount = count - 1;
  }
}

/**
 * Stochastic spacing between sends. `roll` ∈ [0,1) is supplied by the caller
 * (seededRandom-derived) so this stays pure and deterministic under test.
 */
export function checkStochasticSpacing(
  persona: PersonaTree,
  eventType: SchedulerEvent["type"],
  now: number,
  roll: number,
): PacingVerdict {
  const lastSendAt = persona.feedbackProfile.lastProactiveAt;
  if (lastSendAt <= 0) {
    return { allowed: true, reason: "first contact" };
  }

  const elapsedH = (now - lastSendAt) / HR_MS;
  if (elapsedH < MIN_SEND_GAP_H) {
    return { allowed: false, reason: `absolute floor ${MIN_SEND_GAP_H}h` };
  }

  const conversational =
    eventType === "persona_change" &&
    persona.lifecycle.lastActiveAt > 0 &&
    now - persona.lifecycle.lastActiveAt < CONVERSATIONAL_WINDOW_H * HR_MS;
  if (conversational) {
    return { allowed: true, reason: "conversational moment" };
  }

  const userRepliedSinceSend = persona.lifecycle.lastActiveAt > lastSendAt;
  const learnedF = Math.max(1, persona.feedbackProfile.optimalFrequencyHours);
  const targetGapH = userRepliedSinceSend ? learnedF : learnedF * 2;
  const hazard = Math.min(1, (elapsedH - MIN_SEND_GAP_H) / targetGapH);
  if (roll >= hazard) {
    return { allowed: false, reason: `hazard draw ${roll.toFixed(2)} ≥ ${hazard.toFixed(2)}` };
  }
  return { allowed: true, reason: `hazard ${hazard.toFixed(2)} > draw ${roll.toFixed(2)}` };
}
