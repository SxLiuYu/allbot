import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import {
  listBusinessProviderAdapters,
  registerBusinessProviderAdapter,
  resolveBusinessProviderAdapter,
  unregisterBusinessProviderAdapter,
  type BusinessProviderAdapter,
} from "./provider-registry.js";
import { createBusinessRequestStore } from "./store.js";
import {
  cancelBusinessRequest,
  confirmBusinessRequest,
  createBusinessRequest,
  dispatchBusinessRequest,
  getBusinessRequest,
  hashBusinessConfirmationToken,
} from "./workflow.js";

const dirs: string[] = [];
const providers: string[] = [];

afterEach(async () => {
  await drainSessionWriteLockStateForTest();
  for (const id of providers.splice(0)) {
    unregisterBusinessProviderAdapter(id);
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "allbot-business-"));
  dirs.push(dir);
  return createBusinessRequestStore({ filePath: path.join(dir, "requests.json") });
}

function prepare(store = makeStore()) {
  return createBusinessRequest({
    store,
    ownerId: "ou_owner",
    kind: "payment",
    operation: "verify-account",
    summary: "Identity check for a payment account",
    providerId: "test-payment",
  });
}

function adapter(overrides: Partial<BusinessProviderAdapter> = {}): BusinessProviderAdapter {
  return {
    id: "test-payment",
    kind: "payment",
    execute: async ({ requestId }) => ({ ok: true, externalReference: `ref:${requestId}` }),
    ...overrides,
  };
}

describe("business request workflow", () => {
  it("keeps only a digest of the human confirmation token", async () => {
    const store = makeStore();
    const created = await prepare(store);
    expect(created.ok).toBe(true);
    if (!created.ok || !created.token) {
      throw new Error("prepare failed");
    }
    expect(created.request.status).toBe("awaiting_confirmation");
    expect(created.request.confirmationDigest).toBe(hashBusinessConfirmationToken(created.token));
    expect(JSON.stringify(await store.read())).not.toContain(created.token);
  });

  it("refuses dispatch before a matching human confirmation", async () => {
    const store = makeStore();
    const created = await prepare(store);
    if (!created.ok || !created.token) {
      throw new Error("prepare failed");
    }
    const unconfirmed = await dispatchBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      resolveAdapter: () => adapter(),
    });
    expect(unconfirmed.ok).toBe(false);
    if (unconfirmed.ok) {
      throw new Error("dispatch should have been refused");
    }
    expect(unconfirmed.code).toBe("illegal_transition");
    expect((await getBusinessRequest(store, created.request.requestId))?.status).toBe(
      "awaiting_confirmation",
    );

    const wrongToken = await confirmBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      token: "not-the-token",
    });
    expect(wrongToken.ok).toBe(false);
    if (wrongToken.ok) {
      throw new Error("wrong token should have been refused");
    }
    expect(wrongToken.code).toBe("invalid_confirmation");

    const confirmed = await confirmBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      token: created.token,
    });
    expect(confirmed.ok).toBe(true);
    expect((await getBusinessRequest(store, created.request.requestId))?.status).toBe("confirmed");
  });

  it("makes no external call when no provider is registered", async () => {
    const store = makeStore();
    const created = await prepare(store);
    if (!created.ok || !created.token) {
      throw new Error("prepare failed");
    }
    await confirmBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      token: created.token,
    });
    let calls = 0;
    const dispatched = await dispatchBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      resolveAdapter: () => {
        calls += 1;
        return undefined;
      },
    });
    expect(dispatched.ok).toBe(false);
    if (dispatched.ok) {
      throw new Error("dispatch should have reported a missing provider");
    }
    expect(dispatched.code).toBe("provider_not_registered");
    expect(calls).toBe(1);
    expect((await getBusinessRequest(store, created.request.requestId))?.status).toBe("confirmed");
  });

  it("calls a registered provider only after human confirmation", async () => {
    const store = makeStore();
    const created = await prepare(store);
    if (!created.ok || !created.token) {
      throw new Error("prepare failed");
    }
    await confirmBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      token: created.token,
    });
    const provider = adapter();
    const dispatched = await dispatchBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      resolveAdapter: (request) => (request.kind === provider.kind ? provider : undefined),
    });
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) {
      throw new Error(dispatched.message);
    }
    expect(dispatched.request.status).toBe("completed");
    expect(dispatched.request.externalReference).toBe(`ref:${created.request.requestId}`);
    expect(dispatched.request.events.map((event) => event.to)).toEqual([
      "awaiting_confirmation",
      "confirmed",
      "provider_pending",
      "completed",
    ]);
  });

  it("returns to confirmed when a provider call fails", async () => {
    const store = makeStore();
    const created = await prepare(store);
    if (!created.ok || !created.token) {
      throw new Error("prepare failed");
    }
    await confirmBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      token: created.token,
    });
    const failed = await dispatchBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      resolveAdapter: () =>
        adapter({ execute: async () => ({ ok: false, error: "provider unavailable" }) }),
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      throw new Error(failed.message);
    }
    expect(failed.request.status).toBe("confirmed");
    expect(failed.request.error).toBe("provider unavailable");
  });

  it("persists expiry before a late dispatch and never calls the provider", async () => {
    const store = makeStore();
    const now = 1_700_000_000_000;
    const created = await createBusinessRequest({
      store,
      ownerId: "ou_owner",
      kind: "payment",
      operation: "verify-account",
      summary: "Identity check for a payment account",
      ttlMs: 1,
      now,
    });
    if (!created.ok || !created.token) {
      throw new Error("prepare failed");
    }
    await confirmBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      token: created.token,
      now,
    });
    let calls = 0;
    const late = await dispatchBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      now: now + 2,
      resolveAdapter: () => {
        calls += 1;
        return adapter();
      },
    });
    expect(late.ok).toBe(false);
    expect((await getBusinessRequest(store, created.request.requestId))?.status).toBe("expired");
    expect(calls).toBe(0);
  });

  it("expires an unconfirmed request and enforces the owner boundary", async () => {
    const store = makeStore();
    const now = 1_700_000_000_000;
    const created = await createBusinessRequest({
      store,
      ownerId: "ou_owner",
      kind: "identity",
      operation: "verify-name",
      summary: "Compare a name with an identity document",
      ttlMs: 0,
      now,
    });
    if (!created.ok || !created.token) {
      throw new Error("prepare failed");
    }
    const otherOwner = await confirmBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_other",
      token: created.token,
      now,
    });
    expect(otherOwner.ok).toBe(false);
    if (otherOwner.ok) {
      throw new Error("cross-owner confirmation should have been refused");
    }
    expect(otherOwner.code).toBe("forbidden");
    const expired = await confirmBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
      token: created.token,
      now,
    });
    expect(expired.ok).toBe(false);
    if (expired.ok) {
      throw new Error("expired confirmation should have been refused");
    }
    expect(expired.code).toBe("expired");
    expect((await getBusinessRequest(store, created.request.requestId))?.status).toBe("expired");
  });

  it("allows an owner to cancel before confirmation", async () => {
    const store = makeStore();
    const created = await prepare(store);
    if (!created.ok) {
      throw new Error("prepare failed");
    }
    const cancelled = await cancelBusinessRequest({
      store,
      requestId: created.request.requestId,
      ownerId: "ou_owner",
    });
    expect(cancelled.ok).toBe(true);
    expect((await getBusinessRequest(store, created.request.requestId))?.status).toBe("cancelled");
  });

  it("matches provider adapters by registered id and business kind", () => {
    const provider = adapter();
    providers.push(provider.id);
    registerBusinessProviderAdapter(provider);
    expect(resolveBusinessProviderAdapter("test-payment", "payment")).toBe(provider);
    expect(resolveBusinessProviderAdapter("test-payment", "identity")).toBeUndefined();
    expect(listBusinessProviderAdapters()).toContainEqual({ id: "test-payment", kind: "payment" });
  });
});
