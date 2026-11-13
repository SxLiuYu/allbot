/**
 * Feishu outbound send rate limiting.
 *
 * Provides a self-contained, injectable token bucket plus retry/backoff wiring
 * for Feishu outbound sends. Everything here is pure and deterministic so it can
 * be unit-tested with a fake clock/sleep — no real timers or network access.
 *
 * IMPORTANT: The default token-bucket parameters (capacity 5, refill 1 token/s)
 * are intentionally CONSERVATIVE placeholder values. They are NOT the official
 * Feishu API quota — Feishu publishes different, account-dependent limits and we
 * do not hard-code them. Callers (e.g. the production adapter wiring) should pick
 * bucket sizes appropriate for their deployment. The conservative default exists
 * so the pure functions have sensible out-of-the-box behavior and so tests can
 * rely on a stable default shape.
 */

// ---------------------------------------------------------------------------
// Rate-limit error recognition
// ---------------------------------------------------------------------------

/**
 * Feishu outbound rate-limit codes we retry with backoff.
 *
 * - 429: HTTP 429 surfaced by the SDK / Axios layer.
 * - 99991400: too many requests per second.
 * - 99991403: monthly API call quota exceeded.
 * - 230020: CardKit send frequency limit (see card-error.ts `RATE_LIMITED`).
 * - 11232: rate-limit code returned inline in some Feishu SDK responses.
 */
export const FEISHU_OUTBOUND_RATE_LIMIT_CODES = new Set<number>([
  429, 99991400, 99991403, 230020, 11232,
]);

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Extract a Feishu rate-limit code from an arbitrary thrown error, or `undefined`.
 *
 * Handles the shapes we observe in practice:
 *   1. top-level `{ code }`
 *   2. `{ data: { code } }`
 *   3. Axios-style `{ response: { status, data: { code } } }`
 *   4. the code appearing as a substring in an error/response message
 *      (Feishu sometimes embeds `code: 11232` text in `msg`).
 */
export function extractFeishuOutboundRateLimitCode(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") {
    return undefined;
  }

  const e = err as {
    code?: unknown;
    data?: { code?: unknown };
    response?: { status?: unknown; data?: { code?: unknown; msg?: unknown } };
    message?: unknown;
    msg?: unknown;
  };

  const candidates: number[] = [];
  const maybe = asNumber(e.code);
  if (maybe !== undefined) {
    candidates.push(maybe);
  }
  const maybeData = asNumber(e.data?.code);
  if (maybeData !== undefined) {
    candidates.push(maybeData);
  }
  const maybeResponse = asNumber(e.response?.data?.code);
  if (maybeResponse !== undefined) {
    candidates.push(maybeResponse);
  }
  if (e.response?.status === 429) {
    candidates.push(429);
  }

  // Fall back to scanning the message text for a known code substring.
  const message = [
    typeof e.message === "string" ? e.message : "",
    typeof e.msg === "string" ? e.msg : "",
    typeof e.response?.data?.msg === "string" ? e.response.data.msg : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (message) {
    for (const code of FEISHU_OUTBOUND_RATE_LIMIT_CODES) {
      if (message.includes(String(code))) {
        candidates.push(code);
        break;
      }
    }
  }

  for (const code of candidates) {
    if (FEISHU_OUTBOUND_RATE_LIMIT_CODES.has(code)) {
      return code;
    }
  }
  return undefined;
}

/** True when the error represents a Feishu outbound rate-limit condition. */
export function isFeishuOutboundRateLimitError(err: unknown): boolean {
  return extractFeishuOutboundRateLimitCode(err) !== undefined;
}

// ---------------------------------------------------------------------------
// Retry-After / retry_after parsing
// ---------------------------------------------------------------------------

function delayFromSecondsOrHttpDate(value: unknown, now: number): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    // Feishu `retry_after` is expressed in seconds. For large numeric values we
    // assume milliseconds to stay tolerant of either unit.
    if (value <= 0) {
      return undefined;
    }
    return value < 1000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    // Delta-seconds, e.g. "120".
    if (/^-?\d+$/.test(trimmed)) {
      const seconds = Number(trimmed);
      return seconds > 0 ? seconds * 1000 : undefined;
    }
    // HTTP-date, e.g. "Wed, 21 Oct 2026 07:28:00 GMT".
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return Math.max(0, parsed - now);
    }
  }
  return undefined;
}

function readRetryAfterHeader(err: unknown, now: number): number | undefined {
  const response = (err as { response?: { headers?: unknown } })?.response;
  const headers = response?.headers as
    | { get?: (name: string) => string | null | undefined }
    | Record<string, string | null | undefined>
    | undefined;
  if (!headers) {
    return undefined;
  }
  const raw =
    typeof headers.get === "function"
      ? headers.get("retry-after")
      : (headers as Record<string, string | null | undefined>)["retry-after"];
  return delayFromSecondsOrHttpDate(raw, now);
}

/**
 * Parse a wait hint (in milliseconds) from a Feishu rate-limit error.
 *
 * Considers, in order of preference:
 *   - an HTTP `Retry-After` header (delta-seconds or HTTP-date)
 *   - a body/error `retryAfter` field (seconds or ms)
 *   - a body/error `retry_after` field (seconds or ms)
 *
 * Returns `undefined` when no usable hint is present. `now` is injectable for
 * deterministic tests against HTTP-date values.
 */
export function parseFeishuRetryAfterMs(
  err: unknown,
  now: number = Date.now(),
): number | undefined {
  const header = readRetryAfterHeader(err, now);
  if (header !== undefined) {
    return header;
  }

  const e = err as { retryAfter?: unknown; retry_after?: unknown };
  const retryAfter = delayFromSecondsOrHttpDate(e.retryAfter, now);
  if (retryAfter !== undefined) {
    return retryAfter;
  }
  return delayFromSecondsOrHttpDate(e.retry_after, now);
}

// ---------------------------------------------------------------------------
// Injectable token bucket
// ---------------------------------------------------------------------------

export type TokenBucketClock = {
  /** Returns the current time in milliseconds. */
  now: () => number;
  /** Resolves after `ms` milliseconds. Injectable for tests. */
  sleep: (ms: number) => Promise<void>;
};

export type TokenBucketOptions = {
  /** Maximum number of tokens the bucket can hold. Default 5 (conservative). */
  capacity?: number;
  /** Tokens added per second. Default 1 (conservative). */
  refillPerSec?: number;
  /** Clock override (for tests). Defaults to `Date.now` + real `setTimeout`. */
  clock?: TokenBucketClock;
};

export type TokenBucket = {
  readonly capacity: number;
  readonly refillPerSec: number;
  /** Consume `tokens`, waiting (via the injected sleep) until enough accrue. */
  acquire: (tokens?: number) => Promise<void>;
  /** Try to consume `tokens` immediately; returns false without waiting if unavailable. */
  tryAcquire: (tokens?: number) => boolean;
  /** Current token count (after a lazy refill against the clock). */
  available: () => number;
};

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create an injectable token bucket.
 *
 * Refill is computed lazily from the clock, so `acquire` never busy-loops: it
 * calculates exactly how long to wait for the needed deficit and sleeps once.
 * The default capacity/refill are conservative placeholders (see module header)
 * and are NOT Feishu official quotas.
 */
export function createTokenBucket(options: TokenBucketOptions = {}): TokenBucket {
  const capacity = options.capacity ?? 5;
  const refillPerSec = options.refillPerSec ?? 1;
  const clock = options.clock ?? { now: Date.now, sleep: realSleep };

  let tokens = capacity;
  let lastRefill = clock.now();

  function refill() {
    const t = clock.now();
    const elapsedSec = (t - lastRefill) / 1000;
    if (elapsedSec > 0) {
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
      lastRefill = t;
    }
  }

  function tryAcquire(n = 1): boolean {
    refill();
    if (tokens >= n) {
      tokens -= n;
      return true;
    }
    return false;
  }

  async function acquire(n = 1): Promise<void> {
    if (n > capacity) {
      throw new Error(
        `token bucket request ${n} exceeds capacity ${capacity} (cannot ever satisfy)`,
      );
    }
    for (;;) {
      refill();
      if (tokens >= n) {
        tokens -= n;
        return;
      }
      const deficit = n - tokens;
      const waitMs = Math.ceil((deficit / refillPerSec) * 1000);
      await clock.sleep(waitMs);
      // loop: refill + re-check with fresh clock time
    }
  }

  return {
    capacity,
    refillPerSec,
    acquire,
    tryAcquire,
    available: () => {
      refill();
      return tokens;
    },
  };
}

// ---------------------------------------------------------------------------
// Retry/backoff wrapper
// ---------------------------------------------------------------------------

export type FeishuSendRateLimitOptions = {
  /** Shared bucket across calls; defaults to a conservative new bucket. */
  tokenBucket?: TokenBucket;
  /** Total attempts (1 initial + N retries). Default 4 (1 + 3 retries). */
  maxAttempts?: number;
  /** Base delay for exponential backoff when no Retry-After hint is present. Default 1000ms. */
  baseDelayMs?: number;
  /** Hard cap on a single backoff wait. Default 30_000ms. */
  maxSingleDelayMs?: number;
  /** Hard cap on cumulative backoff across all attempts. Default 60_000ms. */
  maxTotalDelayMs?: number;
  /** Clock override for parsing Retry-After dates and bounding waits. */
  clock?: TokenBucketClock;
};

/**
 * Run `fn` under the outbound rate limiter.
 *
 * Flow:
 *   1. Acquire a token from the bucket (waiting if the bucket is drained).
 *   2. Invoke `fn`. Any non-rate-limit error is re-thrown immediately —
 *      semantics of the wrapped call (e.g. reply→fallback) are preserved.
 *   3. On a rate-limit error, wait `max(baseDelay * 2^attempt, retryAfterMs)`
 *      (capped per-wait at `maxSingleDelayMs` and overall at `maxTotalDelayMs`),
 *      then retry, up to `maxAttempts` total attempts. Retries exhausted → the
 *      original error is re-thrown.
 *
 *      The server-provided Retry-After / retry_after hint is always respected as
 *      a *floor*: we never shorten the server-advised wait (e.g. to satisfy a
 *      tight exponential-backoff budget), because obeying the server's throttle
 *      is what actually prevents being throttled again. When no hint is present
 *      we fall back to pure exponential backoff; the result is still bounded by
 *      the per-wait and total caps.
 *
 * The bounds guarantee we never dead-wait: a single wait is <= `maxSingleDelayMs`
 * (default 30s) and all waits combined are <= `maxTotalDelayMs` (default 60s).
 */
export async function withFeishuSendRateLimit<T>(
  fn: () => Promise<T>,
  options: FeishuSendRateLimitOptions = {},
): Promise<Awaited<T>> {
  const tokenBucket = options.tokenBucket ?? createTokenBucket();
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxSingleDelayMs = options.maxSingleDelayMs ?? 30_000;
  const maxTotalDelayMs = options.maxTotalDelayMs ?? 60_000;
  const clock = options.clock ?? { now: Date.now, sleep: realSleep };

  let totalWaited = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await tokenBucket.acquire(1);
    try {
      return await fn();
    } catch (err) {
      if (!isFeishuOutboundRateLimitError(err)) {
        throw err;
      }
      if (attempt >= maxAttempts) {
        throw err;
      }

      const hint = parseFeishuRetryAfterMs(err, clock.now());
      const expDelay = baseDelayMs * 2 ** attempt; // attempt is 1-based failure count
      // Respect the server hint as a floor: never shorten the server-advised
      // wait to fit the exponential backoff. When no hint is present we use the
      // pure exponential backoff value.
      let delayMs = hint == null ? expDelay : Math.max(expDelay, hint);
      delayMs = Math.min(delayMs, maxSingleDelayMs);
      if (totalWaited + delayMs > maxTotalDelayMs) {
        delayMs = Math.max(0, maxTotalDelayMs - totalWaited);
      }
      totalWaited += delayMs;
      if (delayMs > 0) {
        await clock.sleep(delayMs);
      }
    }
  }

  // Unreachable: the loop always returns or throws before exhausting.
  throw new Error("feishu outbound rate limit: exhausted attempts without result");
}
