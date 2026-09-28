import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createPersonalWorldService } from "../src/personal-world/service.js";

const at = "2026-09-25T12:00:00.000Z";

function principal(userId: string): Principal {
  return { userId, sessionId: `${userId}-session`, roles: ["user"] };
}

test("personal world and character survive service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-personal-world-"));
  const service = createPersonalWorldService(root, { now: () => at });
  const saved = await service.updateWorld(principal("user-a"), {
    displayName: "Ari",
    handle: "ari_dev",
    character: "c",
    interests: ["AI/ML"],
    activities: ["learn", "project"],
  });
  const character = await service.updateCharacter(principal("user-a"), {
    character: "d",
    appearance: { outfit: "coral-jacket", accessory: "headphones" },
  });

  const restarted = createPersonalWorldService(root, { now: () => at });
  assert.deepEqual(await restarted.getWorld(principal("user-a")), { ...saved, character: "d", updatedAt: at });
  assert.deepEqual(await restarted.getCharacter(principal("user-a")), character);
  assert.match(await readFile(join(root, "users", "user-a", "world.json"), "utf8"), /ari_dev/);
});

test("personal world cannot be read or changed through another user's principal", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-personal-world-isolation-"));
  const service = createPersonalWorldService(root, { now: () => at });
  await service.updateWorld(principal("user-a"), {
    displayName: "Private A",
    handle: "private_a",
    character: "a",
    interests: [],
    activities: [],
  });

  const b = await service.getWorld(principal("user-b"));
  assert.notEqual(b.displayName, "Private A");
  await service.updateWorld(principal("user-b"), {
    displayName: "Private B",
    handle: "private_b",
    character: "b",
    interests: [],
    activities: [],
  });
  assert.equal((await service.getWorld(principal("user-a"))).displayName, "Private A");
});
