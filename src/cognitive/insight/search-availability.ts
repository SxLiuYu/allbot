/**
 * Tracks whether the configured web-search backend actually answers.
 *
 * `runWebSearch` throws when every provider is unavailable, and the gateway
 * wrapper swallows that into an empty result list. An empty list is
 * indistinguishable from "the query legitimately matched nothing", so the
 * insight pipeline cannot tell a misconfigured install from a quiet news day —
 * it just generates a source-less insight, fails the source gate, and repeats
 * on every event. Observed in practice as a permanently silent agent with no
 * visible error.
 *
 * This module keeps a small consecutive-failure counter so the scheduler can
 * stop paying for generation that cannot pass the source gate. State is
 * process-global on purpose: the search provider configuration is global too.
 *
 * The unavailable state must expire: skipping generation also skips the search
 * call, so without a probe window a transient outage would lock the pipeline
 * out permanently — adding credentials later would change nothing.
 */

const FAILURES_BEFORE_UNAVAILABLE = 3;
/** After this long, let one generation attempt through to re-probe search. */
const PROBE_INTERVAL_MS = 15 * 60 * 1000;

let consecutiveFailures = 0;
let unavailableSince = 0;

export function recordSearchSuccess(): void {
  consecutiveFailures = 0;
  unavailableSince = 0;
}

export function recordSearchFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURES_BEFORE_UNAVAILABLE && unavailableSince === 0) {
    unavailableSince = Date.now();
  }
}

/**
 * True once search has failed several times in a row with no intervening
 * success. A single transient failure must not demote the pipeline, so the
 * threshold is deliberately above 1.
 */
export function isSearchUnavailable(now: number = Date.now()): boolean {
  if (unavailableSince === 0) {
    return false;
  }
  // Probe window elapsed: report available so one attempt runs and either
  // succeeds (state cleared) or fails (state re-armed by recordSearchFailure).
  if (now - unavailableSince >= PROBE_INTERVAL_MS) {
    unavailableSince = now;
    return false;
  }
  return true;
}

/** Test helper — resets the module state. */
export function resetSearchAvailability(): void {
  consecutiveFailures = 0;
  unavailableSince = 0;
}
