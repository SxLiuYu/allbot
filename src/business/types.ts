export const BUSINESS_REQUEST_KINDS = ["payment", "identity"] as const;

export type BusinessRequestKind = (typeof BUSINESS_REQUEST_KINDS)[number];

export const BUSINESS_REQUEST_STATUSES = [
  "awaiting_confirmation",
  "confirmed",
  "provider_pending",
  "completed",
  "cancelled",
  "expired",
] as const;

export type BusinessRequestStatus = (typeof BUSINESS_REQUEST_STATUSES)[number];

export type BusinessRequestEvent = {
  at: number;
  from: BusinessRequestStatus | "created";
  to: BusinessRequestStatus;
  actor: string;
  note?: string;
};

/**
 * A human-confirmation envelope for an external payment or identity provider.
 * It stores only an opaque summary and a confirmation token digest. Real
 * credentials, account numbers and provider payloads stay outside this store.
 */
export type BusinessRequestRecord = {
  requestId: string;
  ownerId: string;
  kind: BusinessRequestKind;
  operation: string;
  summary: string;
  /** Payload fingerprint displayed to the owner at confirmation time. */
  confirmationDigest: string;
  status: BusinessRequestStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  providerId?: string;
  confirmedBy?: string;
  cancelledBy?: string;
  externalReference?: string;
  error?: string;
  events: BusinessRequestEvent[];
};

export type BusinessRequestStoreData = {
  version: 1;
  requests: BusinessRequestRecord[];
};

export const BUSINESS_REQUEST_STORE_VERSION = 1;
export const BUSINESS_REQUEST_DEFAULT_TTL_MS = 15 * 60_000;
export const BUSINESS_REQUEST_EVENT_LIMIT = 50;
