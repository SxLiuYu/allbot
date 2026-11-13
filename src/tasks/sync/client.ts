import type { SyncTask } from "./types.js";

export type SyncGatewayClient = {
  listTasks(since?: number): Promise<SyncTask[]>;
  createTask(task: SyncTask, idempotencyKey: string): Promise<SyncTask>;
  appendEvent(event: {
    taskId: string;
    deviceId: string;
    idempotencyKey: string;
    type: string;
    fromVersion?: number;
    payload?: Record<string, unknown>;
    at: number;
  }): Promise<void>;
};

export class SyncGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SyncGatewayError";
  }
}

export function createHttpSyncGatewayClient(options: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SyncGatewayClient {
  const origin = options.baseUrl.replace(/\/+$/, "");
  if (
    !origin.startsWith("https://") &&
    !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)
  ) {
    throw new Error("sync gateway requires HTTPS (loopback HTTP is test/local only)");
  }
  const fetcher = options.fetchImpl ?? fetch;
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await fetcher(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    if (!response.ok) throw new SyncGatewayError(response.status, text.slice(0, 500));
    return (text ? JSON.parse(text) : {}) as T;
  }
  return {
    async listTasks(since) {
      const result = await request<{ tasks: SyncTask[] }>(
        "GET",
        `/sync/v1/tasks${since === undefined ? "" : `?since=${since}`}`,
      );
      return result.tasks;
    },
    async createTask(task, idempotencyKey) {
      return await request<SyncTask>("POST", "/sync/v1/tasks", task, idempotencyKey);
    },
    async appendEvent(event) {
      await request("POST", `/sync/v1/tasks/${encodeURIComponent(event.taskId)}/events`, event);
    },
  };
}
