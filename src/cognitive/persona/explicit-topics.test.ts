import { describe, expect, it } from "vitest";
import { createDefaultPersona } from "./store.js";
import { applyExplicitTopics } from "./explicit-topics.js";

describe("applyExplicitTopics", () => {
  it("creates a domain for a declared topic", () => {
    const persona = createDefaultPersona();
    const result = applyExplicitTopics(persona, ["Rust"]);

    expect(result.domains.Rust).toBeDefined();
    expect(result.domains.Rust!.depth).toBeGreaterThan(0);
    expect(result.identity.interestDomains).toContain("Rust");
  });

  it("marks the seeded insight as explicit", () => {
    const persona = createDefaultPersona();
    const result = applyExplicitTopics(persona, ["AI安全"]);

    expect(result.domains["AI安全"]!.insights?.[0]?.source).toBe("explicit");
  });

  it("does nothing for an empty or undefined list", () => {
    const persona = createDefaultPersona();
    expect(applyExplicitTopics(persona, []).domains).toEqual({});
    expect(applyExplicitTopics(persona, undefined).domains).toEqual({});
  });

  it("matches existing domains case-insensitively instead of duplicating", () => {
    const persona = createDefaultPersona();
    const now = Date.now();
    persona.domains.Rust = {
      depth: 5,
      recurrence: 4,
      lastMentioned: now - 30 * 24 * 3_600_000,
      keyInsights: [],
      activeQuestions: [],
      negationSignals: 0,
    };

    const result = applyExplicitTopics(persona, ["rust"]);

    expect(Object.keys(result.domains)).toEqual(["Rust"]);
    // Observed depth is preserved; only recency and the floor are refreshed.
    expect(result.domains.Rust!.depth).toBe(5);
    expect(result.domains.Rust!.lastMentioned).toBeGreaterThan(now - 1000);
  });

  it("lifts a decayed domain back to the seed floor", () => {
    const persona = createDefaultPersona();
    persona.domains.Rust = {
      depth: 0,
      recurrence: 0,
      lastMentioned: 1,
      keyInsights: [],
      activeQuestions: [],
      negationSignals: 0,
    };

    const result = applyExplicitTopics(persona, ["Rust"]);

    expect(result.domains.Rust!.depth).toBe(2);
    expect(result.domains.Rust!.recurrence).toBe(1);
  });

  it("is idempotent across repeated loads", () => {
    const persona = createDefaultPersona();
    applyExplicitTopics(persona, ["Rust", "Kubernetes"]);
    const first = JSON.stringify(persona.domains);
    applyExplicitTopics(persona, ["Rust", "Kubernetes"]);

    expect(Object.keys(persona.domains)).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(persona.domains)).Rust.depth).toBe(
      JSON.parse(first).Rust.depth,
    );
  });

  it("trims and skips blank entries", () => {
    const persona = createDefaultPersona();
    const result = applyExplicitTopics(persona, ["  Rust  ", "", "   "]);

    expect(Object.keys(result.domains)).toEqual(["Rust"]);
  });
});
