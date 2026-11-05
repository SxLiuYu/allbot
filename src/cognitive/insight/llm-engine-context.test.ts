import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import type { PersonaTree } from "../types.js";
import {
  generateInsightCandidatesLLM,
  loadCorrectionContextForInsight,
  type LlmInsightDeps,
} from "./llm-engine.js";

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

function makePersona(userId?: string): PersonaTree {
  return {
    identity: {
      coreTraits: {},
      expertDomains: ["typescript"],
      interestDomains: ["rust"],
      curiosityDomains: ["wasm"],
      ...(userId ? { userId } : {}),
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

const validResponse = JSON.stringify([
  {
    content: "Rust 的所有权模型可以直接映射到 TypeScript 的类型收窄，两者都在编译期消除不确定性。",
    rationale: "bridge",
    targetDomains: ["typescript"],
    sourceDomains: ["rust"],
    relevanceScore: 0.8,
    surpriseScore: 0.7,
  },
]);

function makeConfig(): AllBotConfig {
  return { cognitive: { insight: {} } } as AllBotConfig;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "allbot-insight-ctx-"));
  tempDirs.push(dir);
  return dir;
}

function capturingDeps(captured: { prompt: string }): LlmInsightDeps {
  return {
    complete: async (_model, context) => {
      const message = context.messages[0];
      if (message && "content" in message && typeof message.content === "string") {
        captured.prompt = message.content;
      }
      return assistantMessage(validResponse);
    },
    prepareModel: async () => ({ model: TEST_MODEL, auth: TEST_AUTH }),
  };
}

const input = {
  targetDomains: ["typescript"],
  recentFocus: ["wasm"],
  trustScore: 0.7,
  recentInsightIds: [],
  recentInsightContents: [],
};

describe("generateInsightCandidatesLLM — SOUL.md wiring", () => {
  it("loads SOUL.md from the workspace and injects it into the prompt", async () => {
    const workspaceDir = await tempDir();
    await fs.writeFile(
      path.join(workspaceDir, "SOUL.md"),
      "# SOUL\nYou are a blunt, curious engineer who hates hype.",
      "utf-8",
    );
    const captured = { prompt: "" };

    await generateInsightCandidatesLLM(
      makePersona(),
      input,
      makeConfig(),
      capturingDeps(captured),
      {
        workspaceDir,
      },
    );

    expect(captured.prompt).toContain("SOUL / VOICE");
    expect(captured.prompt).toContain("hates hype");
  });

  it("uses an explicitly supplied soulContent without touching the filesystem", async () => {
    const captured = { prompt: "" };

    await generateInsightCandidatesLLM(
      makePersona(),
      input,
      makeConfig(),
      capturingDeps(captured),
      {
        soulContent: "Explicit soul content for this run.",
      },
    );

    expect(captured.prompt).toContain("Explicit soul content for this run.");
  });
});

describe("generateInsightCandidatesLLM — correction wiring", () => {
  it("injects recent correction records into the insight prompt", async () => {
    const configDir = await tempDir();
    const correctionDir = path.join(configDir, "cognitive", "corrections", "main");
    await fs.mkdir(correctionDir, { recursive: true });
    await fs.writeFile(
      path.join(correctionDir, "user-1.json"),
      JSON.stringify({
        version: 1,
        corrections: [
          {
            id: "corr-1",
            domain: "writing",
            trigger: "writing about tech",
            mistake: "used vague hype language",
            correction: "name the concrete mechanism",
            provenance: "user",
            reinforcedCount: 3,
            createdAt: Date.now(),
            lastReinforced: Date.now(),
          },
        ],
      }),
      "utf-8",
    );
    const captured = { prompt: "" };

    await generateInsightCandidatesLLM(
      makePersona("user-1"),
      input,
      makeConfig(),
      capturingDeps(captured),
      { configDir },
    );

    expect(captured.prompt).toContain("Known Corrections");
    expect(captured.prompt).toContain("used vague hype language");
    expect(captured.prompt).toContain("name the concrete mechanism");
  });

  it("returns undefined when no user id is available", async () => {
    const context = await loadCorrectionContextForInsight({
      userId: undefined,
      configDir: await tempDir(),
    });
    expect(context).toBeUndefined();
  });
});
