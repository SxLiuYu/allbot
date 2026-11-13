import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleProactiveStatusHttpRequest } from "./proactive-status.js";

vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../infra/json-files.js", () => ({ readJsonFile: async () => null }));
vi.mock("../config/paths.js", () => ({ resolveStateDir: () => "/tmp/allbot-test-state" }));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  resolveConfigDir: () => "/tmp/allbot-test-config",
}));

const guiVerdictPath = path.join(os.homedir(), "gui-permission-verdict.txt");

function makeReq(url: string, method = "GET", remoteAddress = "127.0.0.1") {
  return {
    url,
    method,
    headers: {},
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: Array<string | undefined> = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      chunks.push(body);
    },
  } as unknown as ServerResponse;
  return { res, chunks, headers };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("handleProactiveStatusHttpRequest", () => {
  it("ignores unrelated paths", () => {
    const { res } = makeRes();
    expect(handleProactiveStatusHttpRequest(makeReq("/health"), res)).toBe(false);
  });

  it("rejects non-loopback requests", () => {
    const { res, chunks } = makeRes();
    expect(
      handleProactiveStatusHttpRequest(
        makeReq("/__allbot/proactive-status", "GET", "203.0.113.9"),
        res,
      ),
    ).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(chunks.join("")).toContain("loopback-only");
  });

  it("returns a 405 for non-GET methods", () => {
    const { res } = makeRes();
    expect(
      handleProactiveStatusHttpRequest(makeReq("/__allbot/proactive-status", "POST"), res),
    ).toBe(true);
    expect(res.statusCode).toBe(405);
  });

  it("reports capability gaps without claiming payment/identity business support", async () => {
    const { res, chunks } = makeRes();
    expect(handleProactiveStatusHttpRequest(makeReq("/__allbot/proactive-status"), res)).toBe(true);
    await settle();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(chunks.filter(Boolean).join("")) as {
      capabilities: Record<string, string>;
      pushLog: { day: string };
    };
    expect(body.capabilities.browserProxy).toBe("implemented");
    expect(body.capabilities.systemRun).toBe("implemented");
    expect(body.capabilities.nativeDesktopGui).toBe("blocked_by_macos_permissions");
    expect(body.capabilities.paymentBusiness).toBe("human_confirmation_workflow");
    expect(body.capabilities.identityBusiness).toBe("human_confirmation_workflow");
    expect(body.capabilities.sensitiveTaskHumanReview).toBe("implemented");
    expect(body.pushLog.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reports nativeDesktopGui as implemented after a PASS verdict", async () => {
    const original = await fs.readFile(guiVerdictPath, "utf8").catch(() => null);
    try {
      await fs.writeFile(guiVerdictPath, "gui_verdict=PASS\n", "utf8");
      const { res, chunks } = makeRes();
      expect(handleProactiveStatusHttpRequest(makeReq("/__allbot/proactive-status"), res)).toBe(
        true,
      );
      await settle();
      const body = JSON.parse(chunks.filter(Boolean).join("")) as {
        capabilities: Record<string, string>;
      };
      expect(body.capabilities.nativeDesktopGui).toBe("implemented");
    } finally {
      if (original === null) {
        await fs.rm(guiVerdictPath, { force: true });
      } else {
        await fs.writeFile(guiVerdictPath, original, "utf8");
      }
    }
  });
});
