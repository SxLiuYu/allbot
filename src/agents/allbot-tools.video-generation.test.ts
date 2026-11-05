import { describe, expect, it } from "vitest";
import { collectPresentAllBotTools } from "./allbot-tools.registration.js";
import { textResult, type AnyAgentTool } from "./tools/common.js";

function stubAgentTool(name: string): AnyAgentTool {
  return {
    label: name,
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return textResult("ok", {});
    },
  };
}

describe("allbot tools video generation registration", () => {
  it("registers video_generate when a video-generation tool is present", () => {
    const videoGenerateTool = stubAgentTool("video_generate");

    expect(collectPresentAllBotTools([videoGenerateTool])).toEqual([videoGenerateTool]);
  });

  it("omits video_generate when the video-generation tool is absent", () => {
    expect(collectPresentAllBotTools([null]).map((tool) => tool.name)).not.toContain(
      "video_generate",
    );
  });
});
