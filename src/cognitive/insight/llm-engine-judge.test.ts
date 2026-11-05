import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { KaijiBotConfig } from "../../config/config.js";
import type { PersonaTree } from "../types.js";
import {
  assessInsightQuality,
  buildVerificationPrompt,
  checkSemanticNoveltyWithLLM,
  judgeInsightWithLLM,
  verifyInsightWithLLM,
  type LlmInsightDeps,
} from "./llm-engine.js";
import type { InsightCandidate } from "./types.js";

const TEST_MODEL: Model<Api> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://localhost:11434/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

const TEST_AUTH = { apiKey: "test-key", source: "test", mode: "api-key" as const };

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makePersona(): PersonaTree {
  return {
    identity: {
      coreTraits: {},
      expertDomains: ["typescript"],
      interestDomains: ["rust"],
      curiosityDomains: ["wasm"],
      displayName: "TestUser",
    },
    domains: {
      typescript: {
        depth: 5,
        recurrence: 10,
        lastMentioned: Date.now(),
        keyInsights: ["type narrowing"],
        activeQuestions: [],
        negationSignals: 0,
      },
    },
    recentFocus: ["wasm"],
    feedbackProfile: {
      topicBandits: {},
      optimalFrequencyHours: 4,
      lastProactiveAt: 0,
      recentInsightIds: [],
      recentInsightContents: [],
    },
    rapport: {
      trustScore: 0.75,
      totalExchanges: 50,
      avgResponseLength: 120,
      selfDisclosureLevel: 0.4,
    },
    domainBlacklist: [],
    lifecycle: { stage: "new", lastActiveAt: 0, lastStageTransitionAt: 0, totalActiveDays: 0 },
    calibrationHistory: [],
    moodHistory: [],
  };
}

function makeCandidate(overrides?: Partial<InsightCandidate>): InsightCandidate {
  return {
    id: "judge-candidate-id",
    content:
      "Rust 的 async 运行时 embassy 把嵌入式并发写成了 async/await，跟你写 TypeScript 的思维模型一致。",
    rationale: "Cross-domain bridge between Rust and TypeScript",
    targetDomains: ["rust", "typescript"],
    sourceDomains: ["embedded"],
    relevanceScore: 0.85,
    surpriseScore: 0.7,
    compositeScore: 0.775,
    sources: [],
    verificationStatus: "unverified",
    ...overrides,
  };
}

function makeConfig(): KaijiBotConfig {
  return {
    cognitive: { insight: { sources: { webSearchProvider: "zai" } } },
  } as KaijiBotConfig;
}

function successDeps(responseText: string): LlmInsightDeps {
  return {
    complete: async () => assistantMessage(responseText),
    prepareModel: async () => ({ model: TEST_MODEL, auth: TEST_AUTH }),
  };
}

const history = ["past insight one", "past insight two", "past insight three"];

const mergedJSON = JSON.stringify({
  approved: true,
  novel: true,
  confidence: 0.85,
  status: "verified",
  sourceGroundingScore: 0.8,
  personalizationScore: 0.9,
  sourceRelevanceScore: 0.7,
  isNewsSummary: false,
  similarityToClosest: 0.1,
  reasons: ["specific and personalized", "new angle"],
  notes: "High quality insight",
});

describe("judgeInsightWithLLM — merged verification + novelty", () => {
  it("serves novelty and verification from a single model call", async () => {
    const candidate = makeCandidate();
    const complete = vi.fn().mockResolvedValue(assistantMessage(mergedJSON));
    const deps: LlmInsightDeps = {
      complete,
      prepareModel: async () => ({ model: TEST_MODEL, auth: TEST_AUTH }),
    };

    const novelty = await checkSemanticNoveltyWithLLM(
      candidate,
      history,
      makeConfig(),
      deps,
      undefined,
      makePersona(),
    );
    const verification = await verifyInsightWithLLM(candidate, makePersona(), makeConfig(), deps);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(novelty.isNovel).toBe(true);
    expect(verification.status).toBe("verified");
    expect(verification.approved).toBe(true);
  });

  it("returns approved, novel and reasons from the judge", async () => {
    const result = await judgeInsightWithLLM(
      makeCandidate(),
      history,
      makePersona(),
      makeConfig(),
      successDeps(mergedJSON),
    );

    expect(result.approved).toBe(true);
    expect(result.novel).toBe(true);
    expect(result.reasons).toEqual(["specific and personalized", "new angle"]);
    expect(result.available).toBe(true);
  });
});

describe("verifyInsightWithLLM — approved and explicit status semantics", () => {
  it("downgrades to unverified when approved is false even with high confidence", async () => {
    const result = await verifyInsightWithLLM(
      makeCandidate(),
      makePersona(),
      makeConfig(),
      successDeps(
        JSON.stringify({
          approved: false,
          confidence: 0.95,
          status: "verified",
          notes: "not for this user",
        }),
      ),
    );

    expect(result.status).toBe("unverified");
    expect(result.approved).toBe(false);
  });

  it("does not let confidence override an explicit unverified status", async () => {
    const result = await verifyInsightWithLLM(
      makeCandidate(),
      makePersona(),
      makeConfig(),
      successDeps(
        JSON.stringify({
          approved: true,
          confidence: 0.95,
          status: "unverified",
          notes: "too generic",
        }),
      ),
    );

    expect(result.status).toBe("unverified");
  });

  it("keeps an explicit contradicted status regardless of confidence", async () => {
    const result = await verifyInsightWithLLM(
      makeCandidate(),
      makePersona(),
      makeConfig(),
      successDeps(
        JSON.stringify({
          approved: true,
          confidence: 0.99,
          status: "contradicted",
          notes: "factually wrong",
        }),
      ),
    );

    expect(result.status).toBe("contradicted");
  });
});

describe("buildVerificationPrompt — grounding inputs", () => {
  it("includes the source snippet alongside title, URL and credibility", () => {
    const candidate = makeCandidate({
      sources: [
        {
          url: "https://example.com/embassy",
          title: "embassy async runtime",
          credibility: 0.8,
          snippet: "embassy runs async executors on bare metal microcontrollers",
        } as InsightCandidate["sources"][number],
      ],
    });

    const prompt = buildVerificationPrompt(candidate, makePersona());

    expect(prompt).toContain("embassy async runtime");
    expect(prompt).toContain("https://example.com/embassy");
    expect(prompt).toContain("credibility: 0.8");
    expect(prompt).toContain("embassy runs async executors on bare metal microcontrollers");
  });

  it("compares against the most recent five insights, not the oldest five", () => {
    const historySix = ["oldest insight", "second", "third", "fourth", "fifth", "newest insight"];

    const prompt = buildVerificationPrompt(makeCandidate(), makePersona(), historySix);

    expect(prompt).not.toContain("oldest insight");
    expect(prompt).toContain("second");
    expect(prompt).toContain("newest insight");
  });
});

describe("assessInsightQuality — deterministic refinement triggers", () => {
  const targetDomains = ["typescript"];

  function candidate(overrides?: Partial<InsightCandidate>): InsightCandidate {
    return makeCandidate({
      targetDomains: ["typescript"],
      sources: [{ url: "https://example.com", title: "Source", credibility: 0.6 }],
      ...overrides,
    });
  }

  it("accepts a complete insight", () => {
    const result = assessInsightQuality(candidate(), targetDomains);
    expect(result.needsRefinement).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("flags content that is too short", () => {
    const result = assessInsightQuality(candidate({ content: "太短了" }), targetDomains);
    expect(result.failures).toContain("too-short");
  });

  it("flags a missing target domain", () => {
    const result = assessInsightQuality(candidate({ targetDomains: ["rust"] }), targetDomains);
    expect(result.failures).toContain("missing-target-domain");
  });

  it("flags a missing citation", () => {
    const result = assessInsightQuality(candidate({ sources: [] }), targetDomains);
    expect(result.failures).toContain("missing-citation");
  });

  it("flags forbidden phrases", () => {
    const result = assessInsightQuality(
      candidate({ content: "这个方向值得关注，因为它跟你的 TypeScript 经验有关。" }),
      targetDomains,
    );
    expect(result.failures).toContain("forbidden-phrase");
  });
});
