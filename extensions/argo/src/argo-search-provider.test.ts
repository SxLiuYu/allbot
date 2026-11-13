import { describe, expect, it } from "vitest";
import {
  buildArgoArgs,
  isArgoDepth,
  isArgoSort,
  normalizeArgoResults,
  resolveCommand,
  sanitizeArgoOptions,
  unwrapArgoPayload,
} from "./argo-search-provider.js";

describe("unwrapArgoPayload", () => {
  it("unwraps the MCP text envelope", () => {
    const payload = { results: [{ title: "T", url: "https://example.com" }] };
    const stdout = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    expect(unwrapArgoPayload(stdout)).toEqual(payload);
  });

  it("tolerates leading log lines before the envelope", () => {
    const payload = { results: [] };
    const stdout = `[argo-mcp] starting\n[argo-mcp] ready\n${JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    })}`;

    expect(unwrapArgoPayload(stdout)).toEqual(payload);
  });

  it("returns the parsed object when there is no content envelope", () => {
    expect(unwrapArgoPayload('{"results":[{"url":"https://a.test"}]}')).toEqual({
      results: [{ url: "https://a.test" }],
    });
  });

  it("returns undefined for non-JSON output", () => {
    expect(unwrapArgoPayload("command not found")).toBeUndefined();
    expect(unwrapArgoPayload("")).toBeUndefined();
  });
});

describe("normalizeArgoResults", () => {
  it("keeps only object entries", () => {
    const payload = {
      results: [{ title: "A" }, null, "string", 42, { title: "B" }],
    };
    expect(normalizeArgoResults(payload)).toEqual([{ title: "A" }, { title: "B" }]);
  });

  it("returns an empty list when results is missing", () => {
    expect(normalizeArgoResults({})).toEqual([]);
    expect(normalizeArgoResults(undefined)).toEqual([]);
    expect(normalizeArgoResults({ results: "nope" })).toEqual([]);
  });
});

describe("buildArgoArgs", () => {
  it("passes the query and count through", () => {
    expect(buildArgoArgs("Rust async", 5)).toEqual({ query: "Rust async", count: 5 });
  });

  it("forwards optional filter params unchanged", () => {
    expect(
      buildArgoArgs("AI news November 6 2026 model release", 5, {
        since: "2026-11-05",
        until: "2026-11-07",
        sort: "newest",
        engine: "anysearch",
        depth: "balanced",
      }),
    ).toEqual({
      query: "AI news November 6 2026 model release",
      count: 5,
      since: "2026-11-05",
      until: "2026-11-07",
      sort: "newest",
      engine: "anysearch",
      depth: "balanced",
    });
  });

  it("omits empty strings and invalid enums from the args", () => {
    expect(
      buildArgoArgs("q", 3, {
        since: "  ",
        until: "",
        sort: "bogus",
        engine: "",
        depth: "extreme",
      }),
    ).toEqual({ query: "q", count: 3 });
  });

  it("keeps valid enums while dropping empty ones", () => {
    expect(
      buildArgoArgs("q", 3, { since: "7d", sort: "oldest", depth: "fast", engine: "  " }),
    ).toEqual({ query: "q", count: 3, since: "7d", sort: "oldest", depth: "fast" });
  });
});

describe("sanitizeArgoOptions", () => {
  it("returns an empty object when options are missing", () => {
    expect(sanitizeArgoOptions(undefined)).toEqual({});
    expect(sanitizeArgoOptions(null as unknown as undefined)).toEqual({});
  });

  it("trims whitespace and drops empty/blank values", () => {
    expect(sanitizeArgoOptions({ since: "  2026-11-05  ", engine: "   " })).toEqual({
      since: "2026-11-05",
    });
  });

  it("keeps valid sort and depth enums", () => {
    expect(sanitizeArgoOptions({ sort: "newest", depth: "deep" })).toEqual({
      sort: "newest",
      depth: "deep",
    });
  });

  it("drops invalid sort and depth enums", () => {
    expect(sanitizeArgoOptions({ sort: "weird", depth: "max" })).toEqual({});
  });
});

describe("isArgoSort / isArgoDepth", () => {
  it("accepts only the documented enum values", () => {
    expect(isArgoSort("relevance")).toBe(true);
    expect(isArgoSort("oldest")).toBe(true);
    expect(isArgoSort("newest")).toBe(true);
    expect(isArgoSort("bogus")).toBe(false);
    expect(isArgoSort(undefined)).toBe(false);

    expect(isArgoDepth("fast")).toBe(true);
    expect(isArgoDepth("balanced")).toBe(true);
    expect(isArgoDepth("deep")).toBe(true);
    expect(isArgoDepth("slow")).toBe(false);
    expect(isArgoDepth(42)).toBe(false);
  });
});

describe("resolveCommand", () => {
  it("defaults to the PATH command", () => {
    expect(resolveCommand(undefined)).toBe("argo-search");
    expect(resolveCommand({})).toBe("argo-search");
  });

  it("uses a configured command, ignoring blanks", () => {
    expect(resolveCommand({ command: "/opt/argo/bin/argo.js" })).toBe("/opt/argo/bin/argo.js");
    expect(resolveCommand({ command: "   " })).toBe("argo-search");
  });
});
