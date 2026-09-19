import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunEnvelope } from "../src/harness/contracts.js";
import { loadHarnessRun, requestHarnessRunRetry, saveHarnessRun } from "../src/harness/run-store.js";

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
    state: {
      version: 1,
      stage: "PREFLIGHT",
      status: "BLOCKED_USER",
      completedStages: [],
      skippedStages: [],
      updatedAt: "2026-09-07T00:00:01.000Z",
      reason: "fixture",
    },
    evidence: [],
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

test("legacy preflight-only run is normalized with runtime state", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "iseol-runs-legacy-"));
  const legacy = envelope("C:/repo");
  delete legacy.state;
  delete legacy.evidence;
  await mkdir(join(storeRoot, "run-001"), { recursive: true });
  await writeFile(
    join(storeRoot, "run-001", "run.json"),
    JSON.stringify(legacy, null, 2),
    "utf8",
  );

  const loaded = await loadHarnessRun(storeRoot, "run-001");
  assert.ok(loaded);
  assert.equal(loaded.state?.stage, "PREFLIGHT");
  assert.equal(loaded.state?.status, "BLOCKED_USER");
  assert.deepEqual(loaded.evidence, []);
});

test("FAILED_FINAL accepts one explicit idempotent same-run retry and preserves history", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "iseol-runs-retry-"));
  const expected = envelope("C:/repo");
  expected.request.mode = "idea-lab";
  expected.state = { ...expected.state!, stage: "IMPLEMENT", status: "FAILED_FINAL", completedStages: ["PREFLIGHT", "CONTEXT", "ANALYZE", "PLAN"], reason: "patch validation invalid" };
  await saveHarnessRun(storeRoot, expected);

  const first = await requestHarnessRunRetry(storeRoot, "run-001", { retryReason: "operator-request", actor: "operator", requestedAt: "2026-09-19T03:00:00.000Z" });
  assert.equal(first.status, "accepted");
  if (first.status !== "accepted") return;
  assert.equal(first.run.request.runId, "run-001");
  assert.equal(first.run.state.stage, "IMPLEMENT");
  assert.equal(first.run.state.status, "READY");
  assert.equal(first.run.retry?.cycle, 1);
  assert.equal(first.run.retry?.status, "active");
  assert.equal(first.run.retry?.requestedFromState, "FAILED_FINAL");

  const duplicate = await requestHarnessRunRetry(storeRoot, "run-001", { retryReason: "operator-request", actor: "operator", requestedAt: "2026-09-19T03:00:01.000Z" });
  assert.equal(duplicate.status, "already-active");
  const loaded = await loadHarnessRun(storeRoot, "run-001");
  assert.equal(loaded?.request.runId, "run-001");
  assert.equal(loaded?.retry?.cycle, 1);
  assert.equal(loaded?.state.reason, "patch validation invalid");
});

test("same-run retry is rejected for non-terminal runs", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "iseol-runs-retry-not-allowed-"));
  await saveHarnessRun(storeRoot, envelope("C:/repo"));
  const result = await requestHarnessRunRetry(storeRoot, "run-001", { retryReason: "operator-request", actor: "operator", requestedAt: "2026-09-19T03:00:00.000Z" });
  assert.deepEqual(result, { status: "not-allowed", reason: "Run is not terminal FAILED_FINAL" });
});
