import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessCheckpoint, HarnessRunEvent, HarnessRunState } from "../src/harness/contracts.js";
import {
  appendHarnessRunEvent,
  loadHarnessRunEvents,
  loadLatestHarnessCheckpoint,
  saveHarnessCheckpoint,
} from "../src/harness/event-store.js";

const state: HarnessRunState = {
  version: 1,
  stage: "CONTEXT",
  status: "RUNNING",
  completedStages: ["PREFLIGHT"],
  skippedStages: [],
  updatedAt: "2026-09-07T00:00:01.000Z",
};

function event(id: string, at: string): HarnessRunEvent {
  return {
    version: 1,
    id,
    runId: "run-001",
    type: "status-changed",
    at,
    stage: "CONTEXT",
    status: "RUNNING",
    summary: id,
  };
}test("run events reload in append order", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-events-"));
  await appendHarnessRunEvent(root, event("event-1", "2026-09-07T00:00:01.000Z"));
  await appendHarnessRunEvent(root, event("event-2", "2026-09-07T00:00:02.000Z"));

  const events = await loadHarnessRunEvents(root, "run-001");
  assert.deepEqual(events.map((item) => item.id), ["event-1", "event-2"]);
});

test("latest checkpoint is selected by recorded time", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-checkpoints-"));
  const first: HarnessCheckpoint = {
    version: 1,
    id: "checkpoint-1",
    runId: "run-001",
    recordedAt: "2026-09-07T00:00:01.000Z",
    state,
    evidence: [],
  };
  const second: HarnessCheckpoint = {
    ...first,
    id: "checkpoint-2",
    recordedAt: "2026-09-07T00:00:02.000Z",
    state: { ...state, stage: "ANALYZE", updatedAt: "2026-09-07T00:00:02.000Z" },
  };

  await saveHarnessCheckpoint(root, first);
  await saveHarnessCheckpoint(root, second);
  assert.deepEqual(await loadLatestHarnessCheckpoint(root, "run-001"), second);
});

test("missing event and checkpoint stores are empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-events-empty-"));
  assert.deepEqual(await loadHarnessRunEvents(root, "run-001"), []);
  assert.equal(await loadLatestHarnessCheckpoint(root, "run-001"), null);
});