import { describe, expect, it } from "vitest";
import {
  isAllBotOwnerOnlyCoreToolName,
  ALLBOT_OWNER_ONLY_CORE_TOOL_NAMES,
} from "./tools/owner-only-tools.js";

describe("createAllBotTools owner authorization", () => {
  it("marks owner-only core tool names", () => {
    expect(ALLBOT_OWNER_ONLY_CORE_TOOL_NAMES).toEqual(["cron", "gateway", "mcp_config", "nodes"]);
    expect(isAllBotOwnerOnlyCoreToolName("cron")).toBe(true);
    expect(isAllBotOwnerOnlyCoreToolName("gateway")).toBe(true);
    expect(isAllBotOwnerOnlyCoreToolName("mcp_config")).toBe(true);
    expect(isAllBotOwnerOnlyCoreToolName("nodes")).toBe(true);
  });

  it("keeps canvas non-owner-only", () => {
    expect(isAllBotOwnerOnlyCoreToolName("canvas")).toBe(false);
  });
});
