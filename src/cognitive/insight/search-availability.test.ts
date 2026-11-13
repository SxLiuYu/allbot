import { beforeEach, describe, expect, it } from "vitest";
import {
  isSearchUnavailable,
  recordSearchFailure,
  recordSearchSuccess,
  resetSearchAvailability,
} from "./search-availability.js";

describe("search availability", () => {
  beforeEach(() => {
    resetSearchAvailability();
  });

  it("starts available", () => {
    expect(isSearchUnavailable()).toBe(false);
  });

  it("tolerates a single transient failure", () => {
    recordSearchFailure();
    expect(isSearchUnavailable()).toBe(false);
  });

  it("goes unavailable after repeated failures", () => {
    recordSearchFailure();
    recordSearchFailure();
    recordSearchFailure();
    expect(isSearchUnavailable()).toBe(true);
  });

  it("recovers on the next success", () => {
    recordSearchFailure();
    recordSearchFailure();
    recordSearchFailure();
    expect(isSearchUnavailable()).toBe(true);

    recordSearchSuccess();
    expect(isSearchUnavailable()).toBe(false);
  });

  it("re-probes after the probe window instead of locking out forever", () => {
    recordSearchFailure();
    recordSearchFailure();
    recordSearchFailure();
    const since = Date.now();
    expect(isSearchUnavailable(since)).toBe(true);

    // 15 minutes later the pipeline gets one attempt to re-check search.
    expect(isSearchUnavailable(since + 15 * 60 * 1000)).toBe(false);
  });

  it("a failed probe re-arms the unavailable state", () => {
    recordSearchFailure();
    recordSearchFailure();
    recordSearchFailure();
    const since = Date.now();
    isSearchUnavailable(since + 15 * 60 * 1000);

    recordSearchFailure();
    expect(isSearchUnavailable(since + 15 * 60 * 1000 + 1000)).toBe(true);
  });
});
