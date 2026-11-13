import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("allbot", 16)).toBe("allbot");
  });

  it("truncates and appends ellipsis when over limit", () => {
    // maxLen 是整个结果的长度上限：9 个字符 + 一个省略号。
    const out = shortenText("allbot-status-output", 10);
    expect(out).toBe("allbot-st…");
    expect(Array.from(out)).toHaveLength(10);
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
