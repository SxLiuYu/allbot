import { OPERATOR_USER_ID } from "../cognitive/identity.js";
import type { AllBotConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import {
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../sessions/session-key-utils.js";

/**
 * Seed targets — users the agent can address but has never heard from.
 *
 * First contact needs a recipient, and a recipient is only knowable from a
 * channel binding (`lastChannel` + `lastTo`) that a real conversation
 * records. That is the crux of the cold-start deadlock: the binding is
 * written when the user writes, and without it there is nobody to write to.
 *
 * There is one binding that exists before any conversation: the session
 * record itself. Opening a chat with the bot in Feishu (or any channel)
 * creates a session row with the channel and peer already filled in, even
 * though no message was ever answered. Those rows are the seed set: real
 * peers, real routing, zero prior contact.
 *
 * Anything already represented in the persona store is excluded — those
 * users are the ordinary scheduler's business.
 */
export type SeedTarget = {
  agentId: string;
  userId: string;
  channel: string;
  to: string;
  accountId?: string;
};

/** Session keys whose tail is a peer id rather than an internal role. */
function peerIdFromSessionKey(sessionKey: string): string | undefined {
  if (isCronSessionKey(sessionKey) || isSubagentSessionKey(sessionKey)) {
    return undefined;
  }
  if (sessionKey.includes(":group:") && !sessionKey.includes(":sender:")) {
    return undefined;
  }
  // Only real agent-scoped keys describe a peer. A bare "cron:…" or some
  // other non-agent key can leak into the store and must not become a user.
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  const tail = parsed.rest.split(":").pop()?.trim();
  if (!tail || tail === "direct" || tail === "group" || tail === "channel") {
    return undefined;
  }
  return tail === "main" ? OPERATOR_USER_ID : tail.toLowerCase();
}

/**
 * Collect peers that have a routable channel binding but no persona yet.
 * Read-only: seeding writes personas, this only decides who qualifies.
 */
export function listSeedTargets(
  cfg: AllBotConfig | undefined,
  agentId: string,
  knownUserIds: ReadonlySet<string>,
): SeedTarget[] {
  if (!cfg) {
    return [];
  }
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let store: Record<string, { lastChannel?: string; lastTo?: string; lastAccountId?: string }>;
  try {
    store = loadSessionStore(storePath);
  } catch {
    return [];
  }

  const targets: SeedTarget[] = [];
  const seen = new Set<string>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    const channel = entry?.lastChannel;
    const to = entry?.lastTo;
    if (!channel || channel === "none" || !to) {
      continue;
    }
    const userId = peerIdFromSessionKey(sessionKey);
    if (!userId || seen.has(userId) || knownUserIds.has(userId)) {
      continue;
    }
    seen.add(userId);
    targets.push({
      agentId,
      userId,
      channel,
      to,
      ...(entry.lastAccountId ? { accountId: entry.lastAccountId } : {}),
    });
  }
  return targets;
}
