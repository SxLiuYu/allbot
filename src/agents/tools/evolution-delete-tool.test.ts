import { beforeEach, describe, it, expect, vi } from "vitest";

const { mockRemove } = vi.hoisted(() => ({
  mockRemove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../cognitive/evolution/skill-writer.js", () => ({
  SkillPersistenceWriter: class {
    removeSkill = mockRemove;
    listSkills = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock("../../cognitive/evolution/audit-log.js", () => ({
  AuditLog: class {
    append = vi.fn().mockResolvedValue({});
  },
}));

function statusOf(result: { details?: unknown }): unknown {
  return (result.details as { status?: unknown } | undefined)?.status;
}

describe("createEvolutionDeleteTool", () => {
  beforeEach(() => {
    mockRemove.mockClear();
  });

  it("returns null when cognitive is disabled", async () => {
    const { createEvolutionDeleteTool } = await import("./evolution-delete-tool.js");
    const tool = createEvolutionDeleteTool({ config: { cognitive: { enabled: false } } as never });
    expect(tool).toBeNull();
  });

  it("returns null when evolution is disabled", async () => {
    const { createEvolutionDeleteTool } = await import("./evolution-delete-tool.js");
    const tool = createEvolutionDeleteTool({
      config: { cognitive: { enabled: true, evolution: { enabled: false } } } as never,
    });
    expect(tool).toBeNull();
  });

  it("returns a tool with name delete_skill when enabled", async () => {
    const { createEvolutionDeleteTool } = await import("./evolution-delete-tool.js");
    const tool = createEvolutionDeleteTool({ config: {} as never });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("delete_skill");
  });

  it("deletes a skill when the host supplies a matching user confirmation", async () => {
    const { createEvolutionDeleteTool } = await import("./evolution-delete-tool.js");
    const tool = createEvolutionDeleteTool({
      config: {} as never,
      getUserConfirmation: () => ({
        confirmationId: "user-confirmed-1",
        skillName: "test-skill",
      }),
    });
    const result = await tool!.execute("test-call", { name: "test-skill" } as never);

    expect(statusOf(result)).toBe("deleted");
    expect(mockRemove).toHaveBeenCalledWith("test-skill");
  });

  it("refuses deletion without a host confirmation, even if the model passes confirm:true", async () => {
    const { createEvolutionDeleteTool } = await import("./evolution-delete-tool.js");
    const tool = createEvolutionDeleteTool({ config: {} as never });
    const result = await tool!.execute("test-call", {
      name: "test-skill",
      confirm: true,
    } as never);

    expect(statusOf(result)).toBe("confirm_required");
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("refuses deletion when the confirmation is for a different skill", async () => {
    const { createEvolutionDeleteTool } = await import("./evolution-delete-tool.js");
    const tool = createEvolutionDeleteTool({
      config: {} as never,
      getUserConfirmation: () => ({
        confirmationId: "user-confirmed-2",
        skillName: "other-skill",
      }),
    });
    const result = await tool!.execute("test-call", { name: "test-skill" } as never);

    expect(statusOf(result)).toBe("confirm_required");
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("refuses deletion when the confirmation id is empty", async () => {
    const { createEvolutionDeleteTool } = await import("./evolution-delete-tool.js");
    const tool = createEvolutionDeleteTool({
      config: {} as never,
      getUserConfirmation: () => ({ confirmationId: "  ", skillName: "test-skill" }),
    });
    const result = await tool!.execute("test-call", { name: "test-skill" } as never);

    expect(statusOf(result)).toBe("confirm_required");
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("refuses deletion when the confirmation has expired", async () => {
    const { createEvolutionDeleteTool } = await import("./evolution-delete-tool.js");
    const tool = createEvolutionDeleteTool({
      config: {} as never,
      getUserConfirmation: () => ({
        confirmationId: "user-confirmed-3",
        skillName: "test-skill",
        expiresAt: Date.now() - 1000,
      }),
    });
    const result = await tool!.execute("test-call", { name: "test-skill" } as never);

    expect(statusOf(result)).toBe("confirm_required");
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
