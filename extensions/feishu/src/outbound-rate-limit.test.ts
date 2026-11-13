import { describe, expect, it, vi } from "vitest";
import {
  createTokenBucket,
  extractFeishuOutboundRateLimitCode,
  isFeishuOutboundRateLimitError,
  parseFeishuRetryAfterMs,
  withFeishuSendRateLimit,
  type TokenBucketClock,
} from "./outbound-rate-limit.js";

// ---------------------------------------------------------------------------
// Fake clock / sleep
// ---------------------------------------------------------------------------

class FakeClock implements TokenBucketClock {
  private t = 0;
  calls: number[] = [];

  now = (): number => this.t;

  // sleep advances virtual time immediately (we never actually wait).
  sleep = async (ms: number): Promise<void> => {
    this.calls.push(ms);
    this.t += ms;
  };

  advance(ms: number): void {
    this.t += ms;
  }
}

function makeError(over: Record<string, unknown>): Error {
  return Object.assign(new Error("rate limited"), over);
}

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

describe("createTokenBucket", () => {
  it("starts full at capacity", () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 1, clock });
    expect(bucket.available()).toBe(5);
  });

  it("consumes tokens without waiting when available", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 1, clock });
    await bucket.acquire(1);
    expect(bucket.available()).toBe(4);
    expect(clock.calls).toEqual([]); // no sleep
  });

  it("tryAcquire returns false immediately when insufficient (no wait)", () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 2, refillPerSec: 1, clock });
    expect(bucket.tryAcquire(2)).toBe(true);
    expect(bucket.tryAcquire(1)).toBe(false);
    expect(bucket.available()).toBe(0);
  });

  it("refills over time and waits exactly the deficit", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 1, clock });
    await bucket.acquire(5); // drain
    expect(bucket.available()).toBeCloseTo(0, 5);
    // Request 1 token: deficit 1 at 1 token/sec => wait 1000ms.
    const p = bucket.acquire(1);
    await p;
    expect(clock.calls).toEqual([1000]);
    expect(bucket.available()).toBeCloseTo(0, 5);
  });

  it("throws when request exceeds capacity", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 3, refillPerSec: 1, clock });
    await expect(bucket.acquire(4)).rejects.toThrow(/exceeds capacity/);
  });

  it("refills lazily from elapsed virtual time without sleeping", () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 1, clock });
    clock.advance(3000); // 3 seconds => +3 tokens but capped
    expect(bucket.available()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit error recognition
// ---------------------------------------------------------------------------

describe("isFeishuOutboundRateLimitError", () => {
  it("recognizes code 11232 at top level", () => {
    expect(isFeishuOutboundRateLimitError(makeError({ code: 11232 }))).toBe(true);
  });

  it("recognizes 429 from response.status", () => {
    const err = Object.assign(new Error("http"), {
      response: { status: 429, data: { code: 0 } },
    });
    expect(isFeishuOutboundRateLimitError(err)).toBe(true);
  });

  it("recognizes 99991400 / 99991403 / 230020 in nested data", () => {
    expect(isFeishuOutboundRateLimitError(makeError({ data: { code: 99991400 } }))).toBe(true);
    expect(isFeishuOutboundRateLimitError(makeError({ data: { code: 99991403 } }))).toBe(true);
    expect(isFeishuOutboundRateLimitError(makeError({ data: { code: 230020 } }))).toBe(true);
  });

  it("recognizes codes embedded in message text", () => {
    const err = Object.assign(new Error("request failed code: 11232 and retry later"), {});
    expect(isFeishuOutboundRateLimitError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isFeishuOutboundRateLimitError(makeError({ code: 999999 }))).toBe(false);
    expect(isFeishuOutboundRateLimitError(makeError({ code: 230011 }))).toBe(false);
    expect(isFeishuOutboundRateLimitError(new Error("boom"))).toBe(false);
    expect(isFeishuOutboundRateLimitError(null)).toBe(false);
    expect(isFeishuOutboundRateLimitError(undefined)).toBe(false);
  });

  it("extractFeishuOutboundRateLimitCode returns the matched code", () => {
    expect(extractFeishuOutboundRateLimitCode(makeError({ code: 11232 }))).toBe(11232);
    expect(extractFeishuOutboundRateLimitCode(makeError({ data: { code: 230020 } }))).toBe(230020);
  });
});

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

describe("parseFeishuRetryAfterMs", () => {
  it("parses Retry-After header (delta seconds)", () => {
    const err = { response: { headers: new Map([["retry-after", "5"]]) } };
    expect(parseFeishuRetryAfterMs(err, 1000)).toBe(5000);
  });

  it("parses Retry-After header (HTTP date) using now", () => {
    const now = 1_000_000_000_000;
    const future = new Date(now + 8000).toUTCString();
    const err = { response: { headers: new Map([["retry-after", future]]) } };
    expect(parseFeishuRetryAfterMs(err, now)).toBe(8000);
  });

  it("parses body retryAfter in seconds", () => {
    expect(parseFeishuRetryAfterMs(makeError({ retryAfter: 3 }), 0)).toBe(3000);
  });

  it("parses body retry_after (already milliseconds) leniently", () => {
    expect(parseFeishuRetryAfterMs(makeError({ retry_after: 1500 }), 0)).toBe(1500);
  });

  it("returns undefined when no hint present", () => {
    expect(parseFeishuRetryAfterMs(makeError({ code: 11232 }), 0)).toBeUndefined();
  });

  it("ignores non-positive hints", () => {
    expect(parseFeishuRetryAfterMs(makeError({ retryAfter: 0 }), 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// withFeishuSendRateLimit
// ---------------------------------------------------------------------------

describe("withFeishuSendRateLimit", () => {
  it("succeeds immediately without waiting when fn passes", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 1, refillPerSec: 1, clock });
    const fn = vi.fn(async () => "ok");
    const result = await withFeishuSendRateLimit(fn, { tokenBucket: bucket, clock });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.calls).toEqual([]);
  });

  it("retries on a rate-limit error and succeeds", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 5, clock });
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw makeError({ code: 11232 });
      }
      return "recovered";
    });
    const result = await withFeishuSendRateLimit(fn, {
      tokenBucket: bucket,
      clock,
      baseDelayMs: 1000,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    // Backoff wait uses max(retryAfterMs, baseDelay*2^attempt); no hint => 2000ms.
    expect(clock.calls).toEqual([2000]);
  });

  it("uses Retry-After hint as a floor (never shorter than the server-advised wait)", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 5, clock });
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw makeError({ code: 429, retryAfter: 3 });
      }
      return "ok";
    });
    await withFeishuSendRateLimit(fn, { tokenBucket: bucket, clock, baseDelayMs: 1000 });
    // hint 3000ms vs exp 2000ms => max (respect server floor) => 3000ms.
    expect(clock.calls).toEqual([3000]);
  });

  it("uses exponential backoff when Retry-After hint is shorter than exp", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 5, clock });
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw makeError({ code: 429, retryAfter: 1 });
      }
      return "ok";
    });
    await withFeishuSendRateLimit(fn, { tokenBucket: bucket, clock, baseDelayMs: 1000 });
    // hint 1000ms vs exp 2000ms => max => 2000ms (floor, not shortened).
    expect(clock.calls).toEqual([2000]);
  });

  it("re-throws a non-rate-limit error immediately without retry", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 5, clock });
    const fn = vi.fn(async () => {
      throw makeError({ code: 999999 });
    });
    await expect(withFeishuSendRateLimit(fn, { tokenBucket: bucket, clock })).rejects.toThrow(
      "rate limited",
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.calls).toEqual([]);
  });

  it("throws the original error after exhausting retries", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 5, clock });
    const fn = vi.fn(async () => {
      throw makeError({ code: 11232 });
    });
    await expect(
      withFeishuSendRateLimit(fn, { tokenBucket: bucket, clock, maxAttempts: 4, baseDelayMs: 1 }),
    ).rejects.toThrow("rate limited");
    // 4 attempts => 3 backoff waits (exp 2,4,8 ms with base 1).
    expect(fn).toHaveBeenCalledTimes(4);
    expect(clock.calls).toEqual([2, 4, 8]);
  });

  it("never exceeds the single-wait cap", async () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 5, clock });
    const fn = vi.fn(async () => {
      throw makeError({ code: 11232 });
    });
    // No Retry-After hint => pure exp backoff: attempt1 => 2^1*1000=2000ms,
    // which exceeds maxSingleDelayMs (30ms) and is clamped to 30ms.
    await expect(
      withFeishuSendRateLimit(fn, {
        tokenBucket: bucket,
        clock,
        maxAttempts: 2,
        baseDelayMs: 1000,
        maxSingleDelayMs: 30,
      }),
    ).rejects.toThrow("rate limited");
    expect(clock.calls).toEqual([30]);
  });
});
