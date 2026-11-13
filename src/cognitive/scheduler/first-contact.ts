import type { PersonaTree } from "../types.js";
import type { InsightCandidate } from "../insight/types.js";
import { isOutsideActiveHours } from "./gate.js";
import type { SchedulerConfig } from "./types.js";

/**
 * First contact — the channel that lets the agent open a conversation with
 * someone it has never talked to.
 *
 * Why this cannot be folded into the cadence gate: every other channel here
 * presumes a relationship. `gate.ts` hard-vetoes zero exchanges ("No
 * conversation history yet") because an insight needs something known about
 * the person to be worth interrupting them for; `re-engagement.ts` requires
 * `lastProactiveAt > 0` because it reopens a relationship that existed.
 *
 * Those rules are correct. The defect is elsewhere: a persona is only created
 * when the USER speaks first (`attempt.ts`, gated on `senderId`), while the
 * scheduler only iterates users that already have a persona file. A fresh
 * install therefore has zero personas, publishes `userCount: 0` on every
 * tick, and can never speak first — it can answer, never start.
 *
 * This channel closes that loop without loosening any insight gate: it does
 * not generate an insight, does not consult domain history, and fires at
 * most once, ever, per user. The message it carries is a greeting that asks
 * what the person wants help with — the one thing a new assistant can
 * honestly say with no prior knowledge. Everything after that flows through
 * the existing paths, because answering creates the persona.
 */

/**
 * A brand-new install should not talk to itself the instant it starts: the
 * owner usually configures the channel before anyone is ready to read a
 * message, and a greeting that lands during setup looks like a glitch.
 */
export const FIRST_CONTACT_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * Per-user stagger on top of the minimum age. The greeting is
 * time-insensitive, so spreading it out avoids every configured recipient
 * receiving an identical message at the same second.
 */
export const FIRST_CONTACT_JITTER_MS = 50 * 60 * 1000;

export type FirstContactDecision = {
  allowed: boolean;
  reason: string;
};

/**
 * Stable per-user delay before the greeting may be sent. Derived from the
 * identity (not from a per-tick draw) so the same user always waits the same
 * amount of time instead of re-rolling every tick.
 */
export function firstContactDelayMs(roll: number): number {
  const clamped = Math.max(0, Math.min(1, roll));
  return FIRST_CONTACT_MIN_AGE_MS + clamped * FIRST_CONTACT_JITTER_MS;
}

/**
 * Decide whether this user is eligible for the one-time opening message.
 *
 * `roll` is a [0,1) value; the caller derives it from the user identity so
 * the decision is stable across ticks and remains pure and testable.
 * `config` carries the active-hours window — a greeting at 3am is exactly
 * the kind of interruption the rest of the scheduler already refuses.
 */
export function evaluateFirstContact(
  persona: PersonaTree,
  now: number,
  roll: number,
  config?: SchedulerConfig,
): FirstContactDecision {
  if (persona.feedbackProfile.firstContactAt) {
    return { allowed: false, reason: "first contact already sent" };
  }
  if (persona.rapport.totalExchanges > 0) {
    return { allowed: false, reason: "user already conversed" };
  }
  if ((persona.feedbackProfile.consecutiveNoResponses ?? 0) > 0) {
    return { allowed: false, reason: "unanswered messages pending" };
  }
  if (config && isOutsideActiveHours(now, config)) {
    return { allowed: false, reason: "outside active hours" };
  }
  // Seeding a persona records when the "new" stage began; using it as the
  // profile age keeps the delay anchored to a real, persisted timestamp
  // instead of process uptime (which resets on every restart).
  const createdAt = persona.lifecycle.lastStageTransitionAt;
  if (createdAt <= 0) {
    return { allowed: false, reason: "profile creation time unknown" };
  }
  if (now - createdAt < firstContactDelayMs(roll)) {
    return { allowed: false, reason: "profile too new" };
  }
  return { allowed: true, reason: "first contact" };
}

/**
 * Build the opening message as an ordinary insight candidate so it flows
 * through the one delivery path everything else uses (queue, heartbeat,
 * outcome accounting) instead of needing a second send mechanism.
 *
 * The content is deliberately a question, not a claim: the agent has no
 * persona evidence to be interesting with yet, and asking is the honest
 * move. Sources are empty by design — first contact is exempt from the
 * source gate in `resolve()` because it never goes through it.
 */
export function buildFirstContactCandidate(
  persona: PersonaTree,
  now: number,
  displayName?: string,
): InsightCandidate {
  const name = displayName?.trim() || persona.identity.displayName?.trim();
  const greeting = name ? `${name}，` : "";
  const content =
    `${greeting}我是 AllBot。我可以帮你盯新闻、查资料、跑长任务，也能按你的兴趣主动找点东西过来。` +
    `现在还不知道你关心什么——说一句就行，比如"帮我关注 Rust 和 LLM 推理优化"。`;

  return {
    id: `first-contact-${now}`,
    content,
    rationale: "One-time opening message; the agent has no prior contact with this user.",
    targetDomains: [],
    sourceDomains: [],
    relevanceScore: 1,
    surpriseScore: 0,
    compositeScore: 1,
    sources: [],
    verificationStatus: "unverified",
    source: "pattern",
    resolvedMode: "surprise",
    firstContact: true,
  };
}
