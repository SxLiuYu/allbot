import { afterEach, describe, expect, it } from "vitest";
import {
  consumeEvolutionDecision,
  consumeSkillDeleteConfirmation,
  grantEvolutionDecision,
  grantSkillDeleteConfirmation,
  resetEvolutionApprovalsForTest,
} from "./approval-store.js";

afterEach(() => {
  resetEvolutionApprovalsForTest();
});

describe("evolution approval store", () => {
  it("hands a decision to the matching scope exactly once", () => {
    const grant = grantEvolutionDecision({
      agentId: "main",
      userId: "u1",
      draftId: "d1",
      skillName: "daily-report",
      action: "approve",
    });

    const first = consumeEvolutionDecision("main", "u1");
    const second = consumeEvolutionDecision("main", "u1");

    expect(first).toMatchObject({
      draftId: "d1",
      skillName: "daily-report",
      action: "approve",
      confirmationId: grant.confirmationId,
    });
    expect(first).not.toHaveProperty("expiresAt");
    expect(second).toBeUndefined();
  });

  it("does not leak a decision across users or agents", () => {
    grantEvolutionDecision({
      agentId: "main",
      userId: "u1",
      draftId: "d1",
      skillName: "s",
      action: "reject",
    });

    expect(consumeEvolutionDecision("main", "u2")).toBeUndefined();
    expect(consumeEvolutionDecision("other", "u1")).toBeUndefined();
    expect(consumeEvolutionDecision("main", "u1")?.action).toBe("reject");
  });

  it("ignores expired grants", () => {
    grantEvolutionDecision({
      agentId: "main",
      userId: "u1",
      draftId: "d1",
      skillName: "s",
      action: "approve",
      ttlMs: -1,
    });

    expect(consumeEvolutionDecision("main", "u1")).toBeUndefined();
  });

  it("selects a delete confirmation by skill name", () => {
    grantSkillDeleteConfirmation({ agentId: "main", userId: "u1", skillName: "alpha" });
    grantSkillDeleteConfirmation({ agentId: "main", userId: "u1", skillName: "beta" });

    expect(consumeSkillDeleteConfirmation("main", "u1", "alpha")?.skillName).toBe("alpha");
    expect(consumeSkillDeleteConfirmation("main", "u1")?.skillName).toBe("beta");
    expect(consumeSkillDeleteConfirmation("main", "u1")).toBeUndefined();
  });
});
