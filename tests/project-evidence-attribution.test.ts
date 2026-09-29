import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessEvidenceRecord } from "../src/harness/contracts.js";
import { selectProjectEvidence } from "../src/project-model/evidence-service.js";

const evidence = (id: string, projectId?: string, runId?: string): HarnessEvidenceRecord => ({
  version: 1,
  id,
  kind: "test",
  stage: "TEST",
  recordedAt: "2026-09-25T12:00:00.000Z",
  summary: id,
  ...(projectId ? { projectId } : {}),
  ...(runId ? { runId } : {}),
});

test("project evidence requires matching project and Run identity", () => {
  const selected = selectProjectEvidence({
    projectId: "project-a",
    runId: "run-a",
    evidence: [
      evidence("owned", "project-a", "run-a"),
      evidence("foreign-project", "project-b", "run-a"),
      evidence("foreign-run", "project-a", "run-b"),
      evidence("unbound"),
    ],
  });
  assert.deepEqual(selected.map((item) => item.id), ["owned"]);
});
