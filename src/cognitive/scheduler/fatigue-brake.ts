import type { PersonaTree, ProactiveOutcome, ProactiveOutcomeResponse } from "../types.js";
import type { Opportunity } from "./types.js";

/**
 * Dynamic fatigue brake.
 *
 * The old daily cap counted sends. This counts *reception*: a user who keeps
 * replying can receive more than two messages a day, a user who ignores or
 * gives one-word answers gets the agent to back off. All decisions read the
 * timestamped `proactiveOutcomes` ledger, so they are pure functions of the
 * persisted persona plus `now` — no extra pause state to lose on restart.
 */

export const FATIGUE_WINDOW_MS = 7 * 24 * 3_600_000;
/** Below this many judged outcomes, a ratio is noise and must not brake. */
export const FATIGUE_MIN_SAMPLES = 3;
export const FATIGUE_IGNORE_RATE_THRESHOLD = 0.4;
export const FATIGUE_PAUSE_RATE_THRESHOLD = 0.6;
export const FATIGUE_PAUSE_MS = 24 * 3_600_000;
export const FATIGUE_THRESHOLD_BOOST = 0.1;
export const FATIGUE_SILENCE_AFTER_NON_SUBSTANTIVE = 3;
export const FATIGUE_SILENCE_MS = 2 * 3_600_000;
export const FATIGUE_TOPIC_REPEAT_MS = 24 * 3_600_000;
export const FATIGUE_CONSECUTIVE_TOPIC_LIMIT = 2;
export const FATIGUE_NEGATIVE_MUTE_MS = 7 * 24 * 3_600_000;
/** Keep two windows of history; the brake only reads the most recent one. */
export const PROACTIVE_OUTCOME_LIMIT = 40;
/**
 * A message delivered less than 2h ago is still waiting for a reply, not
 * ignored. This is also the upper bound on how long "连续 3 条无实质互动"
 * can stay unobserved: after the grace window the ledger counts it as ignored
 * without needing the no-response transition to run.
 */
export const OUTCOME_RESOLVE_GRACE_MS = 2 * 3_600_000;

/**
 * Explicit negative feedback outranks a generic reply classification or a
 * no-response penalty when both land on the same outcome.
 */
const RESPONSE_PRIORITY: Record<ProactiveOutcomeResponse, number> = {
  pending: 0,
  dismissive: 1,
  ignored: 2,
  normal: 3,
  engaged: 3,
  negative: 4,
};

const NEGATIVE_RESPONSES: ReadonlySet<ProactiveOutcomeResponse> = new Set([
  "ignored",
  "dismissive",
  "negative",
]);

const SUBSTANTIVE_RESPONSES: ReadonlySet<ProactiveOutcomeResponse> = new Set(["engaged", "normal"]);

/** Domain keys are compared case-insensitively; persona domains are user text. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

export function isNegativeResponse(response: ProactiveOutcomeResponse): boolean {
  return NEGATIVE_RESPONSES.has(response);
}

export function isSubstantiveResponse(response: ProactiveOutcomeResponse): boolean {
  return SUBSTANTIVE_RESPONSES.has(response);
}

/**
 * Append one delivered insight to the outcome ledger. Mutates the profile;
 * callers already own a persona copy inside `PersonaStore.update`.
 */
export function appendProactiveOutcome(
  persona: PersonaTree,
  outcome: ProactiveOutcome,
): PersonaTree {
  const outcomes = persona.feedbackProfile.proactiveOutcomes ?? [];
  if (outcomes.some((o) => o.at === outcome.at && o.insightId === outcome.insightId)) {
    return persona;
  }
  const next = [...outcomes, outcome]
    .toSorted((a, b) => a.at - b.at)
    .slice(-PROACTIVE_OUTCOME_LIMIT);
  persona.feedbackProfile.proactiveOutcomes = next;
  return persona;
}

/**
 * Fill in the reception of an insight once it is known. A late no-response
 * penalty cannot overwrite a reply; explicit negative feedback can.
 */
export function withOutcomeResponse(
  persona: PersonaTree,
  at: number,
  response: ProactiveOutcomeResponse,
  resolvedAt: number = Date.now(),
): PersonaTree {
  const outcomes = persona.feedbackProfile.proactiveOutcomes;
  if (!outcomes || outcomes.length === 0 || at <= 0) {
    return persona;
  }
  let changed = false;
  const next = outcomes.map((o) => {
    if (
      o.at !== at ||
      (o.response !== "pending" && RESPONSE_PRIORITY[response] <= RESPONSE_PRIORITY[o.response])
    ) {
      return o;
    }
    changed = true;
    return { ...o, response, resolvedAt };
  });
  if (!changed) {
    return persona;
  }
  return {
    ...persona,
    feedbackProfile: { ...persona.feedbackProfile, proactiveOutcomes: next },
  };
}

/** Latest pending outcome, used when the reply path knows no exact timestamp. */
export function withLatestOutcomeResponse(
  persona: PersonaTree,
  response: ProactiveOutcomeResponse,
  resolvedAt?: number,
): PersonaTree {
  const outcomes = persona.feedbackProfile.proactiveOutcomes;
  const latest = outcomes?.filter((o) => o.response === "pending").at(-1);
  return latest ? withOutcomeResponse(persona, latest.at, response, resolvedAt) : persona;
}

/** Resolve an outcome by insight id (explicit feedback / card callback). */
export function withOutcomeResponseByInsightId(
  persona: PersonaTree,
  insightId: string,
  response: ProactiveOutcomeResponse,
  resolvedAt?: number,
): PersonaTree {
  const match = (persona.feedbackProfile.proactiveOutcomes ?? [])
    .filter((o) => o.insightId === insightId)
    .at(-1);
  return match ? withOutcomeResponse(persona, match.at, response, resolvedAt) : persona;
}

/** Plain-text negative feedback, e.g. "别再推这个" or a "不感兴趣" card. */
const TOPIC_MUTE_PATTERNS: ReadonlyArray<RegExp> = [
  /别再推(?:这个|这类|这些|该主题|这个主题|这种)/,
  /不要再推(?:这个|这类|这些|该主题|这个主题|这种)/,
  // Short, blunt "stop pushing" replies — these are explicit negative feedback
  // even though they are under the 20-char dismissive threshold.
  /别(?:再)?推了/,
  /别(?:再)?发了/,
  /这条(?:消息|推送)?(?:没用|没价值|没用处)/,
  /不(?:要|想)(?:再)?(?:收|看|推)/,
  /停止(?:推送|发送)/,
  /取消(?:订阅|推送|通知)/,
  /关(?:掉|闭)(?:推送|通知)/,
  /不感兴趣/,
  /没兴趣/,
  /对这个(?:话题|主题)?(?:不感兴趣|没兴趣|不感冒)/,
  /stop (?:sending|pushing) (?:this|these|that)/i,
  /not interested/i,
  /don'?t care about (?:this|that)/i,
];

export function detectTopicMuteIntent(text: string): boolean {
  return TOPIC_MUTE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Apply plain-text negative feedback to the persona: resolve the latest
 * pending outcome as `negative` and mute its topics for 7 days.
 */
export function muteTopicsFromText(persona: PersonaTree, text: string, now: number): PersonaTree {
  if (!detectTopicMuteIntent(text)) {
    return persona;
  }
  const outcomes = persona.feedbackProfile.proactiveOutcomes ?? [];
  const latest = outcomes.at(-1);
  const topics =
    latest && latest.domains.length > 0
      ? latest.domains
      : ((persona.feedbackProfile.recentInsightDomains ?? []).at(-1) ?? []);
  const marked = latest ? withOutcomeResponse(persona, latest.at, "negative", now) : persona;
  return withMutedTopics(marked, topics, now);
}

/**
 * Explicit negative feedback: silence the topics for 7 days. Separate from
 * `domainBlacklist`, which is a permanent "never mention this again".
 */
export function withMutedTopics(
  persona: PersonaTree,
  topics: string[],
  now: number,
  muteMs: number = FATIGUE_NEGATIVE_MUTE_MS,
): PersonaTree {
  const cleaned = topics.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) {
    return persona;
  }
  const until = now + muteMs;
  const muted = { ...persona.feedbackProfile.topicMutedUntil };
  for (const topic of cleaned) {
    const key = normalizeDomain(topic);
    muted[key] = Math.max(muted[key] ?? 0, until);
  }
  return {
    ...persona,
    feedbackProfile: { ...persona.feedbackProfile, topicMutedUntil: muted },
  };
}

/**
 * A graded outcome with its timestamp. `pending` entries age into `ignored`
 * after the reply grace window, which keeps the brake consistent even if the
 * scheduler's no-response transition misses a tick. Negative feedback wins
 * over a generic no-response penalty.
 */
export type ResolvedProactiveOutcome = ProactiveOutcome;

export function resolveProactiveOutcomes(
  persona: PersonaTree,
  now: number,
): ResolvedProactiveOutcome[] {
  return (persona.feedbackProfile.proactiveOutcomes ?? [])
    .filter((o) => o.at <= now)
    .map((o) => {
      if (o.response !== "pending") {
        return o;
      }
      if (now - o.at < OUTCOME_RESOLVE_GRACE_MS) {
        return o;
      }
      return { ...o, response: "ignored" as const, resolvedAt: o.at + OUTCOME_RESOLVE_GRACE_MS };
    })
    .toSorted((a, b) => a.at - b.at);
}

/** Rolling 7-day ignore / dismissive rate over judged outcomes. */
export function computeIgnoreRate(
  persona: PersonaTree,
  now: number,
): {
  rate: number;
  samples: number;
  bad: number;
  lastBadAt: number;
} {
  const window = resolveProactiveOutcomes(persona, now).filter(
    (o) => o.at >= now - FATIGUE_WINDOW_MS && o.response !== "pending",
  );
  let bad = 0;
  let lastBadAt = 0;
  let lastResolvedBadAt = 0;
  for (const outcome of window) {
    if (isNegativeResponse(outcome.response)) {
      bad++;
      lastBadAt = Math.max(lastBadAt, outcome.at);
      lastResolvedBadAt = Math.max(
        lastResolvedBadAt,
        outcome.resolvedAt ?? outcome.at + OUTCOME_RESOLVE_GRACE_MS,
      );
    }
  }
  return {
    rate: window.length > 0 ? bad / window.length : 0,
    samples: window.length,
    bad,
    lastBadAt: lastResolvedBadAt || lastBadAt,
  };
}

export type FatigueBrakeVerdict = {
  allowed: boolean;
  reason: string;
  ignoreRate: number;
  samples: number;
  /** Added to the PRISM threshold for the 40%–60% band. */
  thresholdBoost: number;
  suggestedDelayMs?: number;
};

function describeSilenceStreak(persona: PersonaTree, now: number): string | undefined {
  const tail = resolveProactiveOutcomes(persona, now).slice(-FATIGUE_SILENCE_AFTER_NON_SUBSTANTIVE);
  if (
    tail.length !== FATIGUE_SILENCE_AFTER_NON_SUBSTANTIVE ||
    tail.some((o) => o.response === "pending" || isSubstantiveResponse(o.response))
  ) {
    return undefined;
  }
  const latestAt = Math.max(...tail.map((o) => o.resolvedAt ?? o.at + OUTCOME_RESOLVE_GRACE_MS));
  const remaining = FATIGUE_SILENCE_MS - (now - latestAt);
  if (remaining <= 0) {
    return undefined;
  }
  return `fatigue brake: ${tail.length} consecutive non-substantive outcomes, silent ${Math.round(remaining / 60_000)}min`;
}

/**
 * The single replacement for the fixed daily cap. Returns a hard veto when the
 * user has clearly disengaged, and a threshold boost for the milder band.
 */
export function evaluateFatigueBrake(persona: PersonaTree, now: number): FatigueBrakeVerdict {
  const { rate, samples, lastBadAt } = computeIgnoreRate(persona, now);
  const base: FatigueBrakeVerdict = {
    allowed: true,
    reason: `fatigue brake: ignore rate ${rate.toFixed(2)} over ${samples} outcomes`,
    ignoreRate: rate,
    samples,
    thresholdBoost: 0,
  };

  // An explicit "no, stop" is a strong signal on its own: we do not wait for
  // three noisy samples before honouring it. A single negative reply pauses
  // proactive sends for 24h (the same duration as the ratio-based pause).
  const explicitNegative = resolveProactiveOutcomes(persona, now).filter(
    (o) => o.response === "negative",
  );
  if (explicitNegative.length > 0) {
    const lastNegativeAt = Math.max(
      ...explicitNegative.map((o) => o.resolvedAt ?? o.at + OUTCOME_RESOLVE_GRACE_MS),
    );
    // Re-engagement releases the explicit-negative pause: a user who replies
    // again after saying "stop" has shown they still want to interact. We only
    // count activity strictly after the negative reply (5s margin keeps the
    // negative message itself from clearing its own pause).
    const lastActiveAt = persona.lifecycle?.lastActiveAt ?? 0;
    const reengaged = lastActiveAt > lastNegativeAt + 5_000;
    const remaining = FATIGUE_PAUSE_MS - (now - lastNegativeAt);
    if (!reengaged && remaining > 0) {
      return {
        ...base,
        allowed: false,
        reason: `fatigue brake: explicit negative feedback, paused ${Math.round(remaining / 60_000)}min`,
        suggestedDelayMs: remaining,
      };
    }
  }

  if (samples >= FATIGUE_MIN_SAMPLES && rate > FATIGUE_PAUSE_RATE_THRESHOLD) {
    const remaining = FATIGUE_PAUSE_MS - (now - lastBadAt);
    if (remaining > 0) {
      return {
        ...base,
        allowed: false,
        reason: `fatigue brake: ignore rate ${rate.toFixed(2)} > ${FATIGUE_PAUSE_RATE_THRESHOLD}, paused ${Math.round(remaining / 60_000)}min`,
        suggestedDelayMs: remaining,
      };
    }
    // The 24h pause has elapsed. Allow one probe instead of staying silent
    // forever on a stale ratio; a new ignored outcome restarts the pause.
  }

  const streak = describeSilenceStreak(persona, now);
  if (streak) {
    return { ...base, allowed: false, reason: streak };
  }

  if (samples >= FATIGUE_MIN_SAMPLES && rate > FATIGUE_IGNORE_RATE_THRESHOLD) {
    return {
      ...base,
      reason: `fatigue brake: ignore rate ${rate.toFixed(2)} > ${FATIGUE_IGNORE_RATE_THRESHOLD}, threshold +${FATIGUE_THRESHOLD_BOOST}`,
      thresholdBoost: FATIGUE_THRESHOLD_BOOST,
    };
  }

  return base;
}

/**
 * Topics that must not be the main content of the next message:
 * - explicitly muted by negative feedback (7 days),
 * - already used as a main topic in the last 24h,
 * - pushed twice in a row on the same interest (24h cooldown).
 */
export function getMutedDomains(persona: PersonaTree, now: number): string[] {
  const muted = new Set<string>();
  for (const [key, until] of Object.entries(persona.feedbackProfile.topicMutedUntil ?? {})) {
    if (until > now) {
      muted.add(key);
    }
  }

  const outcomes = resolveProactiveOutcomes(persona, now);
  const lastAtByDomain = new Map<string, number>();
  for (const outcome of outcomes) {
    // A negative reply cools the topic from the moment the user said no;
    // other outcomes cool it from delivery time.
    const stamp = outcome.response === "negative" ? (outcome.resolvedAt ?? outcome.at) : outcome.at;
    for (const domain of outcome.domains) {
      const key = normalizeDomain(domain);
      lastAtByDomain.set(key, Math.max(lastAtByDomain.get(key) ?? 0, stamp));
    }
  }
  for (const [domain, lastAt] of lastAtByDomain) {
    if (now - lastAt < FATIGUE_TOPIC_REPEAT_MS) {
      muted.add(domain);
    }
  }

  // Consecutive same-interest pushes: a run at the tail of the ledger.
  if (outcomes.length >= FATIGUE_CONSECUTIVE_TOPIC_LIMIT) {
    const tail = outcomes.slice(-FATIGUE_CONSECUTIVE_TOPIC_LIMIT);
    const shared = tail
      .map((o) => new Set(o.domains.map(normalizeDomain)))
      .reduce((acc, set) => new Set([...acc].filter((d) => set.has(d))));
    const lastAt = Math.max(
      ...tail.map((o) => (o.response === "negative" ? (o.resolvedAt ?? o.at) : o.at)),
    );
    if (now - lastAt < FATIGUE_TOPIC_REPEAT_MS) {
      for (const domain of shared) {
        muted.add(domain);
      }
    }
  }

  return [...muted];
}

/** Drop opportunities whose main content would be a muted topic. */
export function filterFatiguedOpportunities(
  opportunities: Opportunity[],
  mutedDomains: string[],
): Opportunity[] {
  if (mutedDomains.length === 0) {
    return opportunities;
  }
  const muted = new Set(mutedDomains.map(normalizeDomain));
  return opportunities.filter((opp) => {
    const main = opp.targetDomains.length > 0 ? opp.targetDomains : opp.sourceDomains;
    return !main.some((d) => muted.has(normalizeDomain(d)));
  });
}

/** Union two outcome ledgers by (at, insightId), preferring current state. */
export function mergeProactiveOutcomes(
  current: ProactiveOutcome[] | undefined,
  snapshot: ProactiveOutcome[] | undefined,
): ProactiveOutcome[] {
  const byKey = new Map<string, ProactiveOutcome>();
  for (const outcome of [...(snapshot ?? []), ...(current ?? [])]) {
    const key = `${outcome.at}:${outcome.insightId ?? ""}`;
    const existing = byKey.get(key);
    // A reply-path write can resolve an outcome while the scheduler holds a
    // stale `pending` snapshot; keep the higher-priority (resolved) state.
    if (!existing || RESPONSE_PRIORITY[outcome.response] >= RESPONSE_PRIORITY[existing.response]) {
      byKey.set(key, outcome);
    }
  }
  return [...byKey.values()].toSorted((a, b) => a.at - b.at).slice(-PROACTIVE_OUTCOME_LIMIT);
}
