import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listBusinessProviderAdapters,
  resolveBusinessProviderAdapter,
} from "../business/provider-registry.js";
import { reloadBusinessProviderCredentials } from "../business/provider-credentials.js";
import { createBusinessRequestStore, type BusinessRequestStore } from "../business/store.js";
import {
  cancelBusinessRequest,
  confirmBusinessRequest,
  createBusinessRequest,
  dispatchBusinessRequest,
  listBusinessRequests,
  writeBusinessConfirmationToken,
  type BusinessRequestActionResult,
  type DispatchBusinessRequestResult,
} from "../business/workflow.js";
import type { BusinessRequestKind } from "../business/types.js";
import { isLocalDirectRequest } from "./auth.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getHeader } from "./http-utils.js";

const PATH = "/__allbot/business-requests";
const DATA_PATH = "/__allbot/business-requests.json";
const MAX_BODY_BYTES = 16 * 1024;

type HandlerDeps = {
  store?: BusinessRequestStore;
  /** Injectable in tests; production writes a 0600 file outside model reach. */
  writeToken?: (requestId: string, token: string) => Promise<string>;
};

const PROVIDER_ADAPTER_RESOLVER: unique symbol = Symbol.for(
  "allbot.business.providerAdapterResolver",
);

type ProviderAdapterResolver = (request: {
  providerId?: string;
  kind: BusinessRequestKind;
}) => ReturnType<typeof resolveBusinessProviderAdapter>;

type GlobalWithResolver = typeof globalThis & {
  [PROVIDER_ADAPTER_RESOLVER]?: ProviderAdapterResolver;
};

/** Opt-in runtime seam for a deployment-specific payment/identity provider. */
export function setBusinessProviderAdapterResolver(
  resolver: ProviderAdapterResolver | undefined,
): void {
  (globalThis as GlobalWithResolver)[PROVIDER_ADAPTER_RESOLVER] = resolver;
}

function resolveAdapter(request: {
  providerId?: string;
  kind: BusinessRequestKind;
}): ReturnType<typeof resolveBusinessProviderAdapter> {
  const custom = (globalThis as GlobalWithResolver)[PROVIDER_ADAPTER_RESOLVER];
  const resolved = custom?.(request) ?? resolveBusinessProviderAdapter(request.providerId ?? "", request.kind);
  return resolved?.kind === request.kind ? resolved : undefined;
}

const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  not_found: 404,
  forbidden: 403,
  expired: 410,
  invalid_confirmation: 400,
  illegal_transition: 409,
  provider_not_registered: 422,
  provider_failed: 502,
};

function sendActionResult(
  res: ServerResponse,
  result: BusinessRequestActionResult | DispatchBusinessRequestResult,
): void {
  if (result.ok) {
    sendJson(res, 200, { status: "ok", request: result.request });
    return;
  }
  sendJson(res, ERROR_STATUS[result.code] ?? 400, {
    status: result.code,
    message: result.message,
    ...(result.request ? { request: result.request } : {}),
  });
}

function readOwnerId(req: IncomingMessage): string | undefined {
  return getHeader(req, "x-allbot-owner-id")?.trim() || undefined;
}

/**
 * Loopback-only human confirmation boundary. The owner identity comes from a
 * local operator header, and the confirmation token is delivered to a 0600
 * outbox file, never back to a model-facing caller.
 */
export function handleBusinessRequestsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps = {},
): boolean {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== PATH && path !== DATA_PATH) {
    return false;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (!isLocalDirectRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden: business requests are loopback-only");
    return true;
  }
  if (path === DATA_PATH) {
    if (method !== "GET" && method !== "HEAD") {
      sendMethodNotAllowed(res, "GET, HEAD");
      return true;
    }
    void (async () => {
      try {
        const requests = await listBusinessRequests(deps.store ?? createBusinessRequestStore());
        res.statusCode = 200;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          method === "HEAD"
            ? undefined
            : JSON.stringify({
                total: requests.length,
                providers: listBusinessProviderAdapters(),
                requests,
              }),
        );
      } catch (err) {
        sendJson(res, 500, { status: "error", message: String(err) });
      }
    })();
    return true;
  }
  if (method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  void (async () => {
    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return;
    }
    const payload = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const ownerId = readOwnerId(req);
    if (!ownerId) {
      sendJson(res, 400, {
        status: "invalid_request",
        message: "x-allbot-owner-id header is required for local operator actions.",
      });
      return;
    }
    const store = deps.store ?? createBusinessRequestStore();
    const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
    const action = payload.action;
    try {
      if (action === "prepare") {
        const created = await createBusinessRequest({
          store,
          ownerId,
          kind: payload.kind as BusinessRequestKind,
          operation: typeof payload.operation === "string" ? payload.operation : "",
          summary: typeof payload.summary === "string" ? payload.summary : "",
          ...(typeof payload.providerId === "string" ? { providerId: payload.providerId } : {}),
        });
        if (!created.ok || !created.token) {
          sendActionResult(res, created);
          return;
        }
        const tokenPath = deps.writeToken
          ? await deps.writeToken(created.request.requestId, created.token)
          : await writeBusinessConfirmationToken(created.request.requestId, created.token);
        sendJson(res, 201, {
          status: "awaiting_confirmation",
          request: created.request,
          confirmationTokenPath: tokenPath,
          note: "Read the token from the local 0600 file, then POST action=confirm with it. No provider is called by prepare.",
        });
        return;
      }
      if (action === "confirm") {
        if (!requestId || typeof payload.token !== "string") {
          sendJson(res, 400, {
            status: "invalid_request",
            message: "requestId and token are required.",
          });
          return;
        }
        sendActionResult(
          res,
          await confirmBusinessRequest({
            store,
            requestId,
            ownerId,
            token: payload.token,
          }),
        );
        return;
      }
      if (action === "cancel") {
        if (!requestId) {
          sendJson(res, 400, { status: "invalid_request", message: "requestId is required." });
          return;
        }
        sendActionResult(res, await cancelBusinessRequest({ store, requestId, ownerId }));
        return;
      }
      if (action === "reload-providers") {
        const configuredPath =
          typeof payload.path === "string" && payload.path.trim()
            ? payload.path.trim()
            : undefined;
        const result = await reloadBusinessProviderCredentials(
          configuredPath ? { filePath: configuredPath } : {},
        );
        sendJson(res, result.ok ? 200 : 400, {
          status: result.ok ? "ok" : "invalid_provider_credentials",
          ...result,
        });
        return;
      }
      if (action === "dispatch") {
        if (!requestId) {
          sendJson(res, 400, { status: "invalid_request", message: "requestId is required." });
          return;
        }
        sendActionResult(
          res,
          await dispatchBusinessRequest({
            store,
            requestId,
            ownerId,
            resolveAdapter,
          }),
        );
        return;
      }
      sendJson(res, 400, {
        status: "invalid_request",
        message: "action must be prepare, confirm, cancel, dispatch or reload-providers.",
      });
    } catch (err) {
      sendJson(res, 500, { status: "error", message: String(err) });
    }
  })();
  return true;
}
