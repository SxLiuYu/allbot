import { z } from "zod";

export const CognitiveProactiveSchema = z
  .object({
    enabled: z.boolean().default(false),
    minIntervalHours: z.number().min(0.5).max(168).default(0.5),
    activeHours: z
      .object({
        start: z.string().default("09:00"),
        end: z.string().default("22:00"),
        timezone: z.string().optional(),
      })
      .strict()
      .default({ start: "09:00", end: "22:00" }),
    digestMode: z.enum(["realtime", "daily", "weekly"]).optional(),
    costFalseNegative: z.number().min(0.1).max(100).optional(),
    costFalseAlarm: z.number().min(0.1).max(100).optional(),
    maxDailyInsights: z.number().min(1).max(20).optional(),
  })
  .strict()
  .optional();

export const CognitivePersonaSchema = z
  .object({
    autoExtract: z.boolean().default(true),
    extractionModel: z.string().optional(),
    identityRefreshHours: z.number().min(1).max(720).optional(),
  })
  .strict()
  .optional();

export const CognitiveInsightSchema = z
  .object({
    sources: z
      .object({
        webSearchProvider: z.string().optional(),
        scanIntervalHours: z.number().min(1).max(168).optional(),
        explicitTopics: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    engine: z.enum(["v1", "v2", "dual", "knowledge", "pattern", "unified"]).optional(),
    verificationLevel: z.enum(["basic", "strict", "paranoid"]).optional(),
    inferenceModel: z.string().optional(),
    outputLanguage: z.string().optional(),
    maxLlmCallsPerDelivery: z.number().min(1).max(100).default(3),
    maxCandidatesPerEvent: z.number().min(1).max(20).default(2),
  })
  .strict()
  .optional();

export const CognitiveFeedbackSchema = z
  .object({
    mechanism: z.enum(["emoji", "buttons", "text"]).optional(),
    implicitFeedback: z.boolean().optional(),
  })
  .strict()
  .optional();

/**
 * Fields retained in the config loader for backward compatibility but no
 * longer read by any production code. They are stripped before validation
 * with a deprecation warning so existing allbot.json files keep working.
 */
const DEPRECATED_EVOLUTION_KEYS = [
  "minComplexity",
  "errorComplexityThreshold",
  "clawhubEnabled",
  "clawhubRegistry",
  "clawhubAutoPublish",
] as const;

export const CognitiveEvolutionSchema = z
  .preprocess((val) => {
    if (val && typeof val === "object") {
      const obj = val as Record<string, unknown>;
      for (const key of DEPRECATED_EVOLUTION_KEYS) {
        if (key in obj) {
          console.warn(
            `[allbot] config.cognitive.evolution.${key} is deprecated, ignored, and will be removed in a future version. Remove it from your allbot.json.`,
          );
          delete obj[key];
        }
      }
    }
    return val;
  }, z
    .object({
      enabled: z.boolean().default(true),
      qualityGateModel: z.string().optional(),
      requireApproval: z.boolean().default(true),
    })
    .strict())
  .optional();

export const CognitiveTasksSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxSteps: z.number().min(1).max(100).optional(),
    progressMessages: z.boolean().default(false),
    maxSubTasks: z.number().min(1).max(20).default(3),
    maxTaskDepth: z.number().min(1).max(10).default(3),
    maxConcurrentPerUser: z.number().min(1).max(20).default(1),
  })
  .strict()
  .optional();

export const CognitiveSchema = z
  .object({
    enabled: z.boolean().default(true),
    proactive: CognitiveProactiveSchema,
    persona: CognitivePersonaSchema,
    insight: CognitiveInsightSchema,
    feedback: CognitiveFeedbackSchema,
    evolution: CognitiveEvolutionSchema,
    tasks: CognitiveTasksSchema,
  })
  .strict()
  .optional();
