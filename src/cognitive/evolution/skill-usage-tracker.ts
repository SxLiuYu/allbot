import type { AllBotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("cognitive/evolution/skill-usage");

export type SkillUsageTrackParams = {
  toolMetas: ReadonlyArray<{ toolName: string; meta?: string }>;
  configDir: string;
  /** Full config when available, so a custom agent workspace is honored. */
  config?: AllBotConfig;
  /** Agent whose workspace owns the skills (defaults to "main"). */
  agentId?: string;
};

/**
 * Scan post-turn toolMetas for `read` calls that accessed SKILL.md files
 * and call touchSkill() to update usage statistics. Fire-and-forget.
 */
export async function trackSkillUsage(params: SkillUsageTrackParams): Promise<void> {
  const skillReads = params.toolMetas.filter(
    (m) => m.toolName === "read" && typeof m.meta === "string" && m.meta.includes("SKILL.md"),
  );

  if (skillReads.length === 0) {
    return;
  }

  const { SkillPersistenceWriter } = await import("./skill-writer.js");
  const { resolveEvolutionSkillBaseDir } = await import("./skill-lifecycle.js");
  const writer = new SkillPersistenceWriter(
    resolveEvolutionSkillBaseDir({
      config: params.config,
      agentId: params.agentId,
      configDir: params.configDir,
    }),
  );

  const seen = new Set<string>();
  for (const entry of skillReads) {
    const meta = entry.meta!;
    // Extract skill name: the directory name immediately before SKILL.md
    const match = meta.match(/(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/);
    if (!match || seen.has(match[1])) {
      continue;
    }
    if (match[1] === "skills" || match[1] === "agent") {
      continue;
    }
    seen.add(match[1]);

    try {
      await writer.touchSkill(match[1]);
      log.debug("skill usage tracked", { skill: match[1] });
    } catch (err) {
      log.debug("touchSkill failed", { skill: match[1], error: String(err) });
    }
  }
}
