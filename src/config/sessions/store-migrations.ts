import type { DmScopeValue } from "../../routing/session-key.js";
import type { SessionEntry } from "./types.js";

const MAIN_SESSION_KEY = "agent:main:main";
const FEISHU_OPEN_ID_PREFIX = "ou_";

function extractFeishuOpenId(lastTo: string | undefined): string | undefined {
  if (!lastTo) {
    return undefined;
  }
  const stripped = lastTo.replace(/^user:/, "");
  if (
    stripped.startsWith(FEISHU_OPEN_ID_PREFIX) &&
    stripped.length > FEISHU_OPEN_ID_PREFIX.length
  ) {
    return stripped;
  }
  return undefined;
}

export type SessionStoreMigrationOptions = {
  /**
   * Resolves the deployment's effective DM scope. When the deployment
   * explicitly uses `dmScope: "main"` (single-owner Router session), the
   * legacy Feishu main-session migration must not move the session away.
   */
  resolveDmScope?: () => DmScopeValue | undefined;
};

export function applySessionStoreMigrations(
  store: Record<string, SessionEntry>,
  options: SessionStoreMigrationOptions = {},
): void {
  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      delete rec.room;
    }
  }

  // AllBot migration: move legacy agent:main:main with feishu delivery to
  // per-user session key (agent:main:feishu:direct:ou_xxx). This ensures
  // existing conversation data is accessible under the new dmScope default.
  // Skip it when the deployment explicitly routed DMs to the main session.
  const legacyEntry = store[MAIN_SESSION_KEY];
  if (legacyEntry) {
    if (options.resolveDmScope?.() === "main") {
      return;
    }
    const isFeishu =
      legacyEntry.lastChannel === "feishu" ||
      legacyEntry.deliveryContext?.channel === "feishu" ||
      legacyEntry.channel === "feishu";
    if (isFeishu) {
      const openId = extractFeishuOpenId(legacyEntry.deliveryContext?.to ?? legacyEntry.lastTo);
      if (openId) {
        const newKey = `agent:main:feishu:direct:${openId}`;
        if (!store[newKey]) {
          store[newKey] = legacyEntry;
        }
        delete store[MAIN_SESSION_KEY];
      }
    }
  }
}
