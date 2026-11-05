import type { AllBotConfig, HookConfig } from "../config/config.js";
import { resolveHookKey } from "./frontmatter.js";
import type { HookEntry, HookSource } from "./types.js";

export type HookEnableStateReason = "disabled in config" | "workspace hook (disabled by default)";

export type HookEnableState = {
  enabled: boolean;
  reason?: HookEnableStateReason;
};

export type HookSourcePolicy = {
  precedence: number;
  trustedLocalCode: boolean;
  defaultEnableMode: "default-on" | "explicit-opt-in";
  canOverride: HookSource[];
  canBeOverriddenBy: HookSource[];
};

export type HookResolutionCollision = {
  name: string;
  kept: HookEntry;
  ignored: HookEntry;
};

const HOOK_SOURCE_POLICIES: Record<HookSource, HookSourcePolicy> = {
  "allbot-bundled": {
    precedence: 10,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["allbot-bundled"],
    canBeOverriddenBy: ["allbot-managed", "allbot-plugin"],
  },
  "allbot-plugin": {
    precedence: 20,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["allbot-bundled", "allbot-plugin"],
    canBeOverriddenBy: ["allbot-managed"],
  },
  "allbot-managed": {
    precedence: 30,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["allbot-bundled", "allbot-managed", "allbot-plugin"],
    canBeOverriddenBy: ["allbot-managed"],
  },
  "allbot-workspace": {
    precedence: 40,
    trustedLocalCode: true,
    defaultEnableMode: "explicit-opt-in",
    canOverride: ["allbot-workspace"],
    canBeOverriddenBy: ["allbot-workspace"],
  },
};

export function getHookSourcePolicy(source: HookSource): HookSourcePolicy {
  return HOOK_SOURCE_POLICIES[source];
}

export function resolveHookConfig(
  config: AllBotConfig | undefined,
  hookKey: string,
): HookConfig | undefined {
  const hooks = config?.hooks?.internal?.entries;
  if (!hooks || typeof hooks !== "object") {
    return undefined;
  }
  const entry = (hooks as Record<string, HookConfig | undefined>)[hookKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

export function resolveHookEnableState(params: {
  entry: HookEntry;
  config?: AllBotConfig;
  hookConfig?: HookConfig;
}): HookEnableState {
  const { entry, config } = params;
  const hookKey = resolveHookKey(entry.hook.name, entry);
  const hookConfig = params.hookConfig ?? resolveHookConfig(config, hookKey);

  if (entry.hook.source === "allbot-plugin") {
    return { enabled: true };
  }
  if (hookConfig?.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
  }

  const sourcePolicy = getHookSourcePolicy(entry.hook.source);
  if (sourcePolicy.defaultEnableMode === "explicit-opt-in" && hookConfig?.enabled !== true) {
    return { enabled: false, reason: "workspace hook (disabled by default)" };
  }

  return { enabled: true };
}

function canOverrideHook(candidate: HookEntry, existing: HookEntry): boolean {
  const candidatePolicy = getHookSourcePolicy(candidate.hook.source);
  const existingPolicy = getHookSourcePolicy(existing.hook.source);
  return (
    candidatePolicy.canOverride.includes(existing.hook.source) &&
    existingPolicy.canBeOverriddenBy.includes(candidate.hook.source)
  );
}

export function resolveHookEntries(
  entries: HookEntry[],
  opts?: {
    onCollisionIgnored?: (collision: HookResolutionCollision) => void;
  },
): HookEntry[] {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) => {
      const precedenceDelta =
        getHookSourcePolicy(a.entry.hook.source).precedence -
        getHookSourcePolicy(b.entry.hook.source).precedence;
      return precedenceDelta !== 0 ? precedenceDelta : a.index - b.index;
    });

  const merged = new Map<string, HookEntry>();
  for (const { entry } of ordered) {
    const existing = merged.get(entry.hook.name);
    if (!existing) {
      merged.set(entry.hook.name, entry);
      continue;
    }
    if (canOverrideHook(entry, existing)) {
      merged.set(entry.hook.name, entry);
      continue;
    }
    opts?.onCollisionIgnored?.({
      name: entry.hook.name,
      kept: existing,
      ignored: entry,
    });
  }

  return Array.from(merged.values());
}
