import { randomUUID } from "node:crypto";
import type { EvolutionUserConfirmation, EvolutionUserDecision } from "./types.js";

/**
 * Short-lived, in-process approvals for mutating evolution actions.
 *
 * The evolution tools never read an approval from model-supplied tool
 * parameters — the host has to hand it in after the user explicitly acted
 * (Control UI, gateway RPC, CLI). This module is that hand-off point: an RPC
 * grants a decision, the next matching tool call consumes it exactly once.
 *
 * Grants are scoped to (agentId, userId) and expire quickly. Losing them on a
 * gateway restart is intentional: a stale approval must not resurrect.
 */

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_ENTRIES_PER_USER = 5;

type DecisionEntry = EvolutionUserDecision & { expiresAt: number };
type DeleteEntry = EvolutionUserConfirmation & { expiresAt: number };

const decisions = new Map<string, DecisionEntry[]>();
const deletions = new Map<string, DeleteEntry[]>();

function scopeKey(agentId: string, userId: string): string {
  return `${agentId}\u0000${userId}`;
}

function pruneExpired<T extends { expiresAt: number }>(entries: T[] | undefined, now: number): T[] {
  if (!entries || entries.length === 0) {
    return [];
  }
  return entries.filter((entry) => entry.expiresAt > now);
}

export type GrantEvolutionDecisionParams = {
  agentId: string;
  userId: string;
  draftId: string;
  skillName: string;
  action: "approve" | "reject";
  ttlMs?: number;
};

/** Record that the user approved/rejected a specific draft. */
export function grantEvolutionDecision(params: GrantEvolutionDecisionParams): DecisionEntry {
  const now = Date.now();
  const entry: DecisionEntry = {
    confirmationId: randomUUID(),
    draftId: params.draftId,
    skillName: params.skillName,
    action: params.action,
    expiresAt: now + (params.ttlMs ?? DEFAULT_TTL_MS),
  };
  const key = scopeKey(params.agentId, params.userId);
  const next = [...pruneExpired(decisions.get(key), now), entry].slice(-MAX_ENTRIES_PER_USER);
  decisions.set(key, next);
  return entry;
}

/**
 * Take the newest unexpired decision for the scope. Single-use: the entry is
 * removed even when the caller turns out not to need it, so a grant cannot be
 * replayed by a later, unrelated tool call.
 */
export function consumeEvolutionDecision(
  agentId: string,
  userId: string,
  draftId?: string,
): EvolutionUserDecision | undefined {
  const key = scopeKey(agentId, userId);
  const now = Date.now();
  const entries = pruneExpired(decisions.get(key), now);
  if (entries.length === 0) {
    decisions.delete(key);
    return undefined;
  }
  const index =
    draftId === undefined
      ? entries.length - 1
      : entries.findLastIndex((entry) => entry.draftId === draftId);
  if (index < 0) {
    decisions.set(key, entries);
    return undefined;
  }
  const [entry] = entries.splice(index, 1);
  if (entries.length === 0) {
    decisions.delete(key);
  } else {
    decisions.set(key, entries);
  }
  if (!entry) {
    return undefined;
  }
  const { expiresAt: _expiresAt, ...decision } = entry;
  return decision;
}

export type GrantSkillDeleteParams = {
  agentId: string;
  userId: string;
  skillName: string;
  ttlMs?: number;
};

/** Record that the user confirmed deleting one specific skill. */
export function grantSkillDeleteConfirmation(params: GrantSkillDeleteParams): DeleteEntry {
  const now = Date.now();
  const entry: DeleteEntry = {
    confirmationId: randomUUID(),
    skillName: params.skillName,
    expiresAt: now + (params.ttlMs ?? DEFAULT_TTL_MS),
  };
  const key = scopeKey(params.agentId, params.userId);
  const next = [...pruneExpired(deletions.get(key), now), entry].slice(-MAX_ENTRIES_PER_USER);
  deletions.set(key, next);
  return entry;
}

/** Take the newest unexpired delete confirmation, optionally for one skill. */
export function consumeSkillDeleteConfirmation(
  agentId: string,
  userId: string,
  skillName?: string,
): EvolutionUserConfirmation | undefined {
  const key = scopeKey(agentId, userId);
  const now = Date.now();
  const entries = pruneExpired(deletions.get(key), now);
  if (entries.length === 0) {
    deletions.delete(key);
    return undefined;
  }
  const index =
    skillName === undefined
      ? entries.length - 1
      : entries.findLastIndex((entry) => entry.skillName === skillName);
  if (index < 0) {
    deletions.set(key, entries);
    return undefined;
  }
  const [entry] = entries.splice(index, 1);
  if (entries.length === 0) {
    deletions.delete(key);
  } else {
    deletions.set(key, entries);
  }
  if (!entry) {
    return undefined;
  }
  const { expiresAt: _expiresAt, ...confirmation } = entry;
  return confirmation;
}

/** Test hook: drop all in-process grants. */
export function resetEvolutionApprovalsForTest(): void {
  decisions.clear();
  deletions.clear();
}
