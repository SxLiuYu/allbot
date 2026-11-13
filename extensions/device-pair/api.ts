export {
  approveDevicePairing,
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  listDevicePairing,
  revokeDeviceBootstrapToken,
  type DeviceBootstrapProfile,
} from "allbot/plugin-sdk/device-bootstrap";
export { definePluginEntry, type AllBotPluginApi } from "allbot/plugin-sdk/plugin-entry";
export {
  resolveGatewayBindUrl,
  resolveGatewayPort,
  resolveTailnetHostWithRunner,
} from "allbot/plugin-sdk/core";
export {
  resolvePreferredAllBotTmpDir,
  runPluginCommandWithTimeout,
} from "allbot/plugin-sdk/sandbox";
export { renderQrPngBase64 } from "./qr-image.js";
