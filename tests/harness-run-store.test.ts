import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunEnvelope } from "../src/harness/contracts.js";
import { loadHarnessRun, saveHarnessRun } from "../src/harness/run-store.js";

function envelope(targetRoot: string): HarnessRunEnvelope {
  return {
    version: 1,
    request: {
      version: 1,
      runId: "run-001",
      mode: "project-workspace",
      objective: "Implement profile editing",
      targetRoot,
    },
    preflight: {
      version: 1,
      runId: "run-001",
      status: "blocked",
      reason: "fixture",
    },
    updatedAt: "2026-09-07T00:00:01.000Z",
  };
}

test("run store persists and reloads the exact envelope", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "iseol-runs-"));
  const expected = envelope("C:/repo");

  await saveHarnessRun(storeRoot, expected);

  assert.deepEqual(await loadHarnessRun(storeRoot, "run-001"), expected);
});

test("unknown run id returns null", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "iseol-runs-"));

  assert.equal(await loadHarnessRun(storeRoot, "run-missing"), null);
});

test("run ids cannot escape the run store", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "iseol-runs-"));
  const invalid = envelope("C:/repo");
  invalid.request.runId = "../escape";
  invalid.preflight.runId = "../escape";

  await assert.rejects(saveHarnessRun(storeRoot, invalid), /Invalid Iseol Run id/);
  await assert.rejects(loadHarnessRun(storeRoot, "../escape"), /Invalid Iseol Run id/);
});
