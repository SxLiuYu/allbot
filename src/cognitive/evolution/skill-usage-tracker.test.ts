import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SkillPersistenceWriter } from "./skill-writer.js";
import type { SkillDraft } from "./types.js";

function makeDraft(overrides: Partial<SkillDraft> = {}): SkillDraft {
  return {
    name: "test-skill",
    description: "A test skill",
    triggerPhrases: ["test"],
    bodyMarkdown: "# Test",
    ...overrides,
  };
}

describe("trackSkillUsage", () => {
  let tempDir: string;
  let writer: SkillPersistenceWriter;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kaijibot-skill-usage-test-"));
    writer = new SkillPersistenceWriter(join(tempDir, "workspace"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("touches skill when meta matches skills/agent/X/SKILL.md", async () => {
    await writer.writeSkill(makeDraft({ name: "my-skill" }));
    const { trackSkillUsage } = await import("./skill-usage-tracker.js");

    await trackSkillUsage({
      toolMetas: [
        { toolName: "read", meta: `/home/user/.kaijibot/skills/agent/my-skill/SKILL.md` },
      ],
      configDir: tempDir,
    });

    const meta = await writer.readSkillMeta("my-skill");
    expect(meta!.usageCount).toBe(1);
  });

  it("deduplicates multiple reads to same skill", async () => {
    await writer.writeSkill(makeDraft({ name: "my-skill" }));
    const { trackSkillUsage } = await import("./skill-usage-tracker.js");

    await trackSkillUsage({
      toolMetas: [
        { toolName: "read", meta: `/path/skills/agent/my-skill/SKILL.md` },
        { toolName: "read", meta: `/path/skills/agent/my-skill/SKILL.md` },
      ],
      configDir: tempDir,
    });

    const meta = await writer.readSkillMeta("my-skill");
    expect(meta!.usageCount).toBe(1);
  });

  it("skips non-SKILL.md reads", async () => {
    const { trackSkillUsage } = await import("./skill-usage-tracker.js");

    await trackSkillUsage({
      toolMetas: [
        { toolName: "read", meta: "/some/file.ts" },
        { toolName: "write", meta: "/path/skills/agent/my-skill/SKILL.md" },
      ],
      configDir: tempDir,
    });
  });

  it("handles missing skill gracefully", async () => {
    const { trackSkillUsage } = await import("./skill-usage-tracker.js");

    await expect(
      trackSkillUsage({
        toolMetas: [{ toolName: "read", meta: `/path/skills/agent/nonexistent-skill/SKILL.md` }],
        configDir: tempDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("uses <configDir>/workspace/skills/agent as the root when no config is provided", async () => {
    await writer.writeSkill(makeDraft({ name: "workspace-skill" }));
    const configDirWriter = new SkillPersistenceWriter(tempDir);
    expect(await configDirWriter.readSkillMeta("workspace-skill")).toBeNull();

    const { trackSkillUsage } = await import("./skill-usage-tracker.js");
    await trackSkillUsage({
      toolMetas: [{ toolName: "read", meta: "/anywhere/skills/agent/workspace-skill/SKILL.md" }],
      configDir: tempDir,
    });

    expect((await writer.readSkillMeta("workspace-skill"))!.usageCount).toBe(1);
  });

  it("honors a custom agent workspace when config and agentId are provided", async () => {
    const customWs = join(tempDir, "custom-workspace");
    const customWriter = new SkillPersistenceWriter(customWs);
    await customWriter.writeSkill(makeDraft({ name: "custom-skill" }));

    const { trackSkillUsage } = await import("./skill-usage-tracker.js");
    await trackSkillUsage({
      toolMetas: [{ toolName: "read", meta: `${customWs}/skills/agent/custom-skill/SKILL.md` }],
      configDir: tempDir,
      config: { agents: { defaults: { workspace: customWs } } } as never,
      agentId: "main",
    });

    expect((await customWriter.readSkillMeta("custom-skill"))!.usageCount).toBe(1);
  });
});
