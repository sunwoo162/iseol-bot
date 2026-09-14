import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveIdeaLabCampaign } from "../src/idea-lab/campaign-store.js";
import { createIdeaLabRuntimeService } from "../src/idea-lab/runtime-service.js";

const campaign = (id: string, status: "generating" | "producing" | "complete" | "blocked" | "cancelled") => ({
  version: 1 as const, id, seed: "seed", constraints: [], targetReadyCount: 1, productionConcurrency: 3,
  proposalIds: [], productionIds: [], status, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
});

test("runtime collapses duplicate pending and active ids and runs FIFO with one worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea-lab-runtime-"));
  const calls: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createIdeaLabRuntimeService({ modelRoot: root, superviseCampaign: async (id) => {
    calls.push(id);
    if (id === "camp-a") await first;
  }});
  runtime.enqueue("camp-a"); runtime.enqueue("camp-a"); runtime.enqueue("camp-b");
  await new Promise((resolve) => setImmediate(resolve));
  runtime.enqueue("camp-a");
  assert.deepEqual(calls, ["camp-a"]);
  release();
  await runtime.idle();
  assert.deepEqual(calls, ["camp-a", "camp-b"]);
  await runtime.dispose();
});

test("runtime releases ids after success and rejection, with bounded error summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea-lab-runtime-"));
  const calls: string[] = []; const errors: Array<[string, string]> = [];
  const runtime = createIdeaLabRuntimeService({ modelRoot: root, onError: (id, summary) => errors.push([id, summary]), superviseCampaign: async (id) => {
    calls.push(id); if (id === "bad") throw new Error("prompt body secret-token C:/private/profile.json");
  }});
  runtime.enqueue("bad"); runtime.enqueue("good"); await runtime.idle();
  runtime.enqueue("bad"); await runtime.idle();
  assert.deepEqual(calls, ["bad", "good", "bad"]);
  assert.equal(errors.length, 2);
  assert.match(errors[0][1], /^Campaign supervision failed$/);
  assert.doesNotMatch(errors[0][1], /secret-token|profile|prompt/i);
  await runtime.dispose();
});

test("recover schedules only generating and producing campaigns", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea-lab-runtime-"));
  for (const [id, status] of [["generating", "generating"], ["producing", "producing"], ["complete", "complete"], ["blocked", "blocked"], ["cancelled", "cancelled"]] as const) {
    await saveIdeaLabCampaign(root, campaign(id, status));
  }
  const calls: string[] = [];
  const runtime = createIdeaLabRuntimeService({ modelRoot: root, superviseCampaign: async (id) => calls.push(id) });
  await runtime.recover();
  await runtime.idle();
  assert.deepEqual(calls, ["generating", "producing"]);
  await runtime.dispose();
});

test("dispose stops future enqueue and waits for current worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea-lab-runtime-"));
  let release!: () => void; const started = new Promise<void>((resolve) => { release = resolve; });
  let finished = false;
  const runtime = createIdeaLabRuntimeService({ modelRoot: root, superviseCampaign: async () => { await started; finished = true; } });
  runtime.enqueue("camp-a");
  await new Promise((resolve) => setImmediate(resolve));
  const disposed = runtime.dispose();
  runtime.enqueue("camp-b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false); release(); await disposed;
  assert.equal(finished, true);
});

test("runtime rejects unsupported scheduler concurrency", () => {
  assert.throws(
    () => createIdeaLabRuntimeService({
      modelRoot: "C:/model",
      superviseCampaign: async () => undefined,
      concurrency: 2 as never,
    }),
    /concurrency/i,
  );
});


test("fresh enqueue runs before pending recovery backlog", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea-lab-runtime-priority-"));
  await saveIdeaLabCampaign(root, campaign("recover-a", "generating"));
  await saveIdeaLabCampaign(root, campaign("recover-b", "generating"));
  const calls: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createIdeaLabRuntimeService({ modelRoot: root, superviseCampaign: async (id) => {
    calls.push(id);
    if (id === "recover-a") await first;
  }});
  await runtime.recover();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["recover-a"]);
  runtime.enqueue("fresh");
  release();
  await runtime.idle();
  assert.deepEqual(calls, ["recover-a", "fresh", "recover-b"]);
  await runtime.dispose();
});
