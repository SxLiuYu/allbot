import { spawn } from "node:child_process";
import path from "node:path";
import { buildCmdExeCommandLine } from "./windows-cmd-helpers.mjs";

/**
 * `npm_execpath` 只有指向 JS 包装（pnpm.cjs / pnpm-cli.js）时才能交给 node 执行。
 * Windows 上的 pnpm 安装（含 @pnpm/exe 的独立版）会把它设成 pnpm.exe，那是原生的
 * PE 二进制，交给 node 会报 "SyntaxError: Invalid or unexpected token"。所以只认
 * .cjs / .js，其余（.exe / .cmd / 裸名）一律走下面的平台分支。
 */
function isPnpmExecPath(value) {
  return /^pnpm(?:-cli)?\.(?:cjs|js)$/.test(path.basename(value).toLowerCase());
}

export function resolvePnpmRunner(params = {}) {
  const pnpmArgs = params.pnpmArgs ?? [];
  const nodeArgs = params.nodeArgs ?? [];
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? process.env.ComSpec ?? "cmd.exe";

  if (typeof npmExecPath === "string" && npmExecPath.length > 0 && isPnpmExecPath(npmExecPath)) {
    return {
      command: nodeExecPath,
      args: [...nodeArgs, npmExecPath, ...pnpmArgs],
      shell: false,
    };
  }

  if (platform === "win32") {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine("pnpm.cmd", pnpmArgs)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return {
    command: "pnpm",
    args: pnpmArgs,
    shell: false,
  };
}

export function createPnpmRunnerSpawnSpec(params = {}) {
  const runner = resolvePnpmRunner(params);
  return {
    command: runner.command,
    args: runner.args,
    options: {
      cwd: params.cwd,
      detached: params.detached,
      stdio: params.stdio ?? "inherit",
      env: params.env ?? runner.env ?? process.env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    },
  };
}

export function spawnPnpmRunner(params = {}) {
  const spawnSpec = createPnpmRunnerSpawnSpec(params);
  return spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
}
