import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import { createBusinessRequestStore } from "../business/store.js";
import {
  handleBusinessRequestsHttpRequest,
  setBusinessProviderAdapterResolver,
} from "./business-requests-http.js";

const dirs: string[] = [];
const tokens = new Map<string, string>();

afterEach(async () => {
  setBusinessProviderAdapterResolver(undefined);
  tokens.clear();
  await drainSessionWriteLockStateForTest();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "allbot-business-http-"));
  dirs.push(dir);
  return createBusinessRequestStore({ filePath: path.join(dir, "requests.json") });
}

function makeReq(
  method: string,
  url: string,
  body?: unknown,
  remoteAddress = "127.0.0.1",
  ownerId = "ou_owner",
) {
  const req = (
    body === undefined ? Readable.from([]) : Readable.from([JSON.stringify(body)])
  ) as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = ownerId ? { "x-allbot-owner-id": ownerId } : {};
  req.socket = { remoteAddress } as IncomingMessage["socket"];
  return req;
}

type FakeResponse = {
  res: ServerResponse;
  status: () => number;
  text: () => string;
  json: () => Record<string, unknown>;
};

function makeRes(): FakeResponse {
  let statusCode = 200;
  const chunks: string[] = [];
  const res = {
    set statusCode(value: number) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
    setHeader() {},
    end(body?: string) {
      if (body) {
        chunks.push(body);
      }
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    text: () => chunks.join(""),
    json: () => JSON.parse(chunks.filter(Boolean).join("")) as Record<string, unknown>,
  };
}

async function settle() {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function handler(store: ReturnType<typeof makeStore>) {
  return (req: IncomingMessage, res: ServerResponse) =>
    handleBusinessRequestsHttpRequest(req, res, {
      store,
      writeToken: async (requestId, token) => {
        tokens.set(requestId, token);
        return `/tmp/${requestId}.token`;
      },
    });
}

describe("handleBusinessRequestsHttpRequest", () => {
  it("ignores unrelated paths", () => {
    const { res } = makeRes();
    expect(handler(makeStore())(makeReq("GET", "/health"), res)).toBe(false);
  });

  it("rejects non-loopback requests", () => {
    const { res, status, text } = makeRes();
    expect(
      handler(makeStore())(
        makeReq("GET", "/__allbot/business-requests.json", undefined, "203.0.113.9"),
        res,
      ),
    ).toBe(true);
    expect(status()).toBe(403);
    expect(text()).toContain("loopback-only");
  });

  it("requires a local operator owner header", async () => {
    const { res, status, json } = makeRes();
    const handle = handler(makeStore());
    expect(
      handle(
        makeReq("POST", "/__allbot/business-requests", { action: "prepare" }, "127.0.0.1", ""),
        res,
      ),
    ).toBe(true);
    await settle();
    expect(status()).toBe(400);
    expect(json().status).toBe("invalid_request");
  });

  it("exposes the full prepare -> confirm -> no-provider boundary", async () => {
    const store = makeStore();
    const handle = handler(store);
    const prepareRes = makeRes();
    expect(
      handle(
        makeReq("POST", "/__allbot/business-requests", {
          action: "prepare",
          kind: "payment",
          operation: "verify-account",
          summary: "Identity check for a payment account",
          providerId: "unconfigured",
        }),
        prepareRes.res,
      ),
    ).toBe(true);
    await settle();
    expect(prepareRes.status()).toBe(201);
    const prepared = prepareRes.json();
    const request = prepared.request as { requestId: string; status: string };
    expect(request.status).toBe("awaiting_confirmation");
    expect(prepared.confirmationTokenPath).toBe(`/tmp/${request.requestId}.token`);
    expect(prepareRes.text()).not.toContain(tokens.get(request.requestId) ?? "impossible-token");

    const confirmRes = makeRes();
    expect(
      handle(
        makeReq("POST", "/__allbot/business-requests", {
          action: "confirm",
          requestId: request.requestId,
          token: tokens.get(request.requestId),
        }),
        confirmRes.res,
      ),
    ).toBe(true);
    await settle();
    expect(confirmRes.status()).toBe(200);
    expect((confirmRes.json().request as { status: string }).status).toBe("confirmed");

    const dispatchRes = makeRes();
    expect(
      handle(
        makeReq("POST", "/__allbot/business-requests", {
          action: "dispatch",
          requestId: request.requestId,
        }),
        dispatchRes.res,
      ),
    ).toBe(true);
    await settle();
    expect(dispatchRes.status()).toBe(422);
    expect(dispatchRes.json().status).toBe("provider_not_registered");
    expect((await store.read()).requests[0]?.status).toBe("confirmed");
  });

  it("dispatches through an explicitly registered runtime adapter", async () => {
    const store = makeStore();
    const handle = handler(store);
    setBusinessProviderAdapterResolver(() => ({
      id: "local-identity-test",
      kind: "identity",
      execute: async ({ requestId }) => ({ ok: true, externalReference: `id:${requestId}` }),
    }));
    const prepareRes = makeRes();
    expect(
      handle(
        makeReq("POST", "/__allbot/business-requests", {
          action: "prepare",
          kind: "identity",
          operation: "verify-name",
          summary: "Compare name with an identity document",
        }),
        prepareRes.res,
      ),
    ).toBe(true);
    await settle();
    const requestId = (prepareRes.json().request as { requestId: string }).requestId;
    const confirmRes = makeRes();
    expect(
      handle(
        makeReq("POST", "/__allbot/business-requests", {
          action: "confirm",
          requestId,
          token: tokens.get(requestId),
        }),
        confirmRes.res,
      ),
    ).toBe(true);
    await settle();
    expect(confirmRes.status()).toBe(200);
    const dispatchRes = makeRes();
    expect(
      handle(
        makeReq("POST", "/__allbot/business-requests", { action: "dispatch", requestId }),
        dispatchRes.res,
      ),
    ).toBe(true);
    await settle();
    expect(dispatchRes.status()).toBe(200);
    expect(dispatchRes.text()).toContain('"status":"completed"');
    expect((await store.read()).requests[0]?.status).toBe("completed");
  });

  it("serves loopback-only read status", async () => {
    const store = makeStore();
    const { res, status, json } = makeRes();
    expect(
      handler(store)(makeReq("GET", "/__allbot/business-requests.json"), res),
    ).toBe(true);
    await settle();
    expect(status()).toBe(200);
    expect(json().total).toBe(0);
    expect(json().providers).toEqual([]);
  });
});
