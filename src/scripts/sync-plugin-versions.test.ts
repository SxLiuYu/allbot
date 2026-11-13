import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncPluginVersions } from "../../scripts/sync-plugin-versions.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const tempDirs: string[] = [];

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("syncPluginVersions", () => {
  afterEach(() => {
    cleanupTempDirs(tempDirs);
  });

  it("preserves workspace allbot devDependencies while bumping plugin host constraints", () => {
    const rootDir = makeTempDir(tempDirs, "allbot-sync-plugin-versions-");

    writeJson(path.join(rootDir, "package.json"), {
      name: "allbot",
      version: "2026.4.1",
    });
    writeJson(path.join(rootDir, "extensions/bluebubbles/package.json"), {
      name: "@allbot/bluebubbles",
      version: "2026.3.30",
      devDependencies: {
        allbot: "workspace:*",
      },
      peerDependencies: {
        allbot: ">=2026.3.30",
      },
      allbot: {
        install: {
          minHostVersion: ">=2026.3.30",
        },
        compat: {
          pluginApi: ">=2026.3.30",
        },
        build: {
          allbotVersion: "2026.3.30",
        },
      },
    });

    const summary = syncPluginVersions(rootDir);
    const updatedPackage = JSON.parse(
      fs.readFileSync(path.join(rootDir, "extensions/bluebubbles/package.json"), "utf8"),
    ) as {
      version?: string;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      allbot?: {
        install?: {
          minHostVersion?: string;
        };
        compat?: {
          pluginApi?: string;
        };
        build?: {
          allbotVersion?: string;
        };
      };
    };

    expect(summary.updated).toContain("@allbot/bluebubbles");
    expect(updatedPackage.version).toBe("2026.4.1");
    expect(updatedPackage.devDependencies?.allbot).toBe("workspace:*");
    expect(updatedPackage.peerDependencies?.allbot).toBe(">=2026.4.1");
    expect(updatedPackage.allbot?.install?.minHostVersion).toBe(">=2026.4.1");
    expect(updatedPackage.allbot?.compat?.pluginApi).toBe(">=2026.4.1");
    expect(updatedPackage.allbot?.build?.allbotVersion).toBe("2026.4.1");
  });
});
