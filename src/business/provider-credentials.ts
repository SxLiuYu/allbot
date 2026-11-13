import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listBusinessProviderAdapters,
  registerBusinessProviderAdapter,
  unregisterBusinessProviderAdapter,
  type BusinessProviderResult,
} from "./provider-registry.js";
import { BUSINESS_REQUEST_KINDS, type BusinessRequestKind } from "./types.js";

const KIND_SET = new Set<string>(BUSINESS_REQUEST_KINDS);
const MANAGED_ADAPTER_PREFIX = "credential-file:";
const STRIPE_SANDBOX_API = "https://api.stripe.com";
const STRIPE_OAUTH_TOKEN_URL = "https://access.stripe.com/stripecli/oauth2/token";
const STRIPE_OAUTH_CLIENT_ID = "oacli_V18aOD6v0hs9CU";
const STRIPE_OAUTH_REFRESH_SKEW_MS = 60_000;
const STRIPE_TIMEOUT_MS = 15_000;

let credentialPersistQueue: Promise<void> = Promise.resolve();

type StripeOAuthTokenState = {
  apiKey: string;
  refreshToken?: string;
  expiresAt?: string;
};

const stripeOAuthTokenCache = new Map<string, StripeOAuthTokenState>();

export type BusinessProviderCredentialConfig = {
  id: string;
  kind: BusinessRequestKind;
  provider: string;
  mode: "sandbox" | "live";
  credentials: Record<string, unknown>;
};

export type BusinessProviderCredentialFile = {
  providers: BusinessProviderCredentialConfig[];
};

export type ReloadBusinessProviderCredentialsResult = {
  ok: boolean;
  filePath: string;
  mode: number | null;
  registered: Array<{ id: string; kind: BusinessRequestKind }>;
  errors: string[];
};

type ProviderDispatchRequest = {
  requestId: string;
  kind: BusinessRequestKind;
  operation: string;
  summary: string;
};

export function resolveBusinessProviderCredentialPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.ALLBOT_BUSINESS_PROVIDER_CREDENTIALS?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), "files", "allbot-provider-credentials.json");
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string | undefined {
  const raw = value[key];
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  errors.push(`${label}.${key} is required`);
  return undefined;
}

function validateProviderConfig(
  raw: unknown,
  index: number,
): { config?: BusinessProviderCredentialConfig; errors: string[] } {
  const label = `providers[${index}]`;
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { errors: [`${label} must be an object`] };
  }
  const value = raw as Record<string, unknown>;
  const rawId = readRequiredString(value, "id", label, errors);
  const id = rawId
    ? rawId.startsWith(MANAGED_ADAPTER_PREFIX)
      ? rawId
      : `${MANAGED_ADAPTER_PREFIX}${rawId}`
    : undefined;
  const kind = value.kind;
  const provider = readRequiredString(value, "provider", label, errors);
  const mode = value.mode === "live" ? "live" : "sandbox";
  if (typeof kind !== "string" || !KIND_SET.has(kind)) {
    errors.push(`${label}.kind must be payment or identity`);
  }
  if (typeof value.credentials !== "object" || value.credentials === null) {
    errors.push(`${label}.credentials must be an object`);
  }
  const credentials = (value.credentials ?? {}) as Record<string, unknown>;
  if (typeof provider === "string" && /stripe_or_|kyc_provider_name|example/i.test(provider)) {
    errors.push(`${label}.provider must name a real provider`);
  }
  const requiredCredentialKeys =
    kind === "payment"
      ? ["merchant_id", "api_key", "webhook_secret"]
      : ["app_id", "api_key", "webhook_secret"];
  for (const key of requiredCredentialKeys) {
    if (typeof credentials[key] !== "string" || !String(credentials[key]).trim()) {
      errors.push(`${label}.credentials.${key} is required`);
    }
  }
  for (const [key, secret] of Object.entries(credentials)) {
    if (secret === null || secret === "") {
      errors.push(`${label}.credentials.${key} must be filled`);
    }
  }
  if (errors.length > 0 || !id || typeof kind !== "string" || !KIND_SET.has(kind) || !provider) {
    return { errors };
  }
  return {
    config: {
      id,
      kind: kind as BusinessRequestKind,
      provider,
      mode,
      credentials,
    },
    errors,
  };
}

function parseCredentialFile(raw: string): {
  configs: BusinessProviderCredentialConfig[];
  errors: string[];
} {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { configs: [], errors: ["credential file is not valid JSON"] };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { providers?: unknown }).providers)) {
    return { configs: [], errors: ["credential file must contain a providers array"] };
  }
  const providers = (parsed as { providers: unknown[] }).providers;
  const seen = new Set<string>();
  const configs: BusinessProviderCredentialConfig[] = [];
  providers.forEach((entry, index) => {
    const validated = validateProviderConfig(entry, index);
    errors.push(...validated.errors);
    if (validated.config) {
      if (seen.has(validated.config.id)) {
        errors.push(`providers[${index}].id is duplicated`);
        return;
      }
      seen.add(validated.config.id);
      configs.push(validated.config);
    }
  });
  if (configs.length === 0 && errors.length === 0) {
    errors.push("credential file contains no usable providers");
  }
  return { configs, errors };
}

function stripeAccountId(config: BusinessProviderCredentialConfig): string | undefined {
  const value =
    config.kind === "payment"
      ? config.credentials.merchant_id
      : config.credentials.app_id;
  return typeof value === "string" && value.startsWith("acct_") ? value : undefined;
}

function isStripeOAuthConfig(config: BusinessProviderCredentialConfig): boolean {
  const apiKey = config.credentials.api_key;
  return (
    config.provider === "stripe" &&
    config.mode === "sandbox" &&
    typeof apiKey === "string" &&
    apiKey.startsWith("oak_") &&
    Boolean(stripeAccountId(config))
  );
}

function stripeOAuthState(
  config: BusinessProviderCredentialConfig,
): StripeOAuthTokenState | undefined {
  if (!isStripeOAuthConfig(config)) {
    return undefined;
  }
  const accountId = stripeAccountId(config);
  if (!accountId) {
    return undefined;
  }
  const cached = stripeOAuthTokenCache.get(accountId);
  if (cached) {
    return cached;
  }
  const state: StripeOAuthTokenState = {
    apiKey: String(config.credentials.api_key),
    ...(typeof config.credentials.refresh_token === "string"
      ? { refreshToken: config.credentials.refresh_token }
      : {}),
    ...(typeof config.credentials.token_expires_at === "string"
      ? { expiresAt: config.credentials.token_expires_at }
      : {}),
  };
  stripeOAuthTokenCache.set(accountId, state);
  return state;
}

function isStripeSandboxConfig(config: BusinessProviderCredentialConfig): boolean {
  if (config.provider !== "stripe" || config.mode !== "sandbox") {
    return false;
  }
  const apiKey = config.credentials.api_key;
  if (typeof apiKey !== "string") {
    return false;
  }
  return /^(sk|rk)_test_/.test(apiKey) || isStripeOAuthConfig(config);
}

function stripeAuthHeaders(config: BusinessProviderCredentialConfig): Record<string, string> {
  const apiKey = String(config.credentials.api_key);
  if (apiKey.startsWith("oak_")) {
    const accountId = stripeAccountId(config);
    const state = stripeOAuthState(config);
    return {
      authorization: `Bearer ${state?.apiKey ?? apiKey}`,
      ...(accountId ? { "stripe-context": accountId } : {}),
      "stripe-livemode": "false",
    };
  }
  return { authorization: `Basic ${btoa(`${apiKey}:`)}` };
}

function stripeOAuthNeedsRefresh(config: BusinessProviderCredentialConfig): boolean {
  if (!isStripeOAuthConfig(config)) {
    return false;
  }
  const expiresAt = stripeOAuthState(config)?.expiresAt;
  if (typeof expiresAt !== "string") {
    return false;
  }
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed - Date.now() <= STRIPE_OAUTH_REFRESH_SKEW_MS;
}

async function persistUpdatedCredential(
  config: BusinessProviderCredentialConfig,
  filePath: string,
): Promise<void> {
  const rawId = config.id.startsWith(MANAGED_ADAPTER_PREFIX)
    ? config.id.slice(MANAGED_ADAPTER_PREFIX.length)
    : config.id;
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as { providers?: unknown };
  if (!Array.isArray(parsed.providers)) {
    return;
  }
  const accountId = stripeAccountId(config);
  let changed = false;
  for (const entry of parsed.providers) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const credentials = record.credentials;
    if (!credentials || typeof credentials !== "object") {
      continue;
    }
    const mutable = credentials as Record<string, unknown>;
    const entryAccount =
      record.kind === "payment" ? mutable.merchant_id : mutable.app_id;
    const sameOAuthAccount =
      Boolean(accountId) &&
      mutable.credential_type === "oauth_sandbox" &&
      entryAccount === accountId;
    if (!sameOAuthAccount && record.id !== rawId) {
      continue;
    }
    mutable.api_key = config.credentials.api_key;
    if (typeof config.credentials.refresh_token === "string") {
      mutable.refresh_token = config.credentials.refresh_token;
    }
    if (typeof config.credentials.token_expires_at === "string") {
      mutable.token_expires_at = config.credentials.token_expires_at;
    }
    changed = true;
  }
  if (!changed) {
    return;
  }
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function persistUpdatedCredentialQueued(
  config: BusinessProviderCredentialConfig,
  filePath: string,
): Promise<void> {
  credentialPersistQueue = credentialPersistQueue.then(
    () => persistUpdatedCredential(config, filePath),
    () => persistUpdatedCredential(config, filePath),
  );
  return credentialPersistQueue;
}

async function refreshStripeOAuthToken(
  config: BusinessProviderCredentialConfig,
  filePath?: string,
): Promise<boolean> {
  const state = stripeOAuthState(config);
  const refreshToken = state?.refreshToken ?? config.credentials.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken.startsWith("oart_")) {
    return false;
  }
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", STRIPE_OAUTH_CLIENT_ID);
  let response: Response;
  try {
    response = await fetch(STRIPE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!response.ok) {
    return false;
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return false;
  }
  const record = (payload ?? {}) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  const accessToken =
    typeof record.access_token === "string" ? record.access_token : undefined;
  if (!accessToken || !accessToken.startsWith("oak_")) {
    return false;
  }
  config.credentials.api_key = accessToken;
  if (state) {
    state.apiKey = accessToken;
  }
  if (typeof record.refresh_token === "string" && record.refresh_token) {
    config.credentials.refresh_token = record.refresh_token;
    if (state) {
      state.refreshToken = record.refresh_token;
    }
  }
  if (typeof record.expires_in === "number" && record.expires_in > 0) {
    const expiresAt = new Date(Date.now() + record.expires_in * 1000).toISOString();
    config.credentials.token_expires_at = expiresAt;
    if (state) {
      state.expiresAt = expiresAt;
    }
  }
  if (filePath) {
    try {
      await persistUpdatedCredentialQueued(config, filePath);
    } catch {
      // The refreshed token remains valid in memory even if write-back fails.
    }
  }
  return true;
}

async function sendStripeSandboxRequest(
  endpoint: string,
  body: URLSearchParams,
  config: BusinessProviderCredentialConfig,
  request: ProviderDispatchRequest,
): Promise<Response> {
  return await fetch(`${STRIPE_SANDBOX_API}${endpoint}`, {
    method: "POST",
    headers: {
      ...stripeAuthHeaders(config),
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": request.requestId,
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });
}

/**
 * Real Stripe test-mode API call for a human-confirmed business request.
 * A secret/restricted test key or a provider-issued sandbox OAuth token
 * creates an uncaptured PaymentIntent or an Identity VerificationSession.
 * The returned provider object id is the external reference. Publishable
 * and live keys are refused before any network request is made.
 */
async function executeStripeSandboxAdapter(
  config: BusinessProviderCredentialConfig,
  request: ProviderDispatchRequest,
  credentialFilePath?: string,
): Promise<BusinessProviderResult> {
  if (!isStripeSandboxConfig(config)) {
    return {
      ok: false,
      error:
        `Provider ${config.provider} is not configured with a Stripe sandbox test key; ` +
        `live calls are disabled for request ${request.requestId}.`,
    };
  }
  const body = new URLSearchParams();
  let endpoint: string;
  if (config.kind === "payment") {
    endpoint = "/v1/payment_intents";
    body.set("metadata[allbot_request_id]", request.requestId);
    body.set("metadata[allbot_operation]", request.operation);
    body.set("amount", "100");
    body.set("currency", "usd");
    body.set("description", "allbot sandbox boundary verification");
  } else {
    endpoint = "/v1/identity/verification_sessions";
    body.set("metadata[allbot_request_id]", request.requestId);
    body.set("metadata[allbot_operation]", request.operation);
    body.set("type", "document");
  }
  if (stripeOAuthNeedsRefresh(config)) {
    await refreshStripeOAuthToken(config, credentialFilePath);
  }
  let response: Response;
  try {
    response = await sendStripeSandboxRequest(endpoint, body, config, request);
    if (response.status === 401 && isStripeOAuthConfig(config)) {
      if (await refreshStripeOAuthToken(config, credentialFilePath)) {
        response = await sendStripeSandboxRequest(endpoint, body, config, request);
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `Stripe sandbox ${config.kind} request failed for ${request.requestId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return {
      ok: false,
      error: `Stripe sandbox ${config.kind} returned a non-JSON response (HTTP ${response.status}) for ${request.requestId}.`,
    };
  }
  const record = (payload ?? {}) as { id?: unknown; error?: { message?: unknown } };
  const externalId = typeof record.id === "string" ? record.id : undefined;
  if (!response.ok || !externalId) {
    const message =
      record.error && typeof record.error.message === "string"
        ? record.error.message
        : `HTTP ${response.status}`;
    return {
      ok: false,
      error: `Stripe sandbox ${config.kind} call failed for ${request.requestId}: ${message} (HTTP ${response.status}).`,
    };
  }
  return { ok: true, externalReference: `stripe:sandbox:${externalId}` };
}

/**
 * Registers explicitly configured credential-file adapters. Stripe sandbox
 * adapters make a real test-mode API call and return the provider object id;
 * live keys and other providers are refused. Missing or invalid credentials
 * clear previously registered credential-file adapters.
 */
export async function reloadBusinessProviderCredentials(options: {
  filePath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ReloadBusinessProviderCredentialsResult> {
  stripeOAuthTokenCache.clear();
  const filePath = options.filePath ?? resolveBusinessProviderCredentialPath(options.env);
  const result: ReloadBusinessProviderCredentialsResult = {
    ok: false,
    filePath,
    mode: null,
    registered: [],
    errors: [],
  };
  let stat;
  let raw;
  try {
    [stat, raw] = await Promise.all([fs.stat(filePath), fs.readFile(filePath, "utf8")]);
  } catch (err) {
    clearManagedAdapters();
    result.errors.push(`credential file unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  result.mode = stat.mode & 0o777;
  if (process.platform !== "win32" && result.mode !== 0o600) {
    clearManagedAdapters();
    result.errors.push(`credential file mode must be 0600, found ${result.mode.toString(8)}`);
    return result;
  }
  const parsed = parseCredentialFile(raw);
  result.errors.push(...parsed.errors);
  if (parsed.errors.length > 0) {
    clearManagedAdapters();
    return result;
  }
  clearManagedAdapters();
  for (const config of parsed.configs) {
    const oauthAccountId = isStripeOAuthConfig(config)
      ? stripeAccountId(config)
      : undefined;
    if (oauthAccountId) {
      stripeOAuthTokenCache.set(oauthAccountId, {
        apiKey: String(config.credentials.api_key),
        ...(typeof config.credentials.refresh_token === "string"
          ? { refreshToken: config.credentials.refresh_token }
          : {}),
        ...(typeof config.credentials.token_expires_at === "string"
          ? { expiresAt: config.credentials.token_expires_at }
          : {}),
      });
    }
    const adapterId = config.id;
    registerBusinessProviderAdapter({
      id: adapterId,
      kind: config.kind,
      execute: async (request): Promise<BusinessProviderResult> => {
        if (config.provider !== "stripe") {
          return {
            ok: false,
            error: `Provider ${config.provider} has no installed external ${config.kind} API adapter for request ${request.requestId}.`,
          };
        }
        return await executeStripeSandboxAdapter(config, request, filePath);
      },
    });
    result.registered.push({ id: adapterId, kind: config.kind });
  }
  result.ok = true;
  return result;
}

function listManagedAdapterIds(): string[] {
  return listBusinessProviderAdapters()
    .map(({ id }) => id)
    .filter((id) => id.startsWith(MANAGED_ADAPTER_PREFIX));
}

function clearManagedAdapters(): void {
  for (const adapterId of listManagedAdapterIds()) {
    unregisterBusinessProviderAdapter(adapterId);
  }
}
