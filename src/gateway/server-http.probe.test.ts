import { afterEach, describe, expect, it } from "vitest";
import type { SchedulerRuntimeHealth } from "../cognitive/scheduler/health.js";
import {
  setCognitiveSchedulerHealthProvider,
  resetCognitiveSchedulerHealthProvider,
} from "./cognitive-scheduler-health-registry.js";
import {
  AUTH_TOKEN,
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";

afterEach(() => {
  resetCognitiveSchedulerHealthProvider();
});

function healthyHealth(): SchedulerRuntimeHealth {
  const now = Date.now();
  return {
    enabled: true,
    running: true,
    startedAt: now - 5000,
    lastHeartbeatAt: now,
    lastTickStartedAt: now - 1000,
    lastTickCompletedAt: now - 500,
    lastEventAt: now - 1000,
    nextTickAt: now + 10_000,
    tickInFlight: false,
    timerScheduled: true,
    expectedIntervalMs: 3600_000,
    tickCount: 3,
    eventCount: 3,
    consecutiveTickFailures: 0,
  };
}

function staleHealth(): SchedulerRuntimeHealth {
  const now = Date.now();
  return {
    enabled: true,
    running: false,
    startedAt: now - 60 * 60_000,
    lastHeartbeatAt: null,
    lastTickStartedAt: null,
    lastTickCompletedAt: null,
    lastEventAt: null,
    nextTickAt: null,
    tickInFlight: false,
    timerScheduled: false,
    expectedIntervalMs: 3600_000,
    tickCount: 0,
    eventCount: 0,
    consecutiveTickFailures: 0,
  };
}

describe("gateway probe endpoints", () => {
  it("returns detailed readiness payload for local /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 45_000,
    });

    await withGatewayServer({
      prefix: "probe-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ready: true, failing: [], uptimeMs: 45_000 });
      },
    });
  });

  it("returns only readiness state for unauthenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false });
      },
    });
  });

  it("returns detailed readiness payload for authenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-remote-authenticated",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
          authorization: "Bearer test-token",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({
          ready: false,
          failing: ["discord", "telegram"],
          uptimeMs: 8_000,
        });
      },
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };

    await withGatewayServer({
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
      },
    });
  });

  it("keeps /healthz shallow even when readiness checker reports failing channels", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 999,
    });

    await withGatewayServer({
      prefix: "probe-healthz-unaffected",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/healthz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
      },
    });
  });

  it("reflects readiness status on HEAD /readyz without a response body", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 5_000,
    });

    await withGatewayServer({
      prefix: "probe-readyz-head",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/readyz", method: "HEAD" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });

  it("returns 200 for healthy /health/cognitive from a local request with details", async () => {
    setCognitiveSchedulerHealthProvider(healthyHealth);

    await withGatewayServer({
      prefix: "probe-cognitive-healthy",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/health/cognitive" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(getBody());
        expect(body.ok).toBe(true);
        expect(body.stale).toBe(false);
        expect(body).toHaveProperty("health");
      },
    });
  });

  it("returns 503 for stale /health/cognitive", async () => {
    setCognitiveSchedulerHealthProvider(staleHealth);

    await withGatewayServer({
      prefix: "probe-cognitive-stale",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/health/cognitive" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        const body = JSON.parse(getBody());
        expect(body.ok).toBe(false);
        expect(body.stale).toBe(true);
      },
    });
  });

  it("returns no body on HEAD /health/cognitive", async () => {
    setCognitiveSchedulerHealthProvider(healthyHealth);

    await withGatewayServer({
      prefix: "probe-cognitive-head",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/health/cognitive", method: "HEAD" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe("");
      },
    });
  });

  it("returns only {ok,stale} for unauthenticated remote /health/cognitive", async () => {
    setCognitiveSchedulerHealthProvider(healthyHealth);

    await withGatewayServer({
      prefix: "probe-cognitive-remote",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/health/cognitive",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(getBody());
        expect(body).toEqual({ ok: true, stale: false });
      },
    });
  });
});
