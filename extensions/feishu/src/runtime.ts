import type { PluginRuntime } from "allbot/plugin-sdk/core";
import { createPluginRuntimeStore } from "allbot/plugin-sdk/runtime-store";

const { setRuntime: setFeishuRuntime, getRuntime: getFeishuRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Feishu runtime not initialized");
export { getFeishuRuntime, setFeishuRuntime };
