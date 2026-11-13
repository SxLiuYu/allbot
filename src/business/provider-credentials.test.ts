import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listBusinessProviderAdapters,
  resolveBusinessProviderAdapter,
  unregisterBusinessProviderAdapter,
} from "./provider-registry.js";
import {
  reloadBusinessProviderCredentials,
  resolveBusinessProviderCredentialPath,
} from "./provider-credentials.js";

const files: string[] = [];
const adapters: string[] = [];

afterEach(async () => {
  for (const id of listBusinessProviderAdapters().map((entry) => entry.id)) {
    if (id.startsWith("credential-file:")) {
      unregisterBusinessProviderAdapter(id);
    }
  }
  adapters.splice(0);
  for (const file of files.splice(0)) {
    await fs.rm(file, { force: true });
  }
});

async function writeCredentialFile(value: unknown, mode = 0o600): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "allbot-provider-credentials-"));
  const file = path.join(dir, "credentials.json");
  files.push(file);
  await fs.writeFile(file, JSON.stringify(value), { mode });
  await fs.chmod(file, mode);
  return file;
}

function validConfig(id = "payment-primary") {
  return {
    id,
    kind: "payment",
    provider: "stripe",
    mode: "sandbox",
    credentials: {
      merchant_id: "acct_test",
      api_key: "pk_test_placeholder",
      api_secret: "secret_placeholder",
      webhook_secret: "whsec_placeholder",
      callback_url: "https://example.invalid/webhook",
    },
  };
}

describe("business provider credential loader", () => {
  it("uses a default 0600 path under ~/files", () => {
    expect(resolveBusinessProviderCredentialPath({})).toBe(
      path.join(os.homedir(), "files", "allbot-provider-credentials.json"),
    );
  });

  it("refuses missing or world-readable credential files when the OS enforces mode", async () => {
    const missing = await reloadBusinessProviderCredentials({
      filePath: path.join(os.tmpdir(), "allbot-missing-provider-credentials.json"),
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain("unavailable");

    const readable = await writeCredentialFile({ providers: [validConfig()] }, 0o644);
    const result = await reloadBusinessProviderCredentials({ filePath: readable });
    if (process.platform === "win32") {
      expect(result.mode).not.toBeNull();
    } else {
      expect(result.ok).toBe(false);
      expect(result.mode).toBe(0o644);
      expect(result.errors.join(" ")).toContain("mode must be 0600");
      expect(listBusinessProviderAdapters()).toEqual([]);
    }
  });

  it("refuses template placeholders and incomplete secrets", async () => {
    const file = await writeCredentialFile({
      providers: [{ ...validConfig(), provider: "stripe_or_alipay" }],
    });
    const result = await reloadBusinessProviderCredentials({ filePath: file });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("must name a real provider");
    expect(listBusinessProviderAdapters()).toEqual([]);

    const blank = await writeCredentialFile({
      providers: [
        {
          ...validConfig("payment-blank"),
          credentials: { ...validConfig().credentials, api_key: null },
        },
      ],
    });
    const blankResult = await reloadBusinessProviderCredentials({ filePath: blank });
    expect(blankResult.ok).toBe(false);
    expect(blankResult.errors.join(" ")).toContain("api_key is required");
  });

  it("registers only credential-file adapters and refuses non-sandbox keys", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = await writeCredentialFile({
      providers: [{ ...validConfig(), credentials: { ...validConfig().credentials, api_key: "sk_live_placeholder" } }, { ...validConfig("identity-primary"), kind: "identity", provider: "persona", credentials: { app_id: "app_test", api_key: "key_test", api_secret: "secret_test", webhook_secret: "whsec_test" } }],
    });
    const result = await reloadBusinessProviderCredentials({ filePath: file });
    expect(result.ok).toBe(true);
    expect(result.mode).not.toBeNull();
    expect(result.registered).toEqual([
      { id: "credential-file:payment-primary", kind: "payment" },
      { id: "credential-file:identity-primary", kind: "identity" },
    ]);
    const provider = resolveBusinessProviderAdapter(
      "credential-file:payment-primary",
      "payment",
    );
    expect(provider?.kind).toBe("payment");
    const noExternalAdapter = await provider?.execute({
      requestId: "business_test_no_adapter",
      kind: "payment",
      operation: "verify-account",
      summary: "boundary check",
    });
    expect(noExternalAdapter?.ok).toBe(false);
    expect(noExternalAdapter && "error" in noExternalAdapter && noExternalAdapter.error).toContain(
      "not configured with a Stripe sandbox test key",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    const second = await reloadBusinessProviderCredentials({ filePath: file });
    expect(second.ok).toBe(true);
    expect(listBusinessProviderAdapters()).toHaveLength(2);

    const missingAfterRegistration = await reloadBusinessProviderCredentials({
      filePath: path.join(os.tmpdir(), "allbot-missing-after-registration.json"),
    });
    expect(missingAfterRegistration.ok).toBe(false);
    expect(listBusinessProviderAdapters()).toEqual([]);
  });

  it("refuses a publishable test key before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = await writeCredentialFile({
      providers: [{ ...validConfig(), credentials: { ...validConfig().credentials, api_key: "pk_test_placeholder" } }],
    });
    const loaded = await reloadBusinessProviderCredentials({ filePath: file });
    expect(loaded.ok).toBe(true);
    const adapter = resolveBusinessProviderAdapter("credential-file:payment-primary", "payment");
    const outcome = await adapter?.execute({
      requestId: "business_test_pk_refused",
      kind: "payment",
      operation: "verify-account",
      summary: "publishable key must not satisfy provider-issued credentials",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome?.ok).toBe(false);
    expect(outcome && "error" in outcome && outcome.error).toContain("not configured with a Stripe sandbox test key");
    vi.unstubAllGlobals();
  });

  it("calls the Stripe sandbox PaymentIntent API with a secret test key", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const url = String(_url);
      const body = String(init?.body ?? "");
      expect(url).toBe("https://api.stripe.com/v1/payment_intents");
      expect(body).toContain("metadata%5Ballbot_request_id%5D=business_test_stripe");
      expect(body).toContain("amount=100");
      expect(body).not.toContain("payment_method_types");
      return new Response(JSON.stringify({ id: "pi_sandbox_test_123", object: "payment_intent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = await writeCredentialFile({
      providers: [{ ...validConfig(), credentials: { ...validConfig().credentials, api_key: "sk_test_placeholder" } }],
    });
    const loaded = await reloadBusinessProviderCredentials({ filePath: file });
    expect(loaded.ok).toBe(true);
    const adapter = resolveBusinessProviderAdapter("credential-file:payment-primary", "payment");
    const outcome = await adapter?.execute({
      requestId: "business_test_stripe",
      kind: "payment",
      operation: "verify-account",
      summary: "sandbox call",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, externalReference: "stripe:sandbox:pi_sandbox_test_123" });
    vi.unstubAllGlobals();
  });

  it("calls the Stripe Identity sandbox API with a secret test key", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const url = String(_url);
      const body = String(init?.body ?? "");
      expect(url).toBe("https://api.stripe.com/v1/identity/verification_sessions");
      expect(body).toContain("type=document");
      expect(body).toContain("metadata%5Ballbot_request_id%5D=business_test_identity");
      return new Response(
        JSON.stringify({ id: "vs_sandbox_test_123", object: "identity.verification_session" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const identityConfig = {
      ...validConfig("identity-primary"),
      kind: "identity",
      credentials: {
        app_id: "app_test",
        api_key: "sk_test_identity_placeholder",
        webhook_secret: "whsec_test",
      },
    };
    const file = await writeCredentialFile({ providers: [identityConfig] });
    const loaded = await reloadBusinessProviderCredentials({ filePath: file });
    expect(loaded.ok).toBe(true);
    const adapter = resolveBusinessProviderAdapter("credential-file:identity-primary", "identity");
    const outcome = await adapter?.execute({
      requestId: "business_test_identity",
      kind: "identity",
      operation: "verify-identity",
      summary: "sandbox KYC call",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, externalReference: "stripe:sandbox:vs_sandbox_test_123" });
    vi.unstubAllGlobals();
  });

  it("calls the Stripe sandbox API with a provider-issued OAuth token", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(String(_url)).toBe("https://api.stripe.com/v1/payment_intents");
      expect(headers.get("authorization")).toBe("Bearer oak_test_sandbox_token_1234567890");
      expect(headers.get("stripe-context")).toBe("acct_oauth_sandbox_123456");
      expect(headers.get("stripe-livemode")).toBe("false");
      return new Response(JSON.stringify({ id: "pi_oauth_test_123", object: "payment_intent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = await writeCredentialFile({
      providers: [
        {
          ...validConfig(),
          credentials: {
            merchant_id: "acct_oauth_sandbox_123456",
            api_key: "oak_test_sandbox_token_1234567890",
            webhook_secret: "whsec_oauth_sandbox_123456",
            refresh_token: "oart_oauth_refresh_1234567890",
            token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      ],
    });
    const loaded = await reloadBusinessProviderCredentials({ filePath: file });
    expect(loaded.ok).toBe(true);
    const adapter = resolveBusinessProviderAdapter("credential-file:payment-primary", "payment");
    const outcome = await adapter?.execute({
      requestId: "business_test_oauth",
      kind: "payment",
      operation: "verify-account",
      summary: "sandbox OAuth call",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      ok: true,
      externalReference: "stripe:sandbox:pi_oauth_test_123",
    });
    vi.unstubAllGlobals();
  });

  it("refreshes an expired sandbox OAuth token before dispatch", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://access.stripe.com/stripecli/oauth2/token") {
        calls.push("refresh");
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        expect(String(init?.body)).toContain("client_id=oacli_V18aOD6v0hs9CU");
        return new Response(
          JSON.stringify({
            access_token: "oak_test_refreshed_token_1234567890",
            refresh_token: "oart_rotated_refresh_1234567890",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      calls.push("dispatch");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        "Bearer oak_test_refreshed_token_1234567890",
      );
      return new Response(JSON.stringify({ id: "pi_oauth_refreshed_123", object: "payment_intent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = await writeCredentialFile({
      providers: [
        {
          ...validConfig(),
          credentials: {
            merchant_id: "acct_oauth_sandbox_123456",
            api_key: "oak_test_expired_token_1234567890",
            webhook_secret: "whsec_oauth_sandbox_123456",
            refresh_token: "oart_oauth_refresh_1234567890",
            token_expires_at: new Date(Date.now() - 1_000).toISOString(),
            credential_type: "oauth_sandbox",
          },
        },
        {
          ...validConfig("identity-primary"),
          kind: "identity",
          credentials: {
            app_id: "acct_oauth_sandbox_123456",
            api_key: "oak_test_expired_token_1234567890",
            webhook_secret: "whsec_oauth_sandbox_123456",
            refresh_token: "oart_oauth_refresh_1234567890",
            token_expires_at: new Date(Date.now() - 1_000).toISOString(),
            credential_type: "oauth_sandbox",
          },
        },
      ],
    });
    const loaded = await reloadBusinessProviderCredentials({ filePath: file });
    expect(loaded.ok).toBe(true);
    const adapter = resolveBusinessProviderAdapter("credential-file:payment-primary", "payment");
    const outcome = await adapter?.execute({
      requestId: "business_test_oauth_refresh",
      kind: "payment",
      operation: "verify-account",
      summary: "expired OAuth token refresh",
    });
    expect(calls).toEqual(["refresh", "dispatch"]);
    expect(outcome).toEqual({
      ok: true,
      externalReference: "stripe:sandbox:pi_oauth_refreshed_123",
    });
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as {
      providers: Array<{ credentials: Record<string, unknown> }>;
    };
    expect(persisted.providers[0]?.credentials.api_key).toBe(
      "oak_test_refreshed_token_1234567890",
    );
    expect(persisted.providers[0]?.credentials.refresh_token).toBe(
      "oart_rotated_refresh_1234567890",
    );
    expect(persisted.providers[1]?.credentials.api_key).toBe(
      "oak_test_refreshed_token_1234567890",
    );
    expect(persisted.providers[1]?.credentials.refresh_token).toBe(
      "oart_rotated_refresh_1234567890",
    );
    vi.unstubAllGlobals();
  });

  it("refuses live Stripe keys before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = await writeCredentialFile({
      providers: [
        {
          ...validConfig(),
          mode: "live",
          credentials: { ...validConfig().credentials, api_key: "sk_live_placeholder" },
        },
      ],
    });
    const loaded = await reloadBusinessProviderCredentials({ filePath: file });
    expect(loaded.ok).toBe(true);
    const adapter = resolveBusinessProviderAdapter("credential-file:payment-primary", "payment");
    const outcome = await adapter?.execute({
      requestId: "business_test_live_blocked",
      kind: "payment",
      operation: "verify-account",
      summary: "must not call live API",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome?.ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("clears stale managed adapters after an invalid credential file", async () => {
    const file = await writeCredentialFile({ providers: [validConfig()] });
    const first = await reloadBusinessProviderCredentials({ filePath: file });
    expect(first.ok).toBe(true);
    expect(listBusinessProviderAdapters()).toHaveLength(1);

    const invalid = await writeCredentialFile({
      providers: [{ ...validConfig(), provider: "stripe_or_alipay" }],
    });
    const second = await reloadBusinessProviderCredentials({ filePath: invalid });
    expect(second.ok).toBe(false);
    expect(listBusinessProviderAdapters()).toEqual([]);
  });
});
