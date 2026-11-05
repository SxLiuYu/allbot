import { normalizeOptionalString } from "../../../src/shared/string-coerce.js";
import { isRecord } from "../../../src/utils.js";

export type JsonObject = Record<string, unknown>;

export type ExternalPluginCompatibility = {
  pluginApiRange?: string;
  builtWithAllBotVersion?: string;
  pluginSdkVersion?: string;
  minGatewayVersion?: string;
};

export type ExternalPluginValidationIssue = {
  fieldPath: string;
  message: string;
};

export type ExternalCodePluginValidationResult = {
  compatibility?: ExternalPluginCompatibility;
  issues: ExternalPluginValidationIssue[];
};

export const EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS = [
  "allbot.compat.pluginApi",
  "allbot.build.allbotVersion",
] as const;

function readAllBotBlock(packageJson: unknown) {
  const root = isRecord(packageJson) ? packageJson : undefined;
  const allbot = isRecord(root?.allbot) ? root.allbot : undefined;
  const compat = isRecord(allbot?.compat) ? allbot.compat : undefined;
  const build = isRecord(allbot?.build) ? allbot.build : undefined;
  const install = isRecord(allbot?.install) ? allbot.install : undefined;
  return { root, allbot, compat, build, install };
}

export function normalizeExternalPluginCompatibility(
  packageJson: unknown,
): ExternalPluginCompatibility | undefined {
  const { root, compat, build, install } = readAllBotBlock(packageJson);
  const version = normalizeOptionalString(root?.version);
  const minHostVersion = normalizeOptionalString(install?.minHostVersion);
  const compatibility: ExternalPluginCompatibility = {};

  const pluginApi = normalizeOptionalString(compat?.pluginApi);
  if (pluginApi) {
    compatibility.pluginApiRange = pluginApi;
  }

  const minGatewayVersion = normalizeOptionalString(compat?.minGatewayVersion) ?? minHostVersion;
  if (minGatewayVersion) {
    compatibility.minGatewayVersion = minGatewayVersion;
  }

  const builtWithAllBotVersion = normalizeOptionalString(build?.allbotVersion) ?? version;
  if (builtWithAllBotVersion) {
    compatibility.builtWithAllBotVersion = builtWithAllBotVersion;
  }

  const pluginSdkVersion = normalizeOptionalString(build?.pluginSdkVersion);
  if (pluginSdkVersion) {
    compatibility.pluginSdkVersion = pluginSdkVersion;
  }

  return Object.keys(compatibility).length > 0 ? compatibility : undefined;
}

export function listMissingExternalCodePluginFieldPaths(packageJson: unknown): string[] {
  const { compat, build } = readAllBotBlock(packageJson);
  const missing: string[] = [];
  if (!normalizeOptionalString(compat?.pluginApi)) {
    missing.push("allbot.compat.pluginApi");
  }
  if (!normalizeOptionalString(build?.allbotVersion)) {
    missing.push("allbot.build.allbotVersion");
  }
  return missing;
}

export function validateExternalCodePluginPackageJson(
  packageJson: unknown,
): ExternalCodePluginValidationResult {
  const issues = listMissingExternalCodePluginFieldPaths(packageJson).map((fieldPath) => ({
    fieldPath,
    message: `${fieldPath} is required for external code plugins published to ClawHub.`,
  }));
  return {
    compatibility: normalizeExternalPluginCompatibility(packageJson),
    issues,
  };
}
