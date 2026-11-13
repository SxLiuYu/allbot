import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleOwnerTasksBoardHttpRequest } from "./owner-tasks-board.js";

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
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    end(body?: string) {
      chunks.push(body);
    },
  } as unknown as ServerResponse;
  return { res, chunks, headers };
}

describe("handleOwnerTasksBoardHttpRequest", () => {
  it("ignores unrelated paths", () => {
    const { res } = makeRes();
    expect(handleOwnerTasksBoardHttpRequest(makeReq("/health"), res)).toBe(false);
  });

  it("rejects non-loopback requests", () => {
    const { res, chunks } = makeRes();
    expect(
      handleOwnerTasksBoardHttpRequest(
        makeReq("/__allbot/owner-tasks", "GET", "203.0.113.9"),
        res,
      ),
    ).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(chunks.join("")).toContain("loopback-only");
  });

  it("rejects non-loopback requests on the JSON endpoint too", () => {
    const { res, chunks } = makeRes();
    expect(
      handleOwnerTasksBoardHttpRequest(
        makeReq("/__allbot/owner-tasks.json", "GET", "203.0.113.9"),
        res,
      ),
    ).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(chunks.join("")).toContain("loopback-only");
  });

  it("returns a 405 for non-GET methods", () => {
    const { res } = makeRes();
    expect(handleOwnerTasksBoardHttpRequest(makeReq("/__allbot/owner-tasks", "POST"), res)).toBe(
      true,
    );
    expect(res.statusCode).toBe(405);
  });
});
