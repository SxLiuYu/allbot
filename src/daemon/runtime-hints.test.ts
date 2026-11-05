import { describe, expect, it } from "vitest";
import { buildPlatformRuntimeLogHints, buildPlatformServiceStartHints } from "./runtime-hints.js";

describe("buildPlatformRuntimeLogHints", () => {
  it("renders launchd log hints on darwin", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "darwin",
        env: {
          ALLBOT_STATE_DIR: "/tmp/allbot-state",
          ALLBOT_LOG_PREFIX: "gateway",
        },
        systemdServiceName: "allbot-gateway",
        windowsTaskName: "AllBot Gateway",
      }),
    ).toEqual([
      "Launchd stdout (if installed): /tmp/allbot-state/logs/gateway.log",
      "Launchd stderr (if installed): /tmp/allbot-state/logs/gateway.err.log",
    ]);
  });

  it("renders systemd and windows hints by platform", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "linux",
        systemdServiceName: "allbot-gateway",
        windowsTaskName: "AllBot Gateway",
      }),
    ).toEqual(["Logs: journalctl --user -u allbot-gateway.service -n 200 --no-pager"]);
    expect(
      buildPlatformRuntimeLogHints({
        platform: "win32",
        systemdServiceName: "allbot-gateway",
        windowsTaskName: "AllBot Gateway",
      }),
    ).toEqual(['Logs: schtasks /Query /TN "AllBot Gateway" /V /FO LIST']);
  });
});

describe("buildPlatformServiceStartHints", () => {
  it("builds platform-specific service start hints", () => {
    expect(
      buildPlatformServiceStartHints({
        platform: "darwin",
        installCommand: "allbot gateway install",
        startCommand: "allbot gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.allbot.gateway.plist",
        systemdServiceName: "allbot-gateway",
        windowsTaskName: "AllBot Gateway",
      }),
    ).toEqual([
      "allbot gateway install",
      "allbot gateway",
      "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.allbot.gateway.plist",
    ]);
    expect(
      buildPlatformServiceStartHints({
        platform: "linux",
        installCommand: "allbot gateway install",
        startCommand: "allbot gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.allbot.gateway.plist",
        systemdServiceName: "allbot-gateway",
        windowsTaskName: "AllBot Gateway",
      }),
    ).toEqual([
      "allbot gateway install",
      "allbot gateway",
      "systemctl --user start allbot-gateway.service",
    ]);
  });
});
