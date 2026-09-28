import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createMemoryService } from "../src/memory/service.js";

const at = "2026-09-25T12:00:00.000Z";

function principal(userId: string): Principal {
  return { userId, sessionId: `${userId}-session`, roles: ["user"] };
}

test("private memories persist and remain scoped to the owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-private-memory-"));
  const service = createMemoryService(root, { now: () => at });
  const memory = await service.appendPrivateMemory(principal("user-a"), {
    kind: "learning-note",
    content: "useEffect dependencies need deliberate review",
    source: "learning-session-1",
  });

  const restarted = createMemoryService(root, { now: () => at });
  assert.deepEqual(await restarted.listPrivateMemories(principal("user-a"), {}), [memory]);
  assert.deepEqual(await restarted.listPrivateMemories(principal("user-b"), {}), []);
  assert.match(await readFile(join(root, "users", "user-a", "memories", `${memory.id}.json`), "utf8"), /useEffect/);
});

test("memory deletion is owner-bound and unknown records are not exposed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-private-memory-delete-"));
  const service = createMemoryService(root, { now: () => at });
  const memory = await service.appendPrivateMemory(principal("user-a"), { kind: "note", content: "private" });
  assert.equal(await service.deletePrivateMemory(principal("user-b"), memory.id), false);
  assert.equal((await service.listPrivateMemories(principal("user-a"), {})).length, 1);
  assert.equal(await service.deletePrivateMemory(principal("user-a"), memory.id), true);
  assert.deepEqual(await service.listPrivateMemories(principal("user-a"), {}), []);
});

test("memory edits remain owner-bound and survive a service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-private-memory-update-"));
  const service = createMemoryService(root, { now: () => at });
  const memory = await service.appendPrivateMemory(principal("user-a"), { kind: "note", content: "old content", source: "old-source" });

  assert.equal(await service.updatePrivateMemory(principal("user-b"), memory.id, { content: "foreign edit" }), null);
  const updated = await service.updatePrivateMemory(principal("user-a"), memory.id, { kind: "learning-note", content: "new content", source: null });
  assert.equal(updated?.kind, "learning-note");
  assert.equal(updated?.content, "new content");
  assert.equal(updated?.source, undefined);
  assert.equal(updated?.userId, "user-a");
  assert.deepEqual((await createMemoryService(root, { now: () => at }).listPrivateMemories(principal("user-a"), {}))[0], updated);
});
