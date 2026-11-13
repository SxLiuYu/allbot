import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionSuggestTool } from "./evolution-suggest-tool.js";

const mockGenerate = vi.fn().mockResolvedValue({
  name: "test-skill",
  description: "A test skill",
  triggerPhrases: ["test trigger"],
  bodyMarkdown: "## When to use\n\nUse when testing.\n\n## Workflow\n\n1. Step one\n2. Step two",
});
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

vi.mock("../../cognitive/evolution/standalone-generate.js", () => ({
  createStandaloneGenerateText: vi.fn().mockRejectedValue(new Error("no provider in tests")),
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

describe("createEvolutionSuggestTool", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockWriteSkill.mockResolvedValue("/home/test/.allbot/skills/agent/test-skill/SKILL.md");
    mockListSkillNames.mockResolvedValue([]);
    mockReadSkillMeta.mockResolvedValue(null);
    mockList.mockResolvedValue([]);
    mockCheckBeforeGenerate.mockResolvedValue({ shouldCreate: true });
  });

  it("returns null when cognitive.enabled is false", () => {
    const tool = createEvolutionSuggestTool({
      config: { cognitive: { enabled: false } } as never,
    });
    expect(tool).toBeNull();
  });

  it("returns null when cognitive.evolution.enabled is false", () => {
    const tool = createEvolutionSuggestTool({
      config: { cognitive: { enabled: true, evolution: { enabled: false } } } as never,
    });
    expect(tool).toBeNull();
  });

  it("returns tool when both enabled or config is absent", () => {
    const tool = createEvolutionSuggestTool({});
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("evaluate_skill_evolution");
  });

  it("returns tool when cognitive.enabled is true and evolution is absent", () => {
    const tool = createEvolutionSuggestTool({
      config: { cognitive: { enabled: true } } as never,
    });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("evaluate_skill_evolution");
  });

  describe("execute", () => {
    it("returns no_session when sessionKey is missing", async () => {
      const tool = createEvolutionSuggestTool({})!;

      const result = await tool.execute("call-1", {
        taskSummary: "test",
        toolCalls: ["tool_a"],
        uniqueToolCount: 1,
        reasoningTurns: 2,
        durationMs: 1000,
        domain: "test",
      });

      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("No user session");
      expect(mockGenerate).not.toHaveBeenCalled();
    });

    it("defaults to needs_approval and does not write the skill", async () => {
      mockGenerate.mockResolvedValueOnce({
        name: "feishu-wiki-archive",
        description: "Archive wiki pages",
        triggerPhrases: ["归档", "archive"],
        bodyMarkdown:
          "## When to use\n\nUse when archiving wiki.\n\n## Workflow\n\n1. Scan\n2. Move",
      });

      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-2",
      })!;

      const result = await tool.execute("call-3", {
        taskSummary: "complex workflow",
        toolCalls: ["tool_a", "tool_b", "tool_c"],
        uniqueToolCount: 3,
        reasoningTurns: 8,
        durationMs: 15000,
        domain: "code-review",
      });

      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(payload.status).toBe("needs_approval");
      expect(payload.skillName).toBe("feishu-wiki-archive");
      expect(payload.draftId).toBeDefined();
      expect(payload.draft.name).toBe("feishu-wiki-archive");
      expect(payload.draft.bodyMarkdown).toContain("When to use");
      expect(mockWriteSkill).not.toHaveBeenCalled();
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave.mock.calls[0][1].draft.name).toBe("feishu-wiki-archive");
      expect(mockSave.mock.calls[0][1].savedSkillPath).toBeUndefined();
    });

    it("saves immediately when requireApproval is false", async () => {
      mockGenerate.mockResolvedValueOnce({
        name: "feishu-wiki-archive",
        description: "Archive wiki pages",
        triggerPhrases: ["归档", "archive"],
        bodyMarkdown:
          "## When to use\n\nUse when archiving wiki.\n\n## Workflow\n\n1. Scan\n2. Move",
      });

      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-2",
        config: {
          cognitive: { enabled: true, evolution: { requireApproval: false } },
        } as never,
      })!;

      const result = await tool.execute("call-3-auto", {
        taskSummary: "complex workflow",
        toolCalls: ["tool_a", "tool_b", "tool_c"],
        uniqueToolCount: 3,
        reasoningTurns: 8,
        durationMs: 15000,
        domain: "code-review",
      });

      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(payload.status).toBe("saved");
      expect(payload.skillName).toBe("feishu-wiki-archive");
      expect(payload.bodyMarkdown).toBeUndefined();
      expect(payload.savedPath).toBeDefined();
      expect(payload.suggestionText).toContain("自主进化");
      expect(payload.suggestionText).toContain("feishu-wiki-archive");
      expect(mockWriteSkill).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it("returns error when generate throws", async () => {
      mockGenerate.mockRejectedValueOnce(new Error("generation failure"));

      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-3",
      })!;

      const result = await tool.execute("call-4", {
        taskSummary: "failing task",
        toolCalls: ["tool_a"],
        uniqueToolCount: 1,
        reasoningTurns: 2,
        durationMs: 1000,
        domain: "test",
      });

      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Skill creation failed");
      expect(text).toContain("generation failure");
    });

    it("suggestionText includes skill name and description", async () => {
      mockGenerate.mockResolvedValueOnce({
        name: "multi-tool-skill",
        description: "Multi-tool skill",
        triggerPhrases: ["multi"],
        bodyMarkdown: "## Workflow\n\n1. A\n2. B\n3. C\n4. D",
      });

      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-4",
        config: {
          cognitive: { enabled: true, evolution: { requireApproval: false } },
        } as never,
      })!;

      const result = await tool.execute("call-5", {
        taskSummary: "multi-step analysis",
        toolCalls: ["tool_a", "tool_b", "tool_c", "tool_d", "tool_e"],
        uniqueToolCount: 5,
        reasoningTurns: 12,
        durationMs: 30000,
        domain: "data-analysis",
      });

      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(payload.status).toBe("saved");
      expect(payload.suggestionText).toContain("自主进化");
      expect(payload.suggestionText).toContain("multi-tool-skill");
    });

    it("passes transcript to generate via candidate", async () => {
      mockGenerate.mockResolvedValueOnce({
        name: "transcript-skill",
        description: "Transcript skill",
        triggerPhrases: ["test"],
        bodyMarkdown: "# Test",
      });

      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-5",
      })!;

      await tool.execute("call-6", {
        taskSummary: "task with transcript",
        toolCalls: ["tool_a"],
        uniqueToolCount: 1,
        reasoningTurns: 2,
        durationMs: 1000,
        domain: "test",
        transcript: "User asked about feishu wiki archiving, bot listed pages and moved them.",
      });

      expect(mockGenerate).toHaveBeenCalledTimes(1);
      const candidate = mockGenerate.mock.calls[0][0] as { transcript?: string };
      expect(candidate.transcript).toBe(
        "User asked about feishu wiki archiving, bot listed pages and moved them.",
      );
    });

    it("passes hasTrialAndError to generate via candidate", async () => {
      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-6",
      })!;

      await tool.execute("call-7", {
        taskSummary: "trial-error task",
        toolCalls: ["tool_a"],
        uniqueToolCount: 1,
        reasoningTurns: 2,
        durationMs: 1000,
        domain: "test",
        hasTrialAndError: true,
      });

      const candidate = mockGenerate.mock.calls[0][0] as { hasTrialAndError?: boolean };
      expect(candidate.hasTrialAndError).toBe(true);
    });

    it("passes userCorrections to generate via candidate", async () => {
      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-7",
      })!;

      await tool.execute("call-8", {
        taskSummary: "corrected task",
        toolCalls: ["tool_a"],
        uniqueToolCount: 1,
        reasoningTurns: 2,
        durationMs: 1000,
        domain: "test",
        userCorrections: 4,
      });

      const candidate = mockGenerate.mock.calls[0][0] as { userCorrections?: number };
      expect(candidate.userCorrections).toBe(4);
    });

    it("prefers deliveryTo over sessionKey for userId", async () => {
      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:main",
        deliveryTo: "user:ou_abc123",
      })!;

      await tool.execute("call-9", {
        taskSummary: "test",
        toolCalls: ["a"],
        uniqueToolCount: 1,
        reasoningTurns: 1,
        durationMs: 100,
        domain: "t",
      });

      expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it("returns no_session for system sessions that yield no userId", async () => {
      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:cron:evolution",
      })!;

      const result = await tool.execute("call-10", {
        taskSummary: "test",
        toolCalls: ["a"],
        uniqueToolCount: 1,
        reasoningTurns: 1,
        durationMs: 100,
        domain: "t",
      });

      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("No user session");
    });

    it("strips feishu: prefix from deliveryTo", async () => {
      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:main",
        deliveryTo: "feishu:ou_xyz789",
      })!;

      await tool.execute("call-11", {
        taskSummary: "test",
        toolCalls: ["a"],
        uniqueToolCount: 1,
        reasoningTurns: 1,
        durationMs: 100,
        domain: "t",
      });

      expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it("returns duplicate when dedup finds existing", async () => {
      mockGenerate.mockResolvedValueOnce({
        name: "dupe",
        description: "dupe",
        triggerPhrases: ["t"],
        bodyMarkdown: "#",
      });
      mockCheckBeforeGenerate.mockResolvedValueOnce({
        shouldCreate: false,
        existingSkill: "existing-one",
      });

      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-dedup",
      })!;

      const result = await tool.execute("call-dedup", {
        taskSummary: "dedup task",
        toolCalls: ["tool_a", "tool_b", "tool_c"],
        uniqueToolCount: 3,
        reasoningTurns: 3,
        durationMs: 1000,
        domain: "test",
      });

      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(payload.status).toBe("duplicate");
      expect(payload.suggestionText).toContain("已有技能");
      expect(payload.suggestionText).toContain("existing-one");
      expect(mockWriteSkill).not.toHaveBeenCalled();
    });

    it("saves record with savedSkillPath", async () => {
      mockGenerate.mockResolvedValueOnce({
        name: "path-test",
        description: "Path test",
        triggerPhrases: ["test"],
        bodyMarkdown: "# Test",
      });
      mockWriteSkill.mockResolvedValueOnce("/home/test/.allbot/skills/agent/path-test/SKILL.md");

      const tool = createEvolutionSuggestTool({
        sessionKey: "agent:main:user-path",
        config: {
          cognitive: { enabled: true, evolution: { requireApproval: false } },
        } as never,
      })!;

      await tool.execute("call-path", {
        taskSummary: "path test",
        toolCalls: ["a", "b", "c"],
        uniqueToolCount: 3,
        reasoningTurns: 3,
        durationMs: 1000,
        domain: "test",
      });

      expect(mockSave).toHaveBeenCalledTimes(1);
      const savedRecord = mockSave.mock.calls[0][1];
      expect(savedRecord.savedSkillPath).toBe("/home/test/.allbot/skills/agent/path-test/SKILL.md");
      expect(savedRecord.draft.name).toBe("path-test");
    });

    describe("user decision", () => {
      function statusOf(result: { details?: unknown }): unknown {
        return (result.details as { status?: unknown } | undefined)?.status;
      }

      const storedDraft = {
        id: "record-1",
        userId: "user-approve",
        candidate: {
          taskSummary: "task",
          toolCalls: ["a"],
          uniqueToolCount: 1,
          reasoningTurns: 1,
          durationMs: 1,
          domain: "test",
        },
        draft: {
          name: "approved-skill",
          description: "Approved skill",
          triggerPhrases: ["go"],
          bodyMarkdown: "# Approved",
        },
        timestamp: 1,
      };

      it("writes the stored draft when the host injects an approve decision", async () => {
        mockList.mockResolvedValueOnce([structuredClone(storedDraft)]);
        const tool = createEvolutionSuggestTool({
          sessionKey: "agent:main:user-approve",
          getUserDecision: () => ({
            action: "approve",
            draftId: "record-1",
            confirmationId: "conf-1",
            skillName: "approved-skill",
          }),
        })!;

        const result = await tool.execute("call-approve", {});

        const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(payload.status).toBe("saved");
        expect(payload.skillName).toBe("approved-skill");
        expect(mockWriteSkill).toHaveBeenCalledTimes(1);
        expect(mockWriteSkill.mock.calls[0][0].name).toBe("approved-skill");
        expect(mockGenerate).not.toHaveBeenCalled();
        expect(mockSave).toHaveBeenCalledTimes(1);
        expect(mockSave.mock.calls[0][1].userResponse).toBe("accepted");
      });

      it("marks the record rejected and writes nothing on reject", async () => {
        mockList.mockResolvedValueOnce([structuredClone(storedDraft)]);
        const tool = createEvolutionSuggestTool({
          sessionKey: "agent:main:user-approve",
          getUserDecision: () => ({
            action: "reject",
            draftId: "record-1",
            confirmationId: "conf-2",
            skillName: "approved-skill",
          }),
        })!;

        const result = await tool.execute("call-reject", {});

        const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(payload.status).toBe("rejected");
        expect(mockWriteSkill).not.toHaveBeenCalled();
        expect(mockGenerate).not.toHaveBeenCalled();
        expect(mockSave.mock.calls[0][1].userResponse).toBe("rejected");
      });

      it("refuses a decision without a confirmation id", async () => {
        const tool = createEvolutionSuggestTool({
          sessionKey: "agent:main:user-approve",
          getUserDecision: () => ({
            action: "approve",
            draftId: "record-1",
            confirmationId: "  ",
            skillName: "approved-skill",
          }),
        })!;

        const result = await tool.execute("call-no-conf", {});
        expect(statusOf(result)).toBe("approval_invalid");
        expect(mockWriteSkill).not.toHaveBeenCalled();
      });

      it("refuses an expired decision", async () => {
        mockList.mockResolvedValueOnce([structuredClone(storedDraft)]);
        const tool = createEvolutionSuggestTool({
          sessionKey: "agent:main:user-approve",
          getUserDecision: () => ({
            action: "approve",
            draftId: "record-1",
            confirmationId: "conf-3",
            skillName: "approved-skill",
            expiresAt: Date.now() - 1000,
          }),
        })!;

        const result = await tool.execute("call-expired", {});
        expect(statusOf(result)).toBe("approval_invalid");
        expect(mockWriteSkill).not.toHaveBeenCalled();
      });

      it("refuses a decision for a different skill name", async () => {
        mockList.mockResolvedValueOnce([structuredClone(storedDraft)]);
        const tool = createEvolutionSuggestTool({
          sessionKey: "agent:main:user-approve",
          getUserDecision: () => ({
            action: "approve",
            draftId: "record-1",
            confirmationId: "conf-4",
            skillName: "other-skill",
          }),
        })!;

        const result = await tool.execute("call-mismatch", {});
        expect(statusOf(result)).toBe("approval_invalid");
        expect(mockWriteSkill).not.toHaveBeenCalled();
      });

      it("returns draft_not_found when the record is gone", async () => {
        mockList.mockResolvedValueOnce([]);
        const tool = createEvolutionSuggestTool({
          sessionKey: "agent:main:user-approve",
          getUserDecision: () => ({
            action: "approve",
            draftId: "missing",
            confirmationId: "conf-5",
            skillName: "approved-skill",
          }),
        })!;

        const result = await tool.execute("call-missing", {});
        expect(statusOf(result)).toBe("draft_not_found");
        expect(mockWriteSkill).not.toHaveBeenCalled();
      });
    });
  });
});
