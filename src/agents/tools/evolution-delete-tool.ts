import { Type } from "typebox";
import type { EvolutionUserConfirmation } from "../../cognitive/evolution/types.js";
import type { KaijiBotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, textResult } from "./common.js";

export const EvolutionDeleteSchema = Type.Object({
  name: Type.String({ description: "Name of the skill to delete permanently" }),
});

export function createEvolutionDeleteTool(deps: {
  config?: KaijiBotConfig;
  sessionKey?: string;
  /**
   * User confirmation injected by the host after an explicit user action.
   * Returning undefined means the user has not confirmed this deletion.
   */
  getUserConfirmation?: () => EvolutionUserConfirmation | undefined;
}): AnyAgentTool | null {
  if (deps.config?.cognitive?.enabled === false) {
    return null;
  }
  if (deps.config?.cognitive?.evolution?.enabled === false) {
    return null;
  }

  return {
    name: "delete_skill",
    label: "Delete Skill",
    description:
      "Delete a skill permanently. The host must supply a user confirmation for the exact skill name; " +
      "without it the tool refuses and asks for confirmation. Use only when the user clearly asks to " +
      "remove a skill that was created earlier.",
    parameters: EvolutionDeleteSchema,
    async execute(_toolCallId: string, rawParams: unknown) {
      const params = rawParams as { name: string };

      const confirmation = deps.getUserConfirmation?.();
      const { isValidEvolutionConfirmation } = await import("../../cognitive/evolution/types.js");
      if (!confirmation || !isValidEvolutionConfirmation(confirmation, params.name)) {
        return textResult("Deletion requires an explicit user confirmation for this skill name.", {
          status: "confirm_required",
        });
      }

      try {
        const { SkillPersistenceWriter } =
          await import("../../cognitive/evolution/skill-writer.js");
        const { resolveConfigDir } = await import("../../utils.js");
        const { resolveAgentIdFromSessionKey } = await import("../../routing/session-key.js");
        const { resolveEvolutionSkillBaseDir } =
          await import("../../cognitive/evolution/skill-lifecycle.js");

        const configDir = resolveConfigDir();
        const agentId = resolveAgentIdFromSessionKey(deps.sessionKey);
        const skillBaseDir = resolveEvolutionSkillBaseDir({
          config: deps.config,
          agentId,
          configDir,
        });

        const writer = new SkillPersistenceWriter(skillBaseDir);
        await writer.removeSkill(params.name);

        try {
          const { AuditLog } = await import("../../cognitive/evolution/audit-log.js");
          const audit = new AuditLog(configDir);
          await audit.append({
            operation: "skill.delete",
            actor: deps.sessionKey ?? "agent",
            target: params.name,
            outcome: "success",
            metadata: { confirmationId: confirmation.confirmationId },
          });
        } catch {
          /* non-fatal */
        }

        return jsonResult({
          status: "deleted",
          skillName: params.name,
        });
      } catch (err) {
        return textResult(`Skill deletion failed: ${String(err)}`, { status: "error" });
      }
    },
  };
}
