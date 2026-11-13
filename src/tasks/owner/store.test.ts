import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerTaskStore } from "./store.js";
import { createOwnerTask } from "./transition.js";

const dirs: string[] = [];

function makeStorePath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-tasks-store-"));
  dirs.push(dir);
  return path.join(dir, "owner-tasks.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function input(store: ReturnType<typeof createOwnerTaskStore>, title: string) {
  return {
    store,
    ownerId: "ou_owner",
    routerSessionKey: "agent:main:main",
    title,
    goal: title,
    source: { kind: "user" as const },
    worker: { kind: "subagent" as const, runId: title, childSessionKey: `child:${title}` },
  };
}

describe("owner task store", () => {
  it("returns an empty store when the file does not exist", async () => {
    const store = createOwnerTaskStore({ filePath: makeStorePath() });
    expect(await store.read()).toEqual({ version: 1, tasks: [] });
  });

  it("recovers from a corrupt primary file using the backup", async () => {
    const filePath = makeStorePath();
    const store = createOwnerTaskStore({ filePath });
    await createOwnerTask(input(store, "first"));
    // Second write creates owner-tasks.json.bak from the first state.
    await createOwnerTask(input(store, "second"));
    writeFileSync(filePath, "{not json", "utf8");
    const recovered = await createOwnerTaskStore({ filePath }).read();
    expect(recovered.tasks.map((task) => task.title)).toEqual(["first"]);
  });

  it("does not lose concurrent writes", async () => {
    const store = createOwnerTaskStore({ filePath: makeStorePath() });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => createOwnerTask(input(store, `task-${index}`))),
    );
    const data = await store.read();
    expect(data.tasks).toHaveLength(20);
    expect(new Set(data.tasks.map((task) => task.taskId)).size).toBe(20);
  });

  it("allocates unique six-character shortIds", async () => {
    const store = createOwnerTaskStore({ filePath: makeStorePath() });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => createOwnerTask(input(store, `task-${index}`))),
    );
    const data = await store.read();
    const shortIds = data.tasks.map((task) => task.shortId);
    expect(shortIds.every((id) => typeof id === "string" && /^[a-z2-9]{6}$/.test(id!))).toBe(true);
    expect(new Set(shortIds).size).toBe(20);
  });

  it("lazily adds shortIds to historical records", async () => {
    const filePath = makeStorePath();
    const store = createOwnerTaskStore({ filePath });
    const legacy = await createOwnerTask(input(store, "legacy"));
    const data = await store.read();
    delete data.tasks[0]!.shortId;
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    const recovered = await createOwnerTaskStore({ filePath }).read();
    expect(recovered.tasks[0]?.taskId).toBe(legacy.taskId);
    expect(recovered.tasks[0]?.shortId).toMatch(/^[a-z2-9]{6}$/);
  });

  it("keeps the store shape versioned", async () => {
    const store = createOwnerTaskStore({ filePath: makeStorePath() });
    await createOwnerTask(input(store, "one"));
    expect((await store.read()).version).toBe(1);
  });
});
