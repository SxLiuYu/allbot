import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();
const loadAllBotPluginsMock = vi.fn();

let loadPluginMetadataRegistrySnapshot: typeof import("./metadata-registry-loader.js").loadPluginMetadataRegistrySnapshot;

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../loader.js", () => ({
  loadAllBotPlugins: (...args: unknown[]) => loadAllBotPluginsMock(...args),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/resolved-workspace",
  resolveDefaultAgentId: () => "default",
}));

describe("loadPluginMetadataRegistrySnapshot", () => {
  beforeAll(async () => {
    ({ loadPluginMetadataRegistrySnapshot } = await import("./metadata-registry-loader.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    loadAllBotPluginsMock.mockReset();
    loadConfigMock.mockReturnValue({ plugins: {} });
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
    loadAllBotPluginsMock.mockReturnValue({ plugins: [], diagnostics: [] });
  });

  it("defaults to a non-activating validate snapshot", () => {
    loadPluginMetadataRegistrySnapshot({
      config: { plugins: {} },
      activationSourceConfig: { plugins: { allow: ["demo"] } },
      env: { HOME: "/tmp/allbot-home" } as NodeJS.ProcessEnv,
      workspaceDir: "/workspace",
      onlyPluginIds: ["demo"],
    });

    expect(loadAllBotPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { plugins: {} },
        activationSourceConfig: { plugins: { allow: ["demo"] } },
        workspaceDir: "/workspace",
        env: { HOME: "/tmp/allbot-home" },
        onlyPluginIds: ["demo"],
        cache: false,
        activate: false,
        mode: "validate",
        loadModules: undefined,
      }),
    );
  });

  it("forwards explicit manifest-only requests", () => {
    loadPluginMetadataRegistrySnapshot({
      config: { plugins: {} },
      loadModules: false,
    });

    expect(loadAllBotPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loadModules: false,
        mode: "validate",
      }),
    );
  });
});
