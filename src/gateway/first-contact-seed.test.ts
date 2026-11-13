import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AllBotConfig } from "../config/config.js";
import { listSeedTargets } from "./first-contact-seed.js";

function configWithStore(storePath: string): AllBotConfig {
  return { session: { store: storePath } } as AllBotConfig;
}

describe("listSeedTargets", () => {
  it("finds a peer with a channel binding but no persona", () => {
    const dir = mkdtempSync(join(tmpdir(), "allbot-seed-"));
    const storePath = join(dir, "sessions.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:direct:ou_alice": {
          lastChannel: "feishu",
          lastTo: "ou_alice",
          lastAccountId: "default",
        },
      }),
    );

    const targets = listSeedTargets(configWithStore(storePath), "main", new Set());

    expect(targets).toEqual([
      {
        agentId: "main",
        userId: "ou_alice",
        channel: "feishu",
        to: "ou_alice",
        accountId: "default",
      },
    ]);
  });

  it("skips peers that already have a persona", () => {
    const dir = mkdtempSync(join(tmpdir(), "allbot-seed-"));
    const storePath = join(dir, "sessions.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:direct:ou_alice": { lastChannel: "feishu", lastTo: "ou_alice" },
        "agent:main:direct:ou_bob": { lastChannel: "feishu", lastTo: "ou_bob" },
      }),
    );

    const targets = listSeedTargets(
      configWithStore(storePath),
      "main",
      new Set(["ou_alice"]),
    );

    expect(targets.map((t) => t.userId)).toEqual(["ou_bob"]);
  });

  it("skips sessions without a routable channel", () => {
    const dir = mkdtempSync(join(tmpdir(), "allbot-seed-"));
    const storePath = join(dir, "sessions.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {},
        "agent:main:direct:ou_none": { lastChannel: "none", lastTo: "ou_none" },
        "agent:main:direct:ou_missing": { lastChannel: "feishu" },
      }),
    );

    expect(listSeedTargets(configWithStore(storePath), "main", new Set())).toEqual([]);
  });

  it("skips cron, subagent, and group sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "allbot-seed-"));
    const storePath = join(dir, "sessions.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:cron:daily": { lastChannel: "feishu", lastTo: "ou_alice" },
        "agent:main:subagent:ou_bob": { lastChannel: "feishu", lastTo: "ou_bob" },
        "agent:main:group:oc_team": { lastChannel: "feishu", lastTo: "oc_team" },
      }),
    );

    expect(listSeedTargets(configWithStore(storePath), "main", new Set())).toEqual([]);
  });

  it("deduplicates the same peer across session keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "allbot-seed-"));
    const storePath = join(dir, "sessions.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:direct:ou_alice": { lastChannel: "feishu", lastTo: "ou_alice" },
        "agent:main:feishu:direct:ou_alice": { lastChannel: "feishu", lastTo: "ou_alice" },
      }),
    );

    expect(listSeedTargets(configWithStore(storePath), "main", new Set())).toHaveLength(1);
  });

  it("returns nothing when config or store is missing", () => {
    expect(listSeedTargets(undefined, "main", new Set())).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "allbot-seed-"));
    mkdirSync(join(dir, "empty"));
    expect(
      listSeedTargets(configWithStore(join(dir, "empty", "sessions.json")), "main", new Set()),
    ).toEqual([]);
  });
});
