import path from "node:path";
import { describe, expect, it } from "vitest";
import { __analyzeScriptTargetsForPreflightTest } from "./bash-tools.exec.js";

const workdir = path.resolve("/tmp/agent-workspace");

describe("exec preflight segmented script target analysis", () => {
  it("resolves cd && python3 script.py to the script under the cd target", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      "cd /tmp/agent-workspace && python3 tools/ai_sources.py --hours 72",
      workdir,
    );

    expect(analysis.unsafe).toBe(false);
    expect(analysis.hasControlFlowSegment).toBe(false);
    expect(analysis.unresolvedScriptSegments).toBe(0);
    expect(analysis.targets).toEqual([
      {
        kind: "python",
        relOrAbsPaths: ["tools/ai_sources.py"],
        cwd: path.resolve("/tmp/agent-workspace"),
      },
    ]);
  });

  it("resolves cd with a relative path against the session workdir", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      "cd tools && python3 ai_sources.py",
      workdir,
    );

    expect(analysis.targets).toEqual([
      {
        kind: "python",
        relOrAbsPaths: ["ai_sources.py"],
        cwd: path.join(workdir, "tools"),
      },
    ]);
  });

  it("tracks cd across multiple interpreter segments", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      "cd /tmp/agent-workspace && python3 tools/ai_sources.py && cd /tmp/other && node build.js",
      workdir,
    );

    expect(analysis.targets.map((t) => t.cwd)).toEqual([
      path.resolve("/tmp/agent-workspace"),
      path.resolve("/tmp/other"),
    ]);
  });

  it("ignores the downstream pipe consumer when the interpreter is the producer", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      "cd /tmp/agent-workspace && python3 tools/ai_sources.py --hours 24 2>&1 | tail -180",
      workdir,
    );

    expect(analysis.unsafe).toBe(false);
    expect(analysis.targets).toEqual([
      {
        kind: "python",
        relOrAbsPaths: ["tools/ai_sources.py"],
        cwd: path.resolve("/tmp/agent-workspace"),
      },
    ]);
  });

  it("keeps shell control flow marked as branching", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      "if true; then python3 tools/ai_sources.py; fi",
      workdir,
    );

    expect(analysis.hasControlFlowSegment).toBe(true);
  });

  it("marks shell wrappers as unsafe", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      'bash -c "python3 tools/ai_sources.py"',
      workdir,
    );

    expect(analysis.unsafe).toBe(true);
  });

  it("marks dynamic cd targets as unsafe", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      "cd $HOME/workspace && python3 tools/ai_sources.py",
      workdir,
    );

    expect(analysis.unsafe).toBe(true);
  });

  it("counts interpreter segments whose script file cannot be pinned down", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      "cd /tmp/agent-workspace && python3 -c 'print(1)' && python3 -m http.server",
      workdir,
    );

    expect(analysis.unresolvedScriptSegments).toBe(0);
    expect(analysis.targets).toEqual([]);
  });

  it("treats a python segment without any script operand as unresolved", () => {
    const analysis = __analyzeScriptTargetsForPreflightTest(
      "cd /tmp/agent-workspace && python3 --version && python3 notascript",
      workdir,
    );

    expect(analysis.unresolvedScriptSegments).toBe(1);
  });
});
