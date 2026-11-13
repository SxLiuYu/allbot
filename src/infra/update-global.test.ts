import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import {
  canResolveRegistryVersionForPackageTarget,
  collectInstalledGlobalPackageErrors,
  cleanupGlobalRenameDirs,
  detectGlobalInstallManagerByPresence,
  detectGlobalInstallManagerForRoot,
  globalInstallArgs,
  globalInstallFallbackArgs,
  isExplicitPackageInstallSpec,
  isMainPackageTarget,
  ALLBOT_MAIN_PACKAGE_SPEC,
  resolveGlobalInstallCommand,
  resolveGlobalPackageRoot,
  resolveGlobalInstallTarget,
  resolveGlobalInstallSpec,
  resolveGlobalRoot,
  type CommandRunner,
} from "./update-global.js";

const FIRST_SIDECAR =
  BUNDLED_RUNTIME_SIDECAR_PATHS.find((p) => p.includes("feishu")) ??
  BUNDLED_RUNTIME_SIDECAR_PATHS[0]!;

describe("update global helpers", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it("prefers explicit package spec overrides", () => {
    envSnapshot = captureEnv(["ALLBOT_UPDATE_PACKAGE_SPEC"]);
    process.env.ALLBOT_UPDATE_PACKAGE_SPEC = "file:/tmp/allbot.tgz";

    expect(resolveGlobalInstallSpec({ packageName: "allbot", tag: "latest" })).toBe(
      "file:/tmp/allbot.tgz",
    );
    expect(
      resolveGlobalInstallSpec({
        packageName: "allbot",
        tag: "beta",
        env: { ALLBOT_UPDATE_PACKAGE_SPEC: "allbot@next" },
      }),
    ).toBe("allbot@next");
  });

  it("resolves global roots and package roots from runner output", async () => {
    const runCommand: CommandRunner = async (argv) => {
      if (argv[0] === "npm") {
        return { stdout: "/tmp/npm-root\n", stderr: "", code: 0 };
      }
      if (argv[0] === "pnpm") {
        return { stdout: "", stderr: "", code: 1 };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    };

    await expect(resolveGlobalRoot("npm", runCommand, 1000)).resolves.toBe("/tmp/npm-root");
    await expect(resolveGlobalRoot("pnpm", runCommand, 1000)).resolves.toBeNull();
    await expect(resolveGlobalRoot("bun", runCommand, 1000)).resolves.toContain(
      path.join(".bun", "install", "global", "node_modules"),
    );
    await expect(resolveGlobalPackageRoot("npm", runCommand, 1000)).resolves.toBe(
      path.join("/tmp/npm-root", "allbot"),
    );
  });

  it("maps main and explicit install specs for global installs", () => {
    expect(resolveGlobalInstallSpec({ packageName: "allbot", tag: "main" })).toBe(
      ALLBOT_MAIN_PACKAGE_SPEC,
    );
    expect(
      resolveGlobalInstallSpec({
        packageName: "allbot",
        tag: "github:allbot/allbot#feature/my-branch",
      }),
    ).toBe("github:allbot/allbot#feature/my-branch");
    expect(
      resolveGlobalInstallSpec({
        packageName: "allbot",
        tag: "https://example.com/allbot-main.tgz",
      }),
    ).toBe("https://example.com/allbot-main.tgz");
  });

  it("classifies main and raw install specs separately from registry selectors", () => {
    expect(isMainPackageTarget("main")).toBe(true);
    expect(isMainPackageTarget(" MAIN ")).toBe(true);
    expect(isMainPackageTarget("beta")).toBe(false);

    expect(isExplicitPackageInstallSpec("github:allbot/allbot#main")).toBe(true);
    expect(isExplicitPackageInstallSpec("https://example.com/allbot-main.tgz")).toBe(true);
    expect(isExplicitPackageInstallSpec("file:/tmp/allbot-main.tgz")).toBe(true);
    expect(isExplicitPackageInstallSpec("beta")).toBe(false);

    expect(canResolveRegistryVersionForPackageTarget("latest")).toBe(true);
    expect(canResolveRegistryVersionForPackageTarget("2026.3.22")).toBe(true);
    expect(canResolveRegistryVersionForPackageTarget("main")).toBe(false);
    expect(canResolveRegistryVersionForPackageTarget("github:allbot/allbot#main")).toBe(false);
  });

  it("detects install managers from resolved roots and on-disk presence", async () => {
    await withTempDir({ prefix: "allbot-update-global-" }, async (base) => {
      const npmRoot = path.join(base, "npm-root");
      const pnpmRoot = path.join(base, "pnpm-root");
      const bunRoot = path.join(base, ".bun", "install", "global", "node_modules");
      const pkgRoot = path.join(pnpmRoot, "allbot");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.mkdir(path.join(npmRoot, "allbot"), { recursive: true });
      await fs.mkdir(path.join(bunRoot, "allbot"), { recursive: true });

      envSnapshot = captureEnv(["BUN_INSTALL"]);
      process.env.BUN_INSTALL = path.join(base, ".bun");

      const runCommand: CommandRunner = async (argv) => {
        if (argv[0] === "npm") {
          return { stdout: `${npmRoot}\n`, stderr: "", code: 0 };
        }
        if (argv[0] === "pnpm") {
          return { stdout: `${pnpmRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
        "pnpm",
      );
      await expect(detectGlobalInstallManagerByPresence(runCommand, 1000)).resolves.toBe("npm");

      await fs.rm(path.join(npmRoot, "allbot"), { recursive: true, force: true });
      await fs.rm(path.join(pnpmRoot, "allbot"), { recursive: true, force: true });
      await expect(detectGlobalInstallManagerByPresence(runCommand, 1000)).resolves.toBe("bun");
    });
  });

  it("prefers the owning npm prefix when PATH npm points at a different global root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      await withTempDir({ prefix: "allbot-update-npm-prefix-" }, async (base) => {
        const brewPrefix = path.join(base, "opt", "homebrew");
        const brewBin = path.join(brewPrefix, "bin");
        const brewRoot = path.join(brewPrefix, "lib", "node_modules");
        const pkgRoot = path.join(brewRoot, "allbot");
        const pathNpmRoot = path.join(base, "nvm", "lib", "node_modules");
        const brewNpm = path.join(brewBin, "npm");
        await fs.mkdir(pkgRoot, { recursive: true });
        await fs.mkdir(brewBin, { recursive: true });
        await fs.writeFile(brewNpm, "", "utf8");

        const runCommand: CommandRunner = async (argv) => {
          if (argv[0] === "npm") {
            return { stdout: `${pathNpmRoot}\n`, stderr: "", code: 0 };
          }
          if (argv[0] === brewNpm) {
            return { stdout: `${brewRoot}\n`, stderr: "", code: 0 };
          }
          if (argv[0] === "pnpm") {
            return { stdout: "", stderr: "", code: 1 };
          }
          throw new Error(`unexpected command: ${argv.join(" ")}`);
        };

        await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
          "npm",
        );
        await expect(resolveGlobalRoot("npm", runCommand, 1000, pkgRoot)).resolves.toBe(brewRoot);
        await expect(resolveGlobalPackageRoot("npm", runCommand, 1000, pkgRoot)).resolves.toBe(
          pkgRoot,
        );
        await expect(
          resolveGlobalInstallTarget({
            manager: "npm",
            runCommand,
            timeoutMs: 1000,
            pkgRoot,
          }),
        ).resolves.toEqual({
          manager: "npm",
          command: brewNpm,
          globalRoot: brewRoot,
          packageRoot: pkgRoot,
        });
        expect(globalInstallArgs("npm", "allbot@latest", pkgRoot)).toEqual([
          brewNpm,
          "i",
          "-g",
          "allbot@latest",
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
        ]);
        expect(globalInstallFallbackArgs("npm", "allbot@latest", pkgRoot)).toEqual([
          brewNpm,
          "i",
          "-g",
          "allbot@latest",
          "--omit=optional",
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
        ]);
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not infer npm ownership from path shape alone when the owning npm binary is absent", async () => {
    await withTempDir({ prefix: "allbot-update-npm-missing-bin-" }, async (base) => {
      const brewRoot = path.join(base, "opt", "homebrew", "lib", "node_modules");
      const pkgRoot = path.join(brewRoot, "allbot");
      const pathNpmRoot = path.join(base, "nvm", "lib", "node_modules");
      await fs.mkdir(pkgRoot, { recursive: true });

      const runCommand: CommandRunner = async (argv) => {
        if (argv[0] === "npm") {
          return { stdout: `${pathNpmRoot}\n`, stderr: "", code: 0 };
        }
        if (argv[0] === "pnpm") {
          return { stdout: "", stderr: "", code: 1 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(
        detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000),
      ).resolves.toBeNull();
      expect(globalInstallArgs("npm", "allbot@latest", pkgRoot)).toEqual([
        "npm",
        "i",
        "-g",
        "allbot@latest",
        "--no-fund",
        "--no-audit",
        "--loglevel=error",
      ]);
    });
  });

  it("prefers npm.cmd for win32-style global npm roots", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir({ prefix: "allbot-update-win32-npm-prefix-" }, async (base) => {
        const npmPrefix = path.join(base, "Roaming", "npm");
        const npmRoot = path.join(npmPrefix, "node_modules");
        const pkgRoot = path.join(npmRoot, "allbot");
        const npmCmd = path.join(npmPrefix, "npm.cmd");
        const pathNpmRoot = path.join(base, "nvm", "node_modules");
        await fs.mkdir(pkgRoot, { recursive: true });
        await fs.writeFile(npmCmd, "", "utf8");

        const runCommand: CommandRunner = async (argv) => {
          if (argv[0] === "npm") {
            return { stdout: `${pathNpmRoot}\n`, stderr: "", code: 0 };
          }
          if (argv[0] === npmCmd) {
            return { stdout: `${npmRoot}\n`, stderr: "", code: 0 };
          }
          if (argv[0] === "pnpm") {
            return { stdout: "", stderr: "", code: 1 };
          }
          throw new Error(`unexpected command: ${argv.join(" ")}`);
        };

        await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
          "npm",
        );
        await expect(resolveGlobalRoot("npm", runCommand, 1000, pkgRoot)).resolves.toBe(npmRoot);
        expect(globalInstallArgs("npm", "allbot@latest", pkgRoot)).toEqual([
          npmCmd,
          "i",
          "-g",
          "allbot@latest",
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
        ]);
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("builds install argv and npm fallback argv", () => {
    expect(resolveGlobalInstallCommand("npm")).toEqual({
      manager: "npm",
      command: "npm",
    });
    expect(globalInstallArgs("npm", "allbot@latest")).toEqual([
      "npm",
      "i",
      "-g",
      "allbot@latest",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
    ]);
    expect(globalInstallArgs("pnpm", "allbot@latest")).toEqual([
      "pnpm",
      "add",
      "-g",
      "allbot@latest",
    ]);
    expect(globalInstallArgs("bun", "allbot@latest")).toEqual([
      "bun",
      "add",
      "-g",
      "allbot@latest",
    ]);

    expect(globalInstallFallbackArgs("npm", "allbot@latest")).toEqual([
      "npm",
      "i",
      "-g",
      "allbot@latest",
      "--omit=optional",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
    ]);
    expect(globalInstallFallbackArgs("pnpm", "allbot@latest")).toBeNull();
    expect(
      globalInstallArgs({ manager: "pnpm", command: "/opt/homebrew/bin/pnpm" }, "allbot@latest"),
    ).toEqual(["/opt/homebrew/bin/pnpm", "add", "-g", "allbot@latest"]);
  });

  it("cleans only renamed package directories", async () => {
    await withTempDir({ prefix: "allbot-update-cleanup-" }, async (root) => {
      await fs.mkdir(path.join(root, ".allbot-123"), { recursive: true });
      await fs.mkdir(path.join(root, ".allbot-456"), { recursive: true });
      await fs.writeFile(path.join(root, ".allbot-file"), "nope", "utf8");
      await fs.mkdir(path.join(root, "allbot"), { recursive: true });

      await expect(
        cleanupGlobalRenameDirs({
          globalRoot: root,
          packageName: "allbot",
        }),
      ).resolves.toEqual({
        removed: [".allbot-123", ".allbot-456"],
      });
      await expect(fs.stat(path.join(root, "allbot"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(root, ".allbot-file"))).resolves.toBeDefined();
    });
  });

  it("checks bundled runtime sidecars — detects missing file", async () => {
    await withTempDir({ prefix: "allbot-update-global-pkg-" }, async (packageRoot) => {
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "allbot", version: "1.0.0" }),
        "utf-8",
      );
      for (const relativePath of BUNDLED_RUNTIME_SIDECAR_PATHS) {
        const absolutePath = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, "export {};\n", "utf-8");
      }

      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toEqual([]);

      await fs.rm(path.join(packageRoot, FIRST_SIDECAR));
      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
        `missing bundled runtime sidecar ${FIRST_SIDECAR}`,
      );
    });
  });
});
