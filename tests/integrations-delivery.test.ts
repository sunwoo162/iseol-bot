import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationService } from "../src/integrations/service.js";
import { withDurableIntegrationDeliveryLock } from "../src/integrations/delivery-lock.js";
import type { IntegrationDeliveryInput, IntegrationProvider } from "../src/integrations/contracts.js";
import type { Principal } from "../src/identity/contracts.js";

function principal(userId: string): Principal {
  return { userId, sessionId: `session-${userId}`, roles: ["user"] };
}

function input(provider: IntegrationProvider = "github"): IntegrationDeliveryInput {
  return {
    provider,
    sourceType: "project.lifecycle",
    sourceId: "project-1",
    eventType: "project.completed",
    eventVersion: 1,
    payload: { projectId: "project-1", actorType: "system" },
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "iseol-integration-delivery-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("integration delivery is owner-scoped and enqueue is idempotent", async () => {
  await withRoot(async (root) => {
    const service = createIntegrationService(root, { now: () => "2026-09-28T00:00:00.000Z" });
    const first = await service.enqueueDelivery(principal("user-a"), input());
    const replay = await service.enqueueDelivery(principal("user-a"), input());

    assert.equal(first.id, replay.id);
    assert.equal(first.state, "queued");
    assert.equal((await service.listDeliveries(principal("user-a"))).length, 1);
    assert.equal((await service.listDeliveries(principal("user-b"))).length, 0);
    await assert.rejects(() => service.dispatchDelivery(principal("user-b"), first.id), /Delivery not found/);
  });
});

test("configured opt-in adapter delivers once and preserves the external reference", async () => {
  await withRoot(async (root) => {
    let calls = 0;
    const service = createIntegrationService(root, {
      now: () => "2026-09-28T00:00:00.000Z",
      isOptedIn: () => true,
      adapters: { github: { deliver: async () => { calls += 1; return { externalRef: "github-event-1" }; } } },
    });
    const queued = await service.enqueueDelivery(principal("user-a"), input());
    const delivered = await service.dispatchDelivery(principal("user-a"), queued.id);
    const replay = await service.dispatchDelivery(principal("user-a"), queued.id);

    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.externalRef, "github-event-1");
    assert.equal(replay.id, delivered.id);
    assert.equal(calls, 1);
  });
});

test("concurrent dispatches attempt one provider delivery and converge on one durable result", async () => {
  await withRoot(async (root) => {
    let calls = 0;
    let release!: () => void;
    const adapterReady = new Promise<void>((resolve) => { release = resolve; });
    const service = createIntegrationService(root, {
      isOptedIn: () => true,
      adapters: { github: { deliver: async () => { calls += 1; await adapterReady; return { externalRef: "github-event-concurrent" }; } } },
    });
    const queued = await service.enqueueDelivery(principal("user-a"), input());
    const firstPromise = service.dispatchDelivery(principal("user-a"), queued.id);
    for (let attempt = 0; attempt < 100 && calls === 0; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const secondPromise = service.dispatchDelivery(principal("user-a"), queued.id);
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(calls, 1);
    assert.equal(first.state, "delivered");
    assert.equal(second.state, "delivered");
    assert.equal(first.externalRef, "github-event-concurrent");
    assert.equal(second.externalRef, "github-event-concurrent");
    assert.equal((await service.listDeliveries(principal("user-a")))[0]?.attempts, 1);
  });
});

test("delivery dispatch waits for the durable cross-service lock", async () => {
  await withRoot(async (root) => {
    const service = createIntegrationService(root, {
      isOptedIn: () => false,
    });
    const queued = await service.enqueueDelivery(principal("user-a"), input());
    let release!: () => void;
    let acquired!: () => void;
    const holderAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withDurableIntegrationDeliveryLock(root, "user-a", queued.id, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    }, { waitForMs: 0 });
    await holderAcquired;

    const dispatch = service.dispatchDelivery(principal("user-a"), queued.id);
    assert.equal(await Promise.race([
      dispatch.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 40)),
    ]), false);
    release();
    await Promise.all([holder, dispatch]);
  });
});

test("concurrent dispatches across service instances call the adapter once", async () => {
  await withRoot(async (root) => {
    let calls = 0;
    const adapter = { deliver: async () => { calls += 1; return { externalRef: "github-cross-service" }; } };
    const first = createIntegrationService(root, { isOptedIn: () => true, adapters: { github: adapter } });
    const second = createIntegrationService(root, { isOptedIn: () => true, adapters: { github: adapter } });
    const queued = await first.enqueueDelivery(principal("user-a"), input());
    const [left, right] = await Promise.all([
      first.dispatchDelivery(principal("user-a"), queued.id),
      second.dispatchDelivery(principal("user-a"), queued.id),
    ]);
    assert.equal(calls, 1);
    assert.equal(left.state, "delivered");
    assert.equal(right.state, "delivered");
    assert.equal((await first.listDeliveries(principal("user-a")))[0]?.attempts, 1);
  });
});

test("concurrent enqueue identity conflicts have one durable winner", async () => {
  await withRoot(async (root) => {
    const first = createIntegrationService(root);
    const second = createIntegrationService(root);
    const results = await Promise.allSettled([
      first.enqueueDelivery(principal("user-a"), input()),
      second.enqueueDelivery(principal("user-a"), { ...input(), payload: { projectId: "other" } }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && /identity conflict/i.test(String(result.reason))).length, 1);
    assert.equal((await first.listDeliveries(principal("user-a"))).length, 1);
  });
});

test("disabled consent blocks delivery without calling an adapter", async () => {
  await withRoot(async (root) => {
    let calls = 0;
    const service = createIntegrationService(root, {
      isOptedIn: () => false,
      adapters: { discord: { deliver: async () => { calls += 1; return { externalRef: "should-not-send" }; } } },
    });
    const queued = await service.enqueueDelivery(principal("user-a"), input("discord"));
    const blocked = await service.dispatchDelivery(principal("user-a"), queued.id);

    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.reason, "user-opt-in-required");
    assert.equal(calls, 0);
  });
});

test("missing adapter is durable not-configured state", async () => {
  await withRoot(async (root) => {
    const service = createIntegrationService(root, { isOptedIn: () => true });
    const queued = await service.enqueueDelivery(principal("user-a"), input("calendar"));
    const result = await service.dispatchDelivery(principal("user-a"), queued.id);

    assert.equal(result.state, "not-configured");
    assert.equal(result.reason, "provider-adapter-unconfigured");
  });
});

test("adapter failure becomes UNKNOWN and the same delivery is never retried", async () => {
  await withRoot(async (root) => {
    let calls = 0;
    const service = createIntegrationService(root, {
      isOptedIn: () => true,
      adapters: { github: { deliver: async () => { calls += 1; throw new Error("provider timeout"); } } },
    });
    const queued = await service.enqueueDelivery(principal("user-a"), input());
    const unknown = await service.dispatchDelivery(principal("user-a"), queued.id);
    const replay = await service.dispatchDelivery(principal("user-a"), queued.id);

    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.reason, "provider-error");
    assert.equal(replay.state, "unknown");
    assert.equal(calls, 1);
  });
});

test("conflicting source identity is rejected instead of overwriting a delivery", async () => {
  await withRoot(async (root) => {
    const service = createIntegrationService(root);
    await service.enqueueDelivery(principal("user-a"), input());
    await assert.rejects(
      () => service.enqueueDelivery(principal("user-a"), { ...input(), payload: { projectId: "other" } }),
      /Delivery identity conflict/,
    );
  });
});
