import type { BusinessRequestKind } from "./types.js";

export type BusinessProviderResult =
  | { ok: true; externalReference: string }
  | { ok: false; externalReference?: string; error?: string };

/**
 * Boundary between a human-confirmed business request and an external system.
 * Allbot ships no payment/identity provider: registrations are explicit and
 * process-local. An unregistered provider never executes an external action.
 */
export type BusinessProviderAdapter = {
  id: string;
  kind: BusinessRequestKind;
  execute: (request: {
    requestId: string;
    kind: BusinessRequestKind;
    operation: string;
    summary: string;
  }) => Promise<BusinessProviderResult>;
};

const adapters = new Map<string, BusinessProviderAdapter>();

export function registerBusinessProviderAdapter(adapter: BusinessProviderAdapter): void {
  if (!adapter.id.trim()) {
    throw new Error("business provider adapter requires an id");
  }
  adapters.set(adapter.id, adapter);
}

export function unregisterBusinessProviderAdapter(id: string): void {
  adapters.delete(id);
}

export function listBusinessProviderAdapters(): Array<{ id: string; kind: BusinessRequestKind }> {
  return [...adapters.values()].map(({ id, kind }) => ({ id, kind }));
}

export function resolveBusinessProviderAdapter(
  id: string,
  kind: BusinessRequestKind,
): BusinessProviderAdapter | undefined {
  const adapter = adapters.get(id);
  return adapter?.kind === kind ? adapter : undefined;
}
