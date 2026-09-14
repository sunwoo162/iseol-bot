import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessRunStage, HarnessRuntimeRunEnvelope } from "../src/harness/contracts.js";
import type { ReasoningTurn, WebWorkerSession } from "../src/chatgpt-web/contracts.js";
import { compileWebPrompt } from "../src/chatgpt-web/prompt-compiler.js";

function run(stage: HarnessRunStage = "IMPLEMENT", policySha256 = "policy-sha"): HarnessRuntimeRunEnvelope {
  return {
    version: 1,
    request: { version: 1, runId: "run-prompt", mode: "project-workspace", objective: "Add profile editing", targetRoot: "C:/workspace/project" },
    preflight: { version: 1, runId: "run-prompt", status: "ready", policy: { version: 1, loadedAt: "2026-09-08T01:00:00.000Z", effectiveSha256: policySha256, sources: [
      { kind: "iseol-global", path: "C:/iseol/docs/HARNESS_ENGINEERING.md", sha256: "global-sha", content: "SUPER_SECRET_POLICY_BODY token=do-not-leak" },
      { kind: "project-harness", path: "C:/workspace/project/docs/HARNESS_ENGINEERING.md", sha256: "project-sha", content: "PROJECT_SECRET_BODY" },
    ] } },
    state: { version: 1, stage, status: "RUNNING", completedStages: ["PREFLIGHT", "CONTEXT", "ANALYZE", "PLAN"], skippedStages: [], updatedAt: "2026-09-08T01:05:00.000Z" },
    evidence: [],
    updatedAt: "2026-09-08T01:05:00.000Z",
  };
}
function session(stage: HarnessRunStage = "IMPLEMENT", generation = 1, policySha256 = "policy-sha"): WebWorkerSession {
  return { version: 1, sessionId: `session-${generation}`, runId: "run-prompt", stage, generation, policySha256, status: "ready", createdAt: "2026-09-08T01:06:00.000Z" };
}
function turn(summary = "Keep the existing API contract"): ReasoningTurn {
  return {
    version: 1, turnId: "turn-prior", sessionId: "session-1", runId: "run-prompt", stage: "IMPLEMENT", generation: 1,
    promptSha256: "prompt-old", responseSha256: "response-old", summary, decisions: [summary], desktopIntentIds: [], outcome: "continue", recordedAt: "2026-09-08T01:07:00.000Z",
  };
}

const baseInput = () => ({
  kind: "initial" as const,
  run: run(),
  session: session(),
  priorTurns: [turn()],
  desktopEvidence: [{ kind: "test", summary: "unit tests pending", reference: "desktop-job:1" }],
});

test("prompt compiler is deterministic for identical durable state", () => {
  const first = compileWebPrompt(baseInput());
  const second = compileWebPrompt(structuredClone(baseInput()));
  assert.equal(first.body, second.body);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.runId, "run-prompt");
  assert.equal(first.stage, "IMPLEMENT");
});
test("prompt digest changes with stage generation policy decisions or evidence", () => {
  const original = compileWebPrompt(baseInput()).sha256;
  const changed = [
    compileWebPrompt({ ...baseInput(), run: run("SELF_REVIEW"), session: session("SELF_REVIEW") }).sha256,
    compileWebPrompt({ ...baseInput(), session: session("IMPLEMENT", 2) }).sha256,
    compileWebPrompt({ ...baseInput(), run: run("IMPLEMENT", "policy-new"), session: session("IMPLEMENT", 1, "policy-new") }).sha256,
    compileWebPrompt({ ...baseInput(), priorTurns: [turn("Use the new API contract")] }).sha256,
    compileWebPrompt({ ...baseInput(), desktopEvidence: [{ kind: "test", summary: "unit tests passed", reference: "desktop-job:2" }] }).sha256,
  ];
  for (const digest of changed) assert.notEqual(digest, original);
});

test("prompt contains bounded durable context and allowed intent vocabulary", () => {
  const compiled = compileWebPrompt(baseInput());
  for (const expected of [
    "Add profile editing", "IMPLEMENT", "policy-sha", "Keep the existing API contract",
    "unit tests pending", "READ_CONTEXT", "PROPOSE_PATCH", "RUN_TEST", "RUN_BUILD", "GIT_INSPECT", "REQUEST_COMMIT", "CHECK_HTTP",
  ]) assert.match(compiled.body, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compiled.body, /completion/i);
  assert.doesNotMatch(compiled.body, /SUPER_SECRET_POLICY_BODY|PROJECT_SECRET_BODY/);
});
test("recovery prompts are marked and credential-like evidence is redacted", () => {
  const input = baseInput();
  input.desktopEvidence = [{
    kind: "command",
    summary: "Authorization: Bearer bearer-secret DISCORD_TOKEN=token-secret cookie=session-secret API_KEY=env-secret",
    reference: "desktop-job:secret-check",
  }];
  const compiled = compileWebPrompt({ ...input, kind: "recovery" });
  assert.match(compiled.body, /recovery/i);
  for (const secret of ["bearer-secret", "token-secret", "session-secret", "env-secret", "SUPER_SECRET_POLICY_BODY"]) {
    assert.equal(compiled.body.includes(secret), false);
  }
  assert.match(compiled.body, /\[REDACTED\]/);
});

test("prompt compiler rejects mismatched session and run policy context", () => {
  assert.throws(() => compileWebPrompt({ ...baseInput(), session: { ...session(), runId: "run-other" } }), /runId/i);
  assert.throws(() => compileWebPrompt({ ...baseInput(), session: session("PLAN") }), /stage/i);
  assert.throws(() => compileWebPrompt({ ...baseInput(), session: session("IMPLEMENT", 1, "wrong-policy") }), /policy/i);
});


test("prompt pins the exact reasoning result envelope and Desktop intent contract", () => {
  const compiled = compileWebPrompt({
    ...baseInput(),
    run: run("PLAN"),
    session: session("PLAN", 3),
  });
  const payload = JSON.parse(compiled.body) as any;
  assert.equal(payload.outputContract.responseFormat, "exactly-one-json-object-no-markdown-or-prose");
  assert.deepEqual(payload.outputContract.reasoningTurnResult, {
    version: 1,
    runId: "run-prompt",
    stage: "PLAN",
    generation: 3,
    summary: "non-empty string",
    decisions: ["string"],
    intents: [],
    outcome: "continue|stage-complete|blocked-user|retryable",
  });
  assert.deepEqual(payload.outputContract.desktopIntentCommonRequired, {
    version: 1,
    intentId: "unique non-empty id",
    runId: "run-prompt",
    stage: "PLAN",
    workspaceRoot: "C:/workspace/project",
    policySha256: "policy-sha",
  });
  assert.deepEqual(payload.outputContract.requiredFieldsByIntentKind.READ_CONTEXT, ["path"]);
  assert.deepEqual(payload.outputContract.requiredFieldsByIntentKind.RUN_TEST, ["cwd", "executable", "args", "timeoutMs"]);
  assert.deepEqual(payload.outputContract.requiredFieldsByIntentKind.REQUEST_COMMIT, ["cwd", "message", "expectedHead?"]);
  assert.match(payload.outputContract.blockerReasonRule, /blocked-user/);
});

test("prompt renders Windows workspace roots with JSON-safe forward slashes", () => {
  const input = baseInput();
  input.run.request.targetRoot = "C:\\Users\\user\\IseolLiveSmoke\\sandbox\\campaign-1";

  const compiled = compileWebPrompt(input);
  const payload = JSON.parse(compiled.body) as any;

  assert.equal(
    payload.outputContract.desktopIntentCommonRequired.workspaceRoot,
    "C:/Users/user/IseolLiveSmoke/sandbox/campaign-1",
  );
});
