import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import { evaluateSchedulerHealth } from "../../cognitive/scheduler/health.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import { getCognitiveSchedulerHealth } from "../cognitive-scheduler-health-registry.js";
import type { ChannelManager } from "../server-channels.js";

export type ReadinessResult = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
};

export type ReadinessChecker = () => ReadinessResult;

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  return health.reason === "not-running" && accountSnapshot.restartPending === true;
}

export function createReadinessChecker(deps: {
  channelManager: ChannelManager;
  startedAt: number;
  cacheTtlMs?: number;
}): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  // Cache only the *channel* portion of readiness. The cognitive-scheduler check
  // is recomputed on every probe (see below) and must never be cached, so we keep
  // it out of `cachedState` and merge it in at the end.
  let cachedAt = 0;
  let cachedChannelFailing: string[] | null = null;

  return (): ReadinessResult => {
    const now = Date.now();
    const uptimeMs = now - startedAt;

    // Cognitive proactive scheduler liveness: a stale scheduler (overdue tick,
    // dead watchdog, stopped-but-should-be-running) marks the gateway not-ready
    // so orchestrators stop routing real traffic to a brain-dead instance.
    // /health/cognitive is the granular path; /ready aggregates it here. This is
    // a NON-CACHED check: it is recomputed on EVERY probe and merged in after the
    // (channel-only) 1s readiness cache, so a fresh stall is never masked behind
    // a cached snapshot of the channels.
    let cognitiveFailing = false;
    try {
      const verdict = evaluateSchedulerHealth(getCognitiveSchedulerHealth(), now);
      cognitiveFailing = !verdict.ok;
    } catch {
      // Registry default (disabled) cannot make readiness fail; an exception
      // here is a provider bug and must not flip the whole gateway red.
    }

    let channelFailing: string[];
    if (cachedChannelFailing && now - cachedAt < cacheTtlMs) {
      channelFailing = cachedChannelFailing;
    } else {
      const snapshot = channelManager.getRuntimeSnapshot();
      channelFailing = [];
      for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
        if (!accounts) {
          continue;
        }
        for (const accountSnapshot of Object.values(accounts)) {
          if (!accountSnapshot) {
            continue;
          }
          const policy: ChannelHealthPolicy = {
            now,
            staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
            channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
            channelId,
            skipStaleSocketCheck: getChannelPlugin(channelId)?.status?.skipStaleSocketHealthCheck,
          };
          const health = evaluateChannelHealth(accountSnapshot, policy);
          if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health)) {
            channelFailing.push(channelId);
            break;
          }
        }
      }
      cachedAt = now;
      cachedChannelFailing = channelFailing;
    }

    const failing = cognitiveFailing
      ? [...channelFailing, "cognitive-scheduler"]
      : channelFailing;
    return { ready: failing.length === 0, failing, uptimeMs };
  };
}
