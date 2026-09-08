import assert from "node:assert/strict";
import test from "node:test";
import {
  ISEOL_DESKTOP_PROTOCOL_VERSION,
  assertDesktopProtocolVersion,
  assertDesktopTaskPack,
} from "../src/desktop-agent/contracts.js";

function basePack() {
  return {
    version: 1,
    jobId: "job-001",
    runId: "run-001",
    stage: "TEST",
    attempt: 1,
    agentId: "agent-001",
    workspaceRoot: "C:/repo",
    idempotencyKey: "test:run-001",
    leaseUntil: "2026-09-08T01:10:00.000Z",
    operations: [{ id: "op-1", type: "READ_FILE", path: "README.md" }],
  } as const;
}

test("desktop protocol version is strict", () => {
  assert.equal(ISEOL_DESKTOP_PROTOCOL_VERSION, 1);
  assert.doesNotThrow(() => assertDesktopProtocolVersion(1));
  assert.throws(() => assertDesktopProtocolVersion(2), /Unsupported Iseol Desktop protocol version/);
});

test("task pack requires stable execution identity", () => {
  for (const field of ["jobId", "runId", "workspaceRoot", "idempotencyKey"] as const) {
    const pack = { ...basePack(), [field]: "" };
    assert.throws(() => assertDesktopTaskPack(pack), new RegExp(field));
  }

  assert.throws(
    () => assertDesktopTaskPack({ ...basePack(), leaseUntil: "not-a-date" }),
    /leaseUntil/,
  );
});

test("task pack rejects unsupported operations and duplicate operation ids", () => {
  assert.throws(
    () => assertDesktopTaskPack({
      ...basePack(),
      operations: [{ id: "op-1", type: "DELETE_FILE", path: "README.md" }],
    }),
    /Unsupported Desktop operation type/,
  );

  assert.throws(
    () => assertDesktopTaskPack({
      ...basePack(),
      operations: [
        { id: "op-1", type: "READ_FILE", path: "a.txt" },
        { id: "op-1", type: "LIST_DIRECTORY", path: "." },
      ],
    }),
    /duplicate operation id/i,
  );
});

test("mutation-capable task packs require policy provenance", () => {
  const mutation = {
    ...basePack(),
    operations: [{ id: "op-1", type: "APPLY_PATCH", path: "src/app.ts", patch: "@@" }],
  };
  assert.throws(() => assertDesktopTaskPack(mutation), /policyDigest/);

  assert.throws(
    () => assertDesktopTaskPack({ ...mutation, policyDigest: "a".repeat(64), policySources: [] }),
    /policySources/,
  );

  assert.doesNotThrow(() => assertDesktopTaskPack({
    ...mutation,
    policyDigest: "a".repeat(64),
    policySources: [{
      kind: "project-harness",
      path: "C:/repo/docs/HARNESS_ENGINEERING.md",
      sha256: "b".repeat(64),
      required: true,
    }],
  }));
});

test("read-only task packs do not require policy provenance", () => {
  assert.doesNotThrow(() => assertDesktopTaskPack(basePack()));
});

test("desktop operations reject unknown fields and destructive Git through RUN_PROCESS", () => {
  assert.throws(
    () => assertDesktopTaskPack({
      ...basePack(),
      policyDigest: "a".repeat(64),
      policySources: [{ kind: "project-harness", path: "C:/repo/docs/HARNESS_ENGINEERING.md", sha256: "b".repeat(64), required: true }],
      operations: [{ id: "op-1", type: "RUN_PROCESS", cwd: ".", executable: "git", args: ["status"], timeoutMs: 1_000, shell: true }],
    }),
    /unknown field/i,
  );
  assert.throws(
    () => assertDesktopTaskPack({
      ...basePack(),
      policyDigest: "a".repeat(64),
      policySources: [{ kind: "project-harness", path: "C:/repo/docs/HARNESS_ENGINEERING.md", sha256: "b".repeat(64), required: true }],
      operations: [{ id: "op-1", type: "RUN_PROCESS", cwd: ".", executable: "git", args: ["reset", "--hard", "HEAD~1"], timeoutMs: 1_000 }],
    }),
    /destructive Git process/i,
  );
  for (const args of [
    ["-C", "C:/repo", "reset", "--hard"],
    ["-c", "core.autocrlf=false", "clean", "-fd"],
  ]) {
    assert.throws(
      () => assertDesktopTaskPack({
        ...basePack(),
        policyDigest: "a".repeat(64),
        policySources: [{ kind: "project-harness", path: "C:/repo/docs/HARNESS_ENGINEERING.md", sha256: "b".repeat(64), required: true }],
        operations: [{ id: "op-1", type: "RUN_PROCESS", cwd: ".", executable: "git", args, timeoutMs: 1_000 }],
      }),
      /destructive Git process/i,
    );
  }
});
