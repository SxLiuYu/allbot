import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
// node_modules/.bin/vite is a POSIX sh script (plus .CMD/.ps1 siblings) on Windows,
// so handing it to node fails with a syntax error. Vite's real JS entry works everywhere.
const viteCli = path.resolve(repoRoot, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(process.execPath, [viteCli, "build"], {
  cwd: path.resolve(repoRoot, "ui"),
  stdio: "inherit",
  env: process.env,
});

const indexPath = path.resolve(repoRoot, "dist", "control-ui", "index.html");

if (existsSync(indexPath)) {
  console.log("[build-control-ui] Control UI built successfully.");
  process.exit(0);
}

console.error("[build-control-ui] Build failed — index.html not found.");
process.exit(result.status ?? 1);
