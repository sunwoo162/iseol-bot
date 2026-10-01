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

test("project evidence omits unsafe URL references but preserves safe and opaque references", () => {
  const selected = selectProjectEvidence({
    projectId: "project-a",
    runId: "run-a",
    evidence: [
      { ...evidence("safe-url", "project-a", "run-a"), reference: "https://preview.example.test/result?ready=1" },
      { ...evidence("credential-url", "project-a", "run-a"), reference: "https://preview.example.test/result?access_token=secret-value" },
      { ...evidence("unsafe-scheme", "project-a", "run-a"), reference: "javascript:alert(1)" },
      { ...evidence("opaque", "project-a", "run-a"), reference: "desktop-job:patch" },
    ],
  });
  assert.deepEqual(selected, [
    { ...evidence("safe-url", "project-a", "run-a"), reference: "https://preview.example.test/result?ready=1" },
    { ...evidence("credential-url", "project-a", "run-a") },
    { ...evidence("unsafe-scheme", "project-a", "run-a") },
    { ...evidence("opaque", "project-a", "run-a"), reference: "desktop-job:patch" },
  ]);
});
