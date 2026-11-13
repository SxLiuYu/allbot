import { describe, expect, it } from "vitest";
import { createToolDefinition, parseLightpandaOutput } from "./lightpanda-fetch-provider.js";

describe("parseLightpandaOutput", () => {
  it("parses a single fetch object", () => {
    const stdout = JSON.stringify({
      url: "https://example.com/",
      http_status: 200,
      content: "# Hello",
    });
    expect(parseLightpandaOutput(stdout)).toEqual({
      url: "https://example.com/",
      http_status: 200,
      content: "# Hello",
    });
  });

  it("takes the first entry from a results wrapper", () => {
    const stdout = JSON.stringify({
      results: [{ url: "https://a.test", content: "A" }],
    });
    expect(parseLightpandaOutput(stdout)?.url).toBe("https://a.test");
  });

  it("tolerates trailing log lines", () => {
    const stdout = '{"url":"https://a.test","content":"x"}\nsome metric line';
    expect(parseLightpandaOutput(stdout)?.url).toBe("https://a.test");
  });

  it("returns undefined for unparsable output", () => {
    expect(parseLightpandaOutput("")).toBeUndefined();
    expect(parseLightpandaOutput("boom")).toBeUndefined();
  });
});

describe("lightpanda fetch tool — argument validation", () => {
  const tool = createToolDefinition({});

  it("rejects a missing url", async () => {
    await expect(tool.execute({})).resolves.toMatchObject({ error: "missing_url" });
  });

  it("rejects a relative url", async () => {
    await expect(tool.execute({ url: "/wiki/Rust" })).resolves.toMatchObject({
      error: "invalid_url",
    });
  });

  it("rejects a non-http scheme", async () => {
    await expect(tool.execute({ url: "file:///etc/passwd" })).resolves.toMatchObject({
      error: "unsupported_scheme",
    });
  });
});
