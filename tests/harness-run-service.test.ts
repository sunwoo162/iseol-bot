import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevelopmentRunRequest } from "../src/harness/contracts.js";
import { assertPreflightReady } from "../src/harness/preflight.js";
import { loadHarnessRun } from "../src/harness/run-store.js";
import { createDevelopmentRun } from "../src/harness/run-service.js";

async function fixture(withGlobal = true) {
  const root = await mkdtemp(join(tmpdir(), "iseol-run-service-"));
  const iseolRoot = join(root, "iseol");
  const targetRoot = join(root, "target");
  const storeRoot = join(root, "runs");
  await mkdir(join(iseolRoot, "docs"), { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  if (withGlobal) {
    await writeFile(join(iseolRoot, "docs", "HARNESS_ENGINEERING.md"), "global policy\n");
  }
  return { iseolRoot, targetRoot, storeRoot };
}

function request(targetRoot: string): DevelopmentRunRequest {
  return {
    version: 1,
    runId: "run-001",
    mode: "project-workspace",
    objective: "Implement profile editing",
    targetRoot,
  };
}

test("createDevelopmentRun preflights and persists a ready run", async () => {
  const { iseolRoot, targetRoot, storeRoot } = await fixture();
  const run = await createDevelopmentRun(request(targetRoot), {
    iseolRoot,
    storeRoot,
    loadedAt: "2026-09-07T00:00:00.000Z",
  });

  assert.equal(run.preflight.status, "ready");
  assert.doesNotThrow(() => assertPreflightReady(run.preflight));
  assert.deepEqual(await loadHarnessRun(storeRoot, "run-001"), run);
});

test("createDevelopmentRun persists blocked preflight for diagnosis", async () => {
  const { iseolRoot, targetRoot, storeRoot } = await fixture(false);
  const run = await createDevelopmentRun(request(targetRoot), { iseolRoot, storeRoot });

  assert.equal(run.preflight.status, "blocked");
  assert.throws(() => assertPreflightReady(run.preflight), /Development Run preflight is not ready/);
  assert.deepEqual(await loadHarnessRun(storeRoot, "run-001"), run);
});
