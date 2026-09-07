import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeHarnessSideEffect,
  loadHarnessSideEffect,
  reserveHarnessSideEffect,
} from "../src/harness/side-effect-ledger.js";

test("side effect reservation is idempotent while in progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-effects-"));
  const input = {
    runId: "run-001",
    key: "pull-request:owner/repo#feature",
    kind: "pull-request" as const,
    at: "2026-09-07T00:00:01.000Z",
  };

  const first = await reserveHarnessSideEffect(root, input);
  const second = await reserveHarnessSideEffect(root, {
    ...input,
    at: "2026-09-07T00:00:02.000Z",
  });

  assert.equal(first.outcome, "reserved");
  assert.equal(second.outcome, "in-progress");
  assert.equal(second.receipt.reservedAt, input.at);
});test("completed side effect receipt is reused on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-effects-"));
  const input = {
    runId: "run-001",
    key: "deployment:production:abc123",
    kind: "deployment" as const,
    at: "2026-09-07T00:00:01.000Z",
  };

  await reserveHarnessSideEffect(root, input);
  const completed = await completeHarnessSideEffect(root, {
    runId: input.runId,
    key: input.key,
    at: "2026-09-07T00:00:03.000Z",
    externalReference: "deploy-42",
  });
  const retry = await reserveHarnessSideEffect(root, {
    ...input,
    at: "2026-09-07T00:00:04.000Z",
  });

  assert.equal(completed.status, "completed");
  assert.equal(retry.outcome, "completed");
  assert.equal(retry.receipt.externalReference, "deploy-42");
  assert.deepEqual(await loadHarnessSideEffect(root, input.runId, input.key), completed);
});

test("side effect run ids cannot escape the ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-effects-"));
  await assert.rejects(
    reserveHarnessSideEffect(root, {
      runId: "../escape",
      key: "deployment:x",
      kind: "deployment",
      at: "2026-09-07T00:00:01.000Z",
    }),
    /Invalid Iseol Run id/,
  );
});