import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("allbot", 16)).toBe("allbot");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("allbot-status-output", 10)).toBe("allbot-…");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
