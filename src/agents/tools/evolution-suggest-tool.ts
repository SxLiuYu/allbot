import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { t } from "../../cli/i18n/translate.js";
import { resolveCorrectionUserId } from "../../cognitive/correction/userid.js";
import type { EvolutionUserDecision } from "../../cognitive/evolution/types.js";
import type { KaijiBotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, textResult } from "./common.js";

export const EvolutionSuggestSchema = Type.Object({
  taskSummary: Type.String({ description: "Short summary of the completed task" }),
  toolCalls: Type.Array(Type.String(), {
    description: "Ordered list of tool calls made during the task",
  }),
  uniqueToolCount: Type.Number({ description: "Number of distinct tools used" }),
  reasoningTurns: Type.Number({ description: "Number of agent reasoning turns" }),
  durationMs: Type.Number({ description: "Wall-clock time in milliseconds" }),
  domain: Type.String({ description: "Cognitive domain (e.g. 'feishu-wiki', 'code-review')" }),
  transcript: Type.Optional(
    Type.String({ description: "Optional conversation transcript summary for richer context" }),
  ),
  hasTrialAndError: Type.Optional(
    Type.Boolean({ description: "Whether trial-and-error patterns were detected" }),
  ),
  userCorrections: Type.Optional(
    Type.Number({ description: "Number of user corrections during the task" }),
  ),
});

export function createEvolutionSuggestTool(deps: {
  config?: KaijiBotConfig;
  sessionKey?: string;
  deliveryTo?: string;
  /**
   * User decision (approve/reject) injected by the host after an explicit user
   * action. Never sourced from model-supplied tool parameters.
   */
  getUserDecision?: () => EvolutionUserDecision | undefined;
}): AnyAgentTool | null {
  if (deps.config?.cognitive?.enabled === false) {
    return null;
  }
  if (deps.config?.cognitive?.evolution?.enabled === false) {
    return null;
  }

  return {
    name: "evaluate_skill_evolution",
    label: "Create Evolution Skill",
    description:
      "Drafts a reusable Skill from the current task context. " +
      "Call this ONLY when you have independently decided a task is worth preserving as a skill " +
      "(based on [Evolution Signal] or your own judgment). By default the draft is returned for user " +
      "approval and is NOT written to disk; it is saved only after the user explicitly approves it. " +
      "Always tell the user what happened. For modifying existing skills, use patch_skill instead.",
    parameters: EvolutionSuggestSchema,
    async execute(_toolCallId: string, rawParams: unknown) {
      const params = rawParams as {
        taskSummary: string;
        toolCalls: string[];
        uniqueToolCount: number;
        reasoningTurns: number;
        durationMs: number;
        domain: string;
        transcript?: string;
        hasTrialAndError?: boolean;
        userCorrections?: number;
      };

      try {
        const { EvolutionEngine } = await import("../../cognitive/evolution/engine.js");
        const { EvolutionStore } = await import("../../cognitive/evolution/store.js");
        const { resolveConfigDir } = await import("../../utils.js");
        const { consumeToolErrorProfile } = await import("../tool-error-summary.js");
        const { resolveAgentIdFromSessionKey } = await import("../../routing/session-key.js");

        const configDir = resolveConfigDir();
        const store = new EvolutionStore(configDir);
        const agentId = resolveAgentIdFromSessionKey(deps.sessionKey);

        const { resolveEvolutionSkillBaseDir } =
          await import("../../cognitive/evolution/skill-lifecycle.js");
        const skillBaseDir = resolveEvolutionSkillBaseDir({
          config: deps.config,
          agentId,
          configDir,
        });

        const userId = resolveCorrectionUserId(deps.sessionKey, deps.deliveryTo);
        if (!userId) {
          return textResult("No user session; skill creation skipped.", { status: "no_session" });
        }

        // Approval / rejection only happens when the host injects a decision
        // after the user explicitly acted. Model tool params cannot approve.
        const decision = deps.getUserDecision?.();
        if (decision) {
          if (typeof decision.draftId !== "string" || decision.draftId.trim() === "") {
            return textResult("Skill decision is missing the draft it applies to.", {
              status: "approval_invalid",
            });
          }
          if (decision.action !== "approve" && decision.action !== "reject") {
            return textResult("Skill decision has an unknown action.", {
              status: "approval_invalid",
            });
          }
          if (
            typeof decision.confirmationId !== "string" ||
            decision.confirmationId.trim() === "" ||
            (decision.expiresAt !== undefined && decision.expiresAt <= Date.now())
          ) {
            return textResult("Skill decision is not a valid user confirmation.", {
              status: "approval_invalid",
            });
          }

          const records = await store.list(agentId, userId);
          const record = records.find((item) => item.id === decision.draftId);
          if (!record?.draft) {
            return jsonResult({
              status: "draft_not_found",
              draftId: decision.draftId,
              suggestionText: "No matching draft was found; generate a new skill draft first.",
            });
          }

          const { isValidEvolutionConfirmation } =
            await import("../../cognitive/evolution/types.js");
          if (!isValidEvolutionConfirmation(decision, record.draft.name)) {
            return textResult("Skill decision is not a valid user confirmation.", {
              status: "approval_invalid",
            });
          }

          if (decision.action === "reject") {
            record.userResponse = "rejected";
            await store.save(agentId, record);

            try {
              const { AuditLog } = await import("../../cognitive/evolution/audit-log.js");
              const audit = new AuditLog(configDir);
              await audit.recordReject({
                actor: userId,
                target: record.draft.name,
                agentId,
                metadata: { confirmationId: decision.confirmationId },
              });
            } catch {
              /* non-fatal */
            }

            return jsonResult({
              status: "rejected",
              skillName: record.draft.name,
              suggestionText: `Skill draft "${record.draft.name}" was rejected; nothing was written.`,
            });
          }

          const { SkillPersistenceWriter } =
            await import("../../cognitive/evolution/skill-writer.js");
          const writer = new SkillPersistenceWriter(skillBaseDir);
          const savedPath = await writer.writeSkill(record.draft);

          record.userResponse = "accepted";
          record.savedSkillPath = savedPath;
          await store.save(agentId, record);

          try {
            const { AuditLog } = await import("../../cognitive/evolution/audit-log.js");
            const audit = new AuditLog(configDir);
            await audit.recordApprove({
              actor: userId,
              target: record.draft.name,
              agentId,
              metadata: { confirmationId: decision.confirmationId, savedPath },
            });
          } catch {
            /* non-fatal */
          }

          return jsonResult({
            status: "saved",
            skillName: record.draft.name,
            savedPath,
            description: record.draft.description,
            suggestionText: t("cli.tool.evolution.savedSuggestion", {
              name: record.draft.name,
              description: record.draft.description,
            }),
          });
        }

        let engine: InstanceType<
          typeof import("../../cognitive/evolution/engine.js").EvolutionEngine
        >;
        try {
          if (deps.config) {
            const { createStandaloneGenerateText } =
              await import("../../cognitive/evolution/standalone-generate.js");
            const { generateSkillDraftLLM } =
              await import("../../cognitive/evolution/llm-draft-generator.js");
            const generateText = await createStandaloneGenerateText(deps.config, {
              maxTokens: 4000,
              timeout: 60_000,
            });
            engine = new EvolutionEngine(store, (c) => generateSkillDraftLLM(c, { generateText }));
          } else {
            engine = new EvolutionEngine(store);
          }
        } catch {
          engine = new EvolutionEngine(store);
        }

        const errorProfile = deps.sessionKey ? consumeToolErrorProfile(deps.sessionKey) : undefined;

        const candidate = {
          taskSummary: params.taskSummary,
          toolCalls: params.toolCalls,
          uniqueToolCount: params.uniqueToolCount,
          reasoningTurns: params.reasoningTurns,
          durationMs: params.durationMs,
          domain: params.domain,
          transcript: params.transcript,
          hasTrialAndError: params.hasTrialAndError,
          userCorrections: params.userCorrections,
          errorProfile,
        };

        let draft = await engine.generate(candidate);

        let existingSkills: Array<{ name: string; description: string }> | undefined;
        let duplicateExisting: string | undefined;
        let generateTextForDedup: ((prompt: string) => Promise<string>) | undefined;
        try {
          const { SkillPersistenceWriter: SW } =
            await import("../../cognitive/evolution/skill-writer.js");
          const { SkillLifecycleManager } =
            await import("../../cognitive/evolution/skill-lifecycle.js");
          const writer = new SW(skillBaseDir);
          const lifecycle = new SkillLifecycleManager(writer);

          const names = await writer.listSkillNames();
          const skills: Array<{ name: string; description: string }> = [];
          for (const name of names) {
            const meta = await writer.readSkillMeta(name);
            if (meta) {
              skills.push({ name: meta.name, description: meta.description });
            }
          }
          if (skills.length > 0) {
            existingSkills = skills;
          }

          try {
            if (deps.config) {
              const { createStandaloneGenerateText } =
                await import("../../cognitive/evolution/standalone-generate.js");
              generateTextForDedup = await createStandaloneGenerateText(deps.config, {
                maxTokens: 200,
                timeout: 30_000,
              });
            }
          } catch {}

          const dedupResult = await engine.checkBeforeGenerate(
            candidate,
            lifecycle,
            existingSkills,
            generateTextForDedup ? { generateText: generateTextForDedup } : undefined,
          );
          if (!dedupResult.shouldCreate && dedupResult.existingSkill) {
            duplicateExisting = dedupResult.existingSkill;
          }
        } catch {
          // Non-critical; proceed with creation
        }

        if (duplicateExisting) {
          const record = {
            id: randomUUID(),
            userId,
            candidate,
            draft,
            timestamp: Date.now(),
          };
          await store.save(agentId, record);

          return jsonResult({
            status: "duplicate",
            existingSkills,
            duplicateExisting,
            suggestionText: t("cli.tool.evolution.duplicateSuggestion", {
              name: duplicateExisting,
            }),
          });
        }

        if (generateTextForDedup) {
          const { evaluateSkillQuality, refineSkillDraft } =
            await import("../../cognitive/evolution/skill-quality-gate.js");
          const gateModelRef = deps.config?.cognitive?.evolution?.qualityGateModel;
          let judgeGenText = generateTextForDedup;
          if (gateModelRef && gateModelRef.includes("/")) {
            try {
              const { createStandaloneGenerateText: createJudge } =
                await import("../../cognitive/evolution/standalone-generate.js");
              judgeGenText = await createJudge(deps.config!, {
                maxTokens: 200,
                timeout: 30_000,
                modelRef: gateModelRef,
              });
            } catch {
              // Fall back to default model if judge model unavailable
            }
          }
          let quality = await evaluateSkillQuality(draft, { generateText: judgeGenText });
          let refinedDraft = draft;
          let attempts = 0;
          while (!quality.passed && attempts < 2) {
            attempts++;
            refinedDraft = await refineSkillDraft(refinedDraft, quality.critique, quality.issues, {
              generateText: judgeGenText,
            });
            quality = await evaluateSkillQuality(refinedDraft, { generateText: judgeGenText });
          }
          if (!quality.passed) {
            const record = {
              id: randomUUID(),
              userId,
              candidate,
              draft,
              timestamp: Date.now(),
            };
            await store.save(agentId, record);

            try {
              const { AuditLog } = await import("../../cognitive/evolution/audit-log.js");
              const audit = new AuditLog(configDir);
              await audit.append({
                operation: "skill.quality_rejected",
                actor: userId ?? "agent",
                target: draft.name,
                outcome: "skipped",
              });
            } catch {
              /* non-fatal */
            }

            return jsonResult({
              status: "quality_rejected",
              score: quality.score,
              issues: quality.issues,
              critique: quality.critique,
              suggestionText: t("cli.tool.evolution.qualityRejectedSuggestion", {
                score: quality.score.toFixed(2),
              }),
            });
          }
          draft = refinedDraft;
        }

        const evolutionConfig = deps.config?.cognitive?.evolution as unknown as
          | { requireApproval?: boolean }
          | undefined;
        const requireApproval = evolutionConfig?.requireApproval !== false;

        const draftRecordId = randomUUID();
        if (requireApproval) {
          const record = {
            id: draftRecordId,
            userId,
            candidate,
            draft,
            timestamp: Date.now(),
          };
          await store.save(agentId, record);

          try {
            const { AuditLog } = await import("../../cognitive/evolution/audit-log.js");
            const audit = new AuditLog(configDir);
            await audit.recordDraft({
              actor: userId,
              target: draft.name,
              agentId,
              metadata: { draftId: draftRecordId },
            });
          } catch {
            /* non-fatal */
          }

          return jsonResult({
            status: "needs_approval",
            draftId: draftRecordId,
            skillName: draft.name,
            description: draft.description,
            draft,
            existingSkills,
            suggestionText: `Skill draft "${draft.name}" is ready. It was not saved; the user must approve it first.`,
          });
        }

        const { SkillPersistenceWriter: SW2 } =
          await import("../../cognitive/evolution/skill-writer.js");
        const saveWriter = new SW2(skillBaseDir);
        const savedPath = await saveWriter.writeSkill(draft);

        const record = {
          id: draftRecordId,
          userId,
          candidate,
          draft,
          savedSkillPath: savedPath,
          timestamp: Date.now(),
        };
        await store.save(agentId, record);

        try {
          const { AuditLog } = await import("../../cognitive/evolution/audit-log.js");
          const audit = new AuditLog(configDir);
          await audit.append({
            operation: "skill.create",
            actor: userId ?? "agent",
            target: draft.name,
            outcome: "success",
          });
        } catch {
          /* non-fatal */
        }

        if (generateTextForDedup) {
          const draftForReview = draft;
          const reviewModelRef = deps.config?.cognitive?.evolution?.qualityGateModel;
          let reviewGenerateText = generateTextForDedup;
          if (reviewModelRef && reviewModelRef.includes("/") && deps.config) {
            try {
              const { createStandaloneGenerateText: createJudge } =
                await import("../../cognitive/evolution/standalone-generate.js");
              reviewGenerateText = await createJudge(deps.config, {
                maxTokens: 200,
                timeout: 30_000,
                modelRef: reviewModelRef,
              });
            } catch {
              // Fall back to default model
            }
          }
          void (async () => {
            try {
              const { reviewSkill } = await import("../../cognitive/evolution/skill-reviewer.js");
              const review = await reviewSkill(draftForReview, candidate.taskSummary, {
                generateText: reviewGenerateText,
              });
              try {
                const { AuditLog } = await import("../../cognitive/evolution/audit-log.js");
                const audit = new AuditLog(configDir);
                await audit.append({
                  operation: "skill.review",
                  actor: "reviewer",
                  target: draftForReview.name,
                  outcome: review.approved ? "success" : "failure",
                  metadata: { confidence: review.confidence, notes: review.notes },
                });
              } catch {
                /* non-fatal */
              }
            } catch {
              /* non-blocking reviewer */
            }
          })();
        }

        return jsonResult({
          status: "saved",
          skillName: draft.name,
          savedPath,
          description: draft.description,
          existingSkills,
          suggestionText: t("cli.tool.evolution.savedSuggestion", {
            name: draft.name,
            description: draft.description,
          }),
        });
      } catch (err) {
        return textResult(`Skill creation failed: ${String(err)}`, { status: "error" });
      }
    },
  };
}
