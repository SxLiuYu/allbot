import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "allbot/plugin-sdk/channel-entry-contract";
import type { AllBotPluginApi } from "allbot/plugin-sdk/channel-entry-contract";

type FeishuSubagentHooksModule = typeof import("./api.js");

let feishuSubagentHooksPromise: Promise<FeishuSubagentHooksModule> | null = null;

function loadFeishuSubagentHooksModule() {
  feishuSubagentHooksPromise ??= import("./api.js");
  return feishuSubagentHooksPromise;
}

function registerFeishuDocTools(api: AllBotPluginApi) {
  const register = loadBundledEntryExportSync<(api: AllBotPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerFeishuDocTools",
  });
  register(api);
}

function registerFeishuChatTools(api: AllBotPluginApi) {
  const register = loadBundledEntryExportSync<(api: AllBotPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerFeishuChatTools",
  });
  register(api);
}

function registerFeishuWikiTools(api: AllBotPluginApi) {
  const register = loadBundledEntryExportSync<(api: AllBotPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerFeishuWikiTools",
  });
  register(api);
}

function registerFeishuDriveTools(api: AllBotPluginApi) {
  const register = loadBundledEntryExportSync<(api: AllBotPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerFeishuDriveTools",
  });
  register(api);
}

function registerFeishuPermTools(api: AllBotPluginApi) {
  const register = loadBundledEntryExportSync<(api: AllBotPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerFeishuPermTools",
  });
  register(api);
}

function registerFeishuBitableTools(api: AllBotPluginApi) {
  const register = loadBundledEntryExportSync<(api: AllBotPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerFeishuBitableTools",
  });
  register(api);
}

function registerFeishuVcTools(api: AllBotPluginApi) {
  const register = loadBundledEntryExportSync<(api: AllBotPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerFeishuVcTools",
  });
  register(api);
}

function registerFeishuTaskTools(api: AllBotPluginApi) {
  const register = loadBundledEntryExportSync<(api: AllBotPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerFeishuTaskTools",
  });
  register(api);
}

export default defineBundledChannelEntry({
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "feishuPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setFeishuRuntime",
  },
  registerFull(api) {
    api.on("subagent_spawning", async (event, ctx) => {
      const { handleFeishuSubagentSpawning } = await loadFeishuSubagentHooksModule();
      return await handleFeishuSubagentSpawning(event, ctx);
    });
    api.on("subagent_delivery_target", async (event) => {
      const { handleFeishuSubagentDeliveryTarget } = await loadFeishuSubagentHooksModule();
      return handleFeishuSubagentDeliveryTarget(event);
    });
    api.on("subagent_ended", async (event) => {
      const { handleFeishuSubagentEnded } = await loadFeishuSubagentHooksModule();
      handleFeishuSubagentEnded(event);
    });
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
    registerFeishuVcTools(api);
    registerFeishuTaskTools(api);
  },
});
