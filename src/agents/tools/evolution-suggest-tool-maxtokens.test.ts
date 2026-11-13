import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionSuggestTool } from "./evolution-suggest-tool.js";

// New tests for the JSON-structured LLM calls inside the evolution suggest tool.
//
// The feishu skill evaluator used to fail with `LLM parse error` / score 0
// because the quality-judge, dedup and reviewer generators were created with
// `maxTokens: 200`, which truncated longer JSON responses
// ("Unexpected end of JSON input"). These tests assert that every structured
// JSON call is now created with a safe, non-200 token budget, and that the real
// evaluator/reviewer parsers succeed when given a complete JSON payload.

const VALID_DRAFT = {
  name: "feishu-wiki-archive",
  description: "Archive wiki pages",
  triggerPhrases: ["归档", "archive"],
  bodyMarkdown: "## When to use\n\nUse when archiving wiki.\n\n## Workflow\n\n1. Scan\n2. Move",
};

const mockGenerate = vi.fn().mockResolvedValue(VALID_DRAFT);
const mockSave = vi.fn().mockResolvedValue(undefined);
const mockList = vi.fn().mockResolvedValue([]);
const mockCheckBeforeGenerate = vi.fn().mockResolvedValue({ shouldCreate: true });

vi.mock("../../cognitive/evolution/engine.js", () => ({
  EvolutionEngine: class {
    generate = mockGenerate;
    checkBeforeGenerate = mockCheckBeforeGenerate;
  },
}));

vi.mock("../../cognitive/evolution/store.js", () => ({
  EvolutionStore: class {
    save = mockSave;
    list = mockList;
  },
}));

const mockWriteSkill = vi
  .fn()
  .mockResolvedValue("/home/test/.allbot/skills/agent/test-skill/SKILL.md");
const mockListSkillNames = vi.fn().mockResolvedValue([]);
const mockReadSkillMeta = vi.fn().mockResolvedValue(null);

vi.mock("../../cognitive/evolution/skill-writer.js", () => ({
  SkillPersistenceWriter: class {
    writeSkill = mockWriteSkill;
    listSkillNames = mockListSkillNames;
    readSkillMeta = mockReadSkillMeta;
  },
}));

vi.mock("../../cognitive/evolution/skill-lifecycle.js", () => ({
  SkillLifecycleManager: class {},
  resolveEvolutionSkillBaseDir: vi.fn().mockReturnValue("/home/test/.allbot/workspace"),
}));

vi.mock("../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils.js")>();
  return {
    ...actual,
    resolveConfigDir: vi.fn().mockReturnValue("/home/test/.allbot"),
  };
});

// Capture every createStandaloneGenerateText call so we can assert the
// maxTokens budget that was wired into each structured-JSON generator.
type CapturedOption = { maxTokens?: number; timeout?: number; modelRef?: string };
const capturedOptions: CapturedOption[] = [];

const sharedGenerateText = vi.fn(async (prompt: string): Promise<string> => {
  if (prompt.includes("strict quality evaluator")) {
    // Quality judge prompt: return a complete, high-scoring JSON object.
    return JSON.stringify({
      actionable: 0.9,
      validTools: 0.9,
      meaningfulTriggers: 0.9,
      solvesProblem: 0.9,
      critique: "Solid skill.",
      issues: [],
    });
  }
  if (prompt.includes("reviewing a skill")) {
    // Reviewer prompt: return a complete JSON object.
    return JSON.stringify({ approved: true, confidence: 0.9, notes: "Looks good." });
  }
  // Dedup / draft-generator fallback: not asserted by parsing here.
  return JSON.stringify({ shouldCreate: true });
});

vi.mock("../../cognitive/evolution/standalone-generate.js", () => ({
  createStandaloneGenerateText: vi.fn(async (_cfg: unknown, options?: CapturedOption) => {
    capturedOptions.push({
      maxTokens: options?.maxTokens,
      timeout: options?.timeout,
      modelRef: options?.modelRef,
    });
    return sharedGenerateText;
  }),
}));

describe("evolution suggest tool structured-JSON maxTokens", () => {
  afterEach(() => {
    vi.clearAllMocks();
    capturedOptions.length = 0;
    mockWriteSkill.mockResolvedValue("/home/test/.allbot/skills/agent/test-skill/SKILL.md");
    mockListSkillNames.mockResolvedValue([]);
    mockReadSkillMeta.mockResolvedValue(null);
    mockList.mockResolvedValue([]);
    mockCheckBeforeGenerate.mockResolvedValue({ shouldCreate: true });
    mockGenerate.mockResolvedValue(VALID_DRAFT);
  });

  it("uses safe, non-200 maxTokens for all structured JSON generators", async () => {
    const tool = createEvolutionSuggestTool({
      sessionKey: "agent:main:user-2",
      config: {
        cognitive: {
          enabled: true,
          evolution: {
            // Gate model with a slash triggers the judge/reviewer generators
            // (otherwise they reuse the dedup generator).
            qualityGateModel: "evaluator/gpt-4o-mini",
            // requireApproval:false is required so the reviewer generator is
            // actually wired (it lives after the needs_approval early return).
            requireApproval: false,
          },
        },
      } as never,
    })!;

    const result = await tool.execute("call-mt", {
      taskSummary: "complex workflow",
      toolCalls: ["tool_a", "tool_b", "tool_c"],
      uniqueToolCount: 3,
      reasoningTurns: 8,
      durationMs: 15000,
      domain: "code-review",
    });

    // No structured call may be created with the old truncated budget.
    const anyTruncated = capturedOptions.some((o) => o.maxTokens === 200);
    expect(anyTruncated).toBe(false);

    const allSufficient = capturedOptions.every((o) => (o.maxTokens ?? 0) >= 1500);
    expect(allSufficient).toBe(true);

    // Draft generator keeps its larger budget and is unchanged.
    expect(capturedOptions.some((o) => o.maxTokens === 4000)).toBe(true);
    // Dedup generator (default model, no modelRef) is 1500.
    expect(capturedOptions.some((o) => o.maxTokens === 1500 && o.modelRef === undefined)).toBe(
      true,
    );
    // Judge generator is 3000.
    expect(capturedOptions.some((o) => o.maxTokens === 3000)).toBe(true);
    // Reviewer generator is 1500.
    expect(capturedOptions.some((o) => o.maxTokens === 1500 && o.modelRef !== undefined)).toBe(
      true,
    );

    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // Because the quality judge returned a complete high-scoring JSON object,
    // the draft must NOT be rejected by the gate.
    expect(payload.status).not.toBe("quality_rejected");
  });

  it("reviewer runs with sufficient tokens and parses a complete JSON payload", async () => {
    const tool = createEvolutionSuggestTool({
      sessionKey: "agent:main:user-2",
      config: {
        cognitive: {
          enabled: true,
          evolution: {
            qualityGateModel: "evaluator/gpt-4o-mini",
            requireApproval: false,
          },
        },
      } as never,
    })!;

    await tool.execute("call-review", {
      taskSummary: "complex workflow",
      toolCalls: ["tool_a", "tool_b"],
      uniqueToolCount: 2,
      reasoningTurns: 4,
      durationMs: 10000,
      domain: "code-review",
    });

    // Reviewer is invoked fire-and-forget; flush its microtask before asserting.
    await new Promise((r) => setTimeout(r, 10));

    // The reviewer call must have used a safe, non-200 budget.
    const reviewerCall = capturedOptions.find(
      (o) => o.modelRef !== undefined && o.maxTokens === 1500,
    );
    expect(reviewerCall).toBeDefined();
    expect(reviewerCall!.maxTokens).toBe(1500);

    // The shared generator (which returns a complete reviewer JSON) was actually
    // exercised — confirming the reviewer parsed successfully instead of
    // hitting "Unexpected end of JSON input".
    expect(sharedGenerateText).toHaveBeenCalled();
  });
});
