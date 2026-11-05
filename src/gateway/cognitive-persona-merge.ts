import type { InsightCandidate } from "../cognitive/insight/types.js";
import { releaseDailySend } from "../cognitive/scheduler/delivery-pacing.js";
import type { SchedulerEvent } from "../cognitive/scheduler/types.js";
import type { FeedbackProfile, InsightRecord, PersonaTree } from "../cognitive/types.js";

/** Window sizes mirror the append+truncate caps used by the scheduler/store. */
const RECENT_INSIGHT_ID_LIMIT = 20;
const RECENT_INSIGHT_CONTENT_LIMIT = 10;
const RECENT_INSIGHT_DOMAIN_LIMIT = 5;
const RECENT_INSIGHT_TYPE_LIMIT = 5;
const RECENT_INSIGHT_MODE_LIMIT = 5;
const RECENT_INSIGHT_QUERY_LIMIT = 10;

function sameRecentValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
}

/**
 * Union two append-ordered recent-insight windows.
 *
 * The profile stores no per-entry timestamp, but both arrays are written
 * append-only (`[...prev, next].slice(-cap)`), so array order *is* delivery
 * order. The snapshot was captured before the multi-minute resolve loop, so
 * every snapshot entry predates anything the snapshot itself lacks; starting
 * from the snapshot and appending current-only entries therefore reconstructs
 * the chronological union, and the tail slice keeps the newest `max` items.
 */
function unionRecentWindow<T>(
  snapshot: T[] | undefined,
  current: T[] | undefined,
  max: number,
): T[] {
  const merged: T[] = [];
  for (const value of [...(snapshot ?? []), ...(current ?? [])]) {
    if (!merged.some((existing) => sameRecentValue(existing, value))) {
      merged.push(value);
    }
  }
  return merged.slice(-max);
}

function maxTimestamp(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return Math.max(a ?? 0, b ?? 0);
}

/**
 * Field-level merge for the proactive scheduler's persona saves.
 *
 * The scheduler holds one persona snapshot across a multi-minute LLM resolve
 * loop (generate → critique → refine → verify). A wholesale
 * `current.feedbackProfile = snapshot.feedbackProfile` at save time would
 * revert every write the reply path persisted during that window — most
 * critically `resetNoResponseStreak` (a user reply clearing the
 * no-response ledger), Thompson-Sampling bandit updates, and
 * `optimalFrequencyHours` nudges. Reverting a ledger reset can push a
 * responsive user over the hard veto threshold (U ≥ 3) and silence them
 * despite having answered.
 *
 * Monotonic fields (timestamps and delivery windows) are merged from both
 * sides instead of being overwritten by the event-start snapshot:
 * - `lastProactiveAt` / `lastReEngageAttemptAt`: max(snapshot, current)
 * - `recentInsight*`: chronological union of both windows, truncated to cap
 *
 * Ownership rules:
 * - Scheduler-owned pacing/dedup fields are copied from the snapshot (the
 *   scheduler is the only writer at save time).
 * - Reply-path-owned fields (bandits, frequency, suppression, ledger) are
 *   kept from `current`. The ledger is persisted exclusively by the atomic
 *   `applyNoResponseLedger` callback, never by savePersona.
 */
export function mergeSchedulerFeedbackProfile(
  current: FeedbackProfile,
  snapshot: FeedbackProfile,
): FeedbackProfile {
  return {
    ...current,
    lastProactiveAt: Math.max(current.lastProactiveAt ?? 0, snapshot.lastProactiveAt ?? 0),
    pendingInsightDelivery: snapshot.pendingInsightDelivery,
    awaitingDeliveryConfirmation: snapshot.awaitingDeliveryConfirmation,
    recentInsightIds: unionRecentWindow(
      snapshot.recentInsightIds,
      current.recentInsightIds,
      RECENT_INSIGHT_ID_LIMIT,
    ),
    recentInsightContents: unionRecentWindow(
      snapshot.recentInsightContents,
      current.recentInsightContents,
      RECENT_INSIGHT_CONTENT_LIMIT,
    ),
    recentInsightDomains: unionRecentWindow(
      snapshot.recentInsightDomains,
      current.recentInsightDomains,
      RECENT_INSIGHT_DOMAIN_LIMIT,
    ),
    recentInsightTypes: unionRecentWindow(
      snapshot.recentInsightTypes,
      current.recentInsightTypes,
      RECENT_INSIGHT_TYPE_LIMIT,
    ),
    recentInsightModes: unionRecentWindow(
      snapshot.recentInsightModes,
      current.recentInsightModes,
      RECENT_INSIGHT_MODE_LIMIT,
    ),
    recentInsightQueryHistory: unionRecentWindow(
      snapshot.recentInsightQueryHistory,
      current.recentInsightQueryHistory,
      RECENT_INSIGHT_QUERY_LIMIT,
    ),
    consecutiveResolveFailures: snapshot.consecutiveResolveFailures,
    dailySendAnchorDay: snapshot.dailySendAnchorDay,
    dailySendCount: snapshot.dailySendCount,
    lastReEngageAttemptAt: maxTimestamp(
      current.lastReEngageAttemptAt,
      snapshot.lastReEngageAttemptAt,
    ),
    // Deliberately kept from `current` (reply-path owned):
    // topicBandits, promptBandits, modeBandits, optimalFrequencyHours,
    // suppressUntil, consecutiveNoResponses, lastNoResponseAt.
  };
}

/**
 * Map the scheduler event that produced an insight onto `InsightRecord`'s
 * trigger vocabulary. Timer ticks are the periodic "scheduled" path; every
 * event-source trigger (persona change, info scan, evolution/activity scan,
 * external) is an "event".
 */
export function resolveInsightTriggerSource(
  eventType: SchedulerEvent["type"] | undefined,
): InsightRecord["triggerSource"] {
  if (!eventType || eventType === "timer") {
    return "scheduled";
  }
  return "event";
}

/**
 * Build the persisted record at insight-generation time. `deliveredAt` is
 * intentionally absent: it is written only after the channel confirms
 * delivery (heartbeat outcome), not when the insight is enqueued.
 */
export function createInsightRecord(
  candidate: InsightCandidate,
  triggerSource: InsightRecord["triggerSource"],
  generatedAt: number,
): InsightRecord {
  return {
    id: candidate.id,
    generatedAt,
    triggerSource,
    targetDomains: candidate.targetDomains,
    sourceDomains: candidate.sourceDomains,
    content: candidate.content,
    rationale: candidate.rationale,
    sources: candidate.sources,
    resolvedMode: candidate.resolvedMode,
    promptVariant: candidate.promptVariant,
    ...(candidate.gateSnapshot ? { gateSnapshot: candidate.gateSnapshot } : {}),
  };
}

/**
 * Apply a `delivered: false` outcome to the persisted persona.
 *
 * A failed delivery is kept as `pendingInsightDelivery` for a later handshake,
 * but it must not consume pacing or dedup state: `lastProactiveAt` stays put
 * and the `recentInsight*` windows are untouched. Advancing them here would
 * make an undelivered insight suppress the next real send and double-count the
 * dedup window.
 */
export function applyUndeliveredInsightOutcome(
  persona: PersonaTree,
  insightId: string,
  record: InsightRecord,
): PersonaTree {
  const awaiting = persona.feedbackProfile.awaitingDeliveryConfirmation;
  const matching = awaiting?.candidate.id === insightId ? awaiting : undefined;
  const existing = persona.feedbackProfile.pendingInsightDelivery;
  if (existing && existing.generatedAt > record.generatedAt) {
    if (matching) {
      persona.feedbackProfile.awaitingDeliveryConfirmation = null;
    }
    return persona;
  }
  const candidate: InsightCandidate = matching?.candidate ?? {
    id: record.id,
    content: record.content,
    rationale: record.rationale,
    targetDomains: record.targetDomains,
    sourceDomains: record.sourceDomains,
    relevanceScore: 0,
    surpriseScore: 0,
    compositeScore: 0,
    sources: record.sources,
    verificationStatus: "verified",
    ...(record.resolvedMode ? { resolvedMode: record.resolvedMode } : {}),
    ...(record.promptVariant ? { promptVariant: record.promptVariant } : {}),
    ...(record.gateSnapshot ? { gateSnapshot: record.gateSnapshot } : {}),
  };
  persona.feedbackProfile.pendingInsightDelivery = {
    candidate,
    generatedAt: matching?.eventTimestamp ?? record.generatedAt,
    opportunityType: matching?.opportunityType ?? "redelivery",
    attemptCount: (existing?.attemptCount ?? 0) + 1,
  };
  if (matching) {
    persona.feedbackProfile.awaitingDeliveryConfirmation = null;
    // Enqueue time reserved a dedup slot (domains/types) and one daily send.
    // The channel then rejected the message, so release both: otherwise a
    // delivery outage silently silences the domains we just tried and eats
    // the user's daily budget.
    const domains = persona.feedbackProfile.recentInsightDomains;
    const lastDomains = domains?.[domains.length - 1];
    const targetDomains = record.targetDomains;
    if (
      domains &&
      lastDomains &&
      lastDomains.length === targetDomains.length &&
      lastDomains.every((domain, index) => domain === targetDomains[index])
    ) {
      persona.feedbackProfile.recentInsightDomains = domains.slice(0, -1);
    }
    const types = persona.feedbackProfile.recentInsightTypes;
    if (types && types[types.length - 1] === matching.opportunityType) {
      persona.feedbackProfile.recentInsightTypes = types.slice(0, -1);
    }
    releaseDailySend(persona, matching.eventTimestamp);
  }
  return persona;
}
