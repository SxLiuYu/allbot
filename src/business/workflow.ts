import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { writeTextAtomic } from "../infra/json-files.js";
import type {
  BusinessProviderAdapter,
  BusinessProviderResult,
} from "./provider-registry.js";
import type { BusinessRequestStore } from "./store.js";
import {
  BUSINESS_REQUEST_DEFAULT_TTL_MS,
  BUSINESS_REQUEST_EVENT_LIMIT,
  BUSINESS_REQUEST_KINDS,
  type BusinessRequestKind,
  type BusinessRequestRecord,
  type BusinessRequestStatus,
  type BusinessRequestStoreData,
} from "./types.js";

export type BusinessRequestErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "expired"
  | "invalid_confirmation"
  | "illegal_transition"
  | "provider_not_registered"
  | "provider_failed";

export type BusinessRequestActionResult =
  | { ok: true; request: BusinessRequestRecord; token?: string }
  | {
      ok: false;
      code: BusinessRequestErrorCode;
      message: string;
      request?: BusinessRequestRecord;
    };

const KIND_SET = new Set<string>(BUSINESS_REQUEST_KINDS);

const ACTIVE_STATUSES = new Set<BusinessRequestStatus>([
  "awaiting_confirmation",
  "confirmed",
  "provider_pending",
]);

const TRANSITIONS: Readonly<Record<BusinessRequestStatus, readonly BusinessRequestStatus[]>> = {
  awaiting_confirmation: ["confirmed", "cancelled", "expired"],
  confirmed: ["provider_pending", "cancelled", "expired"],
  provider_pending: ["completed", "confirmed", "cancelled", "expired"],
  completed: [],
  cancelled: [],
  expired: [],
};

/** Short, human-readable confirmation token. It is never stored in plaintext. */
export function createBusinessConfirmationToken(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

export function hashBusinessConfirmationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeTokenMatch(provided: string, expectedDigest: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expected = Buffer.from(expectedDigest, "hex");
  return expected.length === providedDigest.length && timingSafeEqual(providedDigest, expected);
}

function appendEvent(
  request: BusinessRequestRecord,
  event: BusinessRequestRecord["events"][number],
): void {
  request.events.push(event);
  if (request.events.length > BUSINESS_REQUEST_EVENT_LIMIT) {
    request.events.splice(0, request.events.length - BUSINESS_REQUEST_EVENT_LIMIT);
  }
}

function findRequest(
  data: BusinessRequestStoreData,
  requestId: string,
): BusinessRequestRecord | undefined {
  return data.requests.find((request) => request.requestId === requestId);
}

function applyExpiry(request: BusinessRequestRecord, now: number): void {
  if (!ACTIVE_STATUSES.has(request.status) || now < request.expiresAt) {
    return;
  }
  const from = request.status;
  request.status = "expired";
  request.revision += 1;
  request.updatedAt = now;
  appendEvent(request, {
    at: now,
    from,
    to: "expired",
    actor: "system:expiry",
    note: "Confirmation window elapsed.",
  });
}

/**
 * The token is written to a 0600 owner-only outbox instead of being returned to
 * the model-facing tool. Confirmation must be supplied by the owner through a
 * separate trusted client.
 */
export async function writeBusinessConfirmationToken(
  requestId: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const filePath = path.join(resolveStateDir(env), "business", "confirmation-tokens", `${requestId}.token`);
  await writeTextAtomic(filePath, token, { mode: 0o600, ensureDirMode: 0o700 });
  return filePath;
}

export function resolveBusinessConfirmationTokenPath(
  requestId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "business", "confirmation-tokens", `${requestId}.token`);
}

/** Create a request that cannot execute anything until the owner confirms it. */
export async function createBusinessRequest(input: {
  store: BusinessRequestStore;
  ownerId: string;
  kind: BusinessRequestKind;
  operation: string;
  summary: string;
  providerId?: string;
  ttlMs?: number;
  now?: number;
  actor?: string;
}): Promise<BusinessRequestActionResult> {
  const ownerId = input.ownerId.trim();
  const operation = input.operation.trim();
  const summary = input.summary.trim();
  if (!ownerId || !KIND_SET.has(input.kind) || !operation || !summary) {
    return {
      ok: false,
      code: "invalid_request",
      message: "ownerId, kind, operation and summary are required.",
    };
  }
  if (summary.length > 2000) {
    return { ok: false, code: "invalid_request", message: "summary is too long." };
  }
  const now = input.now ?? Date.now();
  const token = createBusinessConfirmationToken();
  const request: BusinessRequestRecord = {
    requestId: `business_${randomUUID()}`,
    ownerId,
    kind: input.kind,
    operation,
    summary,
    confirmationDigest: hashBusinessConfirmationToken(token),
    status: "awaiting_confirmation",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + (input.ttlMs ?? BUSINESS_REQUEST_DEFAULT_TTL_MS),
    ...(input.providerId?.trim() ? { providerId: input.providerId.trim() } : {}),
    events: [
      { at: now, from: "created", to: "awaiting_confirmation", actor: input.actor ?? "system" },
    ],
  };
  await input.store.update((data) => {
    data.requests.push(request);
    return { data, result: undefined };
  });
  return { ok: true, request, token };
}

export async function listBusinessRequests(
  store: BusinessRequestStore,
  ownerId?: string,
): Promise<BusinessRequestRecord[]> {
  const data = await store.read();
  return data.requests
    .filter((request) => !ownerId || request.ownerId === ownerId)
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export async function getBusinessRequest(
  store: BusinessRequestStore,
  requestId: string,
): Promise<BusinessRequestRecord | undefined> {
  const data = await store.read();
  return findRequest(data, requestId);
}

/** Owner confirms the displayed token. No provider call happens here. */
export async function confirmBusinessRequest(input: {
  store: BusinessRequestStore;
  requestId: string;
  ownerId: string;
  token: string;
  actor?: string;
  now?: number;
}): Promise<BusinessRequestActionResult> {
  const now = input.now ?? Date.now();
  return await input.store.update<BusinessRequestActionResult>((data) => {
    const request = findRequest(data, input.requestId);
    if (!request) {
      return {
        data: null,
        result: {
          ok: false as const,
          code: "not_found" as const,
          message: `Business request ${input.requestId} not found.`,
        },
      };
    }
    if (request.ownerId !== input.ownerId) {
      return {
        data: null,
        result: {
          ok: false as const,
          code: "forbidden" as const,
          message: "Only the owning user can confirm this request.",
          request,
        },
      };
    }
    applyExpiry(request, now);
    if (request.status === "expired") {
      return {
        data,
        result: {
          ok: false as const,
          code: "expired" as const,
          message: "Business request confirmation window elapsed.",
          request,
        },
      };
    }
    if (request.status !== "awaiting_confirmation") {
      return {
        data: null,
        result: {
          ok: false as const,
          code: "illegal_transition" as const,
          message: `Business request is already ${request.status}.`,
          request,
        },
      };
    }
    if (!constantTimeTokenMatch(input.token, request.confirmationDigest)) {
      return {
        data: null,
        result: {
          ok: false as const,
          code: "invalid_confirmation" as const,
          message: "Confirmation token does not match.",
          request,
        },
      };
    }
    const from = request.status;
    request.status = "confirmed";
    request.confirmedBy = input.ownerId;
    request.revision += 1;
    request.updatedAt = now;
    appendEvent(request, {
      at: now,
      from,
      to: "confirmed",
      actor: input.actor ?? `owner:${input.ownerId}`,
    });
    return { data, result: { ok: true as const, request } };
  });
}

async function transition(input: {
  store: BusinessRequestStore;
  requestId: string;
  ownerId: string;
  to: BusinessRequestStatus;
  actor: string;
  now?: number;
  note?: string;
  patch?: (request: BusinessRequestRecord) => void;
}): Promise<BusinessRequestActionResult> {
  const now = input.now ?? Date.now();
  return await input.store.update<BusinessRequestActionResult>((data) => {
    const request = findRequest(data, input.requestId);
    if (!request) {
      return {
        data: null,
        result: {
          ok: false as const,
          code: "not_found" as const,
          message: `Business request ${input.requestId} not found.`,
        },
      };
    }
    if (request.ownerId !== input.ownerId) {
      return {
        data: null,
        result: {
          ok: false as const,
          code: "forbidden" as const,
          message: "Only the owning user can change this request.",
          request,
        },
      };
    }
    applyExpiry(request, now);
    if (request.status === "expired") {
      return {
        data,
        result: {
          ok: false as const,
          code: "expired" as const,
          message: "Business request confirmation window elapsed.",
          request,
        },
      };
    }
    if (!TRANSITIONS[request.status].includes(input.to)) {
      return {
        data: null,
        result: {
          ok: false as const,
          code: "illegal_transition" as const,
          message: `Illegal business request transition ${request.status} -> ${input.to}.`,
          request,
        },
      };
    }
    const from = request.status;
    request.status = input.to;
    request.revision += 1;
    request.updatedAt = now;
    input.patch?.(request);
    appendEvent(request, {
      at: now,
      from,
      to: input.to,
      actor: input.actor,
      ...(input.note ? { note: input.note } : {}),
    });
    return { data, result: { ok: true as const, request } };
  });
}

export async function cancelBusinessRequest(input: {
  store: BusinessRequestStore;
  requestId: string;
  ownerId: string;
  actor?: string;
  now?: number;
}): Promise<BusinessRequestActionResult> {
  return await transition({
    store: input.store,
    requestId: input.requestId,
    ownerId: input.ownerId,
    to: "cancelled",
    actor: input.actor ?? `owner:${input.ownerId}`,
    now: input.now,
    note: "Cancelled by owner.",
    patch: (request) => {
      request.cancelledBy = input.ownerId;
    },
  });
}

async function expireBusinessRequestIfNeeded(input: {
  store: BusinessRequestStore;
  requestId: string;
  ownerId: string;
  now: number;
}): Promise<void> {
  await input.store.update<boolean>((data) => {
    const request = findRequest(data, input.requestId);
    if (!request || request.ownerId !== input.ownerId) {
      return { data: null, result: false };
    }
    const from = request.status;
    applyExpiry(request, input.now);
    const changed = request.status !== from;
    return { data: changed ? data : null, result: changed };
  });
}

export type DispatchBusinessRequestResult =
  | BusinessRequestActionResult
  | { ok: false; code: "provider_not_registered"; message: string; request: BusinessRequestRecord };

/**
 * Provider boundary. With no registered adapter the request stays `confirmed`
 * and nothing external is called. Registered adapters are invoked only after a
 * human token has moved the request to `confirmed`.
 */
export async function dispatchBusinessRequest(input: {
  store: BusinessRequestStore;
  requestId: string;
  ownerId: string;
  resolveAdapter: (request: BusinessRequestRecord) => BusinessProviderAdapter | undefined;
  now?: number;
}): Promise<DispatchBusinessRequestResult> {
  const now = input.now ?? Date.now();
  await expireBusinessRequestIfNeeded({
    store: input.store,
    requestId: input.requestId,
    ownerId: input.ownerId,
    now,
  });
  const data = await input.store.read();
  const current = findRequest(data, input.requestId);
  if (!current) {
    return {
      ok: false,
      code: "not_found",
      message: `Business request ${input.requestId} not found.`,
    };
  }
  if (current.ownerId !== input.ownerId) {
    return {
      ok: false,
      code: "forbidden",
      message: "Only the owning user can dispatch this request.",
      request: current,
    };
  }
  if (current.status !== "confirmed") {
    return {
      ok: false,
      code: "illegal_transition",
      message: `Business request must be human-confirmed before dispatch; current status is ${current.status}.`,
      request: current,
    };
  }
  const adapter = input.resolveAdapter(current);
  if (!adapter) {
    return {
      ok: false,
      code: "provider_not_registered",
      message: `No ${current.kind} provider is registered${current.providerId ? ` for ${current.providerId}` : ""}. Request stays confirmed; no external action was taken.`,
      request: current,
    };
  }
  const pending = await transition({
    store: input.store,
    requestId: input.requestId,
    ownerId: input.ownerId,
    to: "provider_pending",
    actor: `provider:${adapter.id}`,
    now,
    patch: (request) => {
      request.providerId = adapter.id;
    },
  });
  if (!pending.ok) {
    return pending;
  }
  let outcome: BusinessProviderResult;
  try {
    outcome = await adapter.execute({
      requestId: current.requestId,
      kind: current.kind,
      operation: current.operation,
      summary: current.summary,
    });
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!outcome.ok) {
    return await transition({
      store: input.store,
      requestId: input.requestId,
      ownerId: input.ownerId,
      to: "confirmed",
      actor: `provider:${adapter.id}`,
      now,
      note: "Provider call failed; request returns to confirmed.",
      patch: (request) => {
        request.error = outcome.error ?? "provider failed";
      },
    });
  }
  return await transition({
    store: input.store,
    requestId: input.requestId,
    ownerId: input.ownerId,
    to: "completed",
    actor: `provider:${adapter.id}`,
    now,
    patch: (request) => {
      request.externalReference = outcome.externalReference ?? `${adapter.id}:${current.requestId}`;
      request.error = undefined;
    },
  });
}
