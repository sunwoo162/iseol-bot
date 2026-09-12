import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DesktopPolicySource, DesktopTaskPack } from "../src/desktop-agent/contracts.js";
import { assertWorkspaceAccess, verifyDesktopTaskPolicy } from "../src/desktop-agent/workspace-guard.js";
import { executeDesktopTaskPack } from "../src/desktop-agent/runtime.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function effective(sources: DesktopPolicySource[]) {
  return sha(sources.map((source) => `${source.kind}\n${source.path}\n${source.sha256}`).join("\n---\n"));
}

async function fixture() {
  const allowed = await mkdtemp(join(tmpdir(), "iseol-desktop-runtime-"));
  const workspace = join(allowed, "repo");
  await mkdir(join(workspace, "docs"), { recursive: true });
  const harnessPath = join(workspace, "docs", "HARNESS_ENGINEERING.md");
  await writeFile(harnessPath, "# Test Harness\n", "utf8");
  return { allowed, workspace, harnessPath };
}

function policyPack(workspace: string, harnessPath: string, operations: DesktopTaskPack["operations"]): DesktopTaskPack {
  const sources: DesktopPolicySource[] = [{
    kind: "project-harness",
    path: harnessPath,
    sha256: sha("# Test Harness\n"),
    required: true,
  }];
  return {
    version: 1,
    jobId: "job-001",
    runId: "run-001",
    stage: "TEST",
    attempt: 1,
    agentId: "agent-001",
    workspaceRoot: workspace,
    policyDigest: effective(sources),
    policySources: sources,
    idempotencyKey: "test:runtime",
    leaseUntil: "2026-09-08T02:00:00.000Z",
    operations,
  };
}

test("workspace guard allows descendants and rejects parent escape", async () => {
  const { allowed, workspace } = await fixture();
  const inside = await assertWorkspaceAccess([allowed], workspace, join(workspace, "docs"));
  assert.equal(inside, resolve(workspace, "docs"));
  await assert.rejects(
    assertWorkspaceAccess([allowed], workspace, join(workspace, "..", "outside.txt")),
    /outside Desktop workspace/i,
  );
});

test("workspace guard resolves symlinks before authorizing access", async () => {
  const { allowed, workspace } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "iseol-desktop-outside-"));
  await writeFile(join(outside, "secret.txt"), "outside", "utf8");
  const link = join(workspace, "linked-outside");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    assertWorkspaceAccess([allowed], workspace, join(link, "secret.txt")),
    /outside Desktop workspace/i,
  );
});

test("policy verification re-reads local harness sources and rejects drift", async () => {
  const { allowed, workspace, harnessPath } = await fixture();
  const pack = policyPack(workspace, harnessPath, [
    { id: "op-1", type: "APPLY_PATCH", path: "README.md", patch: "patch" },
  ]);
  await assert.doesNotReject(verifyDesktopTaskPolicy(pack, [allowed]));
  await writeFile(harnessPath, "# Changed Harness\n", "utf8");
  await assert.rejects(verifyDesktopTaskPolicy(pack, [allowed]), /policy source hash mismatch/i);
});

test("missing required policy source fails closed", async () => {
  const { allowed, workspace, harnessPath } = await fixture();
  const pack = policyPack(workspace, harnessPath, [
    { id: "op-1", type: "GIT_COMMIT", cwd: workspace, message: "test: commit" },
  ]);
  await writeFile(harnessPath, "# Changed Harness\n", "utf8");
  pack.policySources![0]!.path = join(workspace, "docs", "MISSING.md");
  await assert.rejects(verifyDesktopTaskPolicy(pack, [allowed]), /required policy source/i);
});

function initGit(workspace: string) {
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "iseol@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Iseol Test"], { cwd: workspace });
}

test("structured runtime executes file, process, and bounded output operations in order", async () => {
  const { allowed, workspace, harnessPath } = await fixture();
  await writeFile(join(workspace, "data.txt"), "hello", "utf8");
  await writeFile(join(workspace, "print.js"), "console.log(\"abcdefghijklmnopqrstuvwxyz\");\n", "utf8");
  const pack = policyPack(workspace, harnessPath, [
    { id: "read", type: "READ_FILE", path: "data.txt" },
    { id: "list", type: "LIST_DIRECTORY", path: "." },
    {
      id: "process",
      type: "RUN_PROCESS",
      cwd: ".",
      executable: process.execPath,
      args: ["print.js"],
      timeoutMs: 2_000,
    },
  ]);
  const result = await executeDesktopTaskPack(pack, { allowedRoots: [allowed], maxOutputBytes: 20 });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.operations.map((item) => item.operationId), ["read", "list", "process"]);
  assert.equal(result.operations[0]?.stdout, "hello");
  assert.ok((result.operations[2]?.stdout?.length ?? 0) <= 20);
});

test("runtime classifies process timeout as retryable failure", async () => {
  const { allowed, workspace, harnessPath } = await fixture();
  await writeFile(join(workspace, "slow.js"), "setTimeout(() => {}, 10000);\n", "utf8");
  const pack = policyPack(workspace, harnessPath, [{
    id: "slow",
    type: "RUN_PROCESS",
    cwd: ".",
    executable: process.execPath,
    args: ["slow.js"],
    timeoutMs: 50,
  }]);
  const result = await executeDesktopTaskPack(pack, { allowedRoots: [allowed] });
  assert.equal(result.status, "retryable-failure");
  assert.equal(result.operations[0]?.ok, false);
  assert.match(result.operations[0]?.summary ?? "", /timed out/i);
});

test("runtime applies guarded patch and performs explicit Git inspection and commit", async () => {
  const { allowed, workspace, harnessPath } = await fixture();
  initGit(workspace);
  await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
  execFileSync("git", ["add", "hello.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "chore: initial"], { cwd: workspace, stdio: "ignore" });
  const patch = [
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const pack = policyPack(workspace, harnessPath, [
    { id: "patch", type: "APPLY_PATCH", path: "hello.txt", patch },
    { id: "status", type: "GIT_STATUS", cwd: "." },
    { id: "diff", type: "GIT_DIFF", cwd: "." },
    { id: "branch", type: "GIT_BRANCH", cwd: "." },
    { id: "commit", type: "GIT_COMMIT", cwd: ".", message: "feat: update hello" },
  ]);
  const result = await executeDesktopTaskPack(pack, { allowedRoots: [allowed] });
  assert.equal(result.status, "completed");
  assert.equal((await readFile(join(workspace, "hello.txt"), "utf8")).replace(/\r\n/g, "\n"), "new\n");
  assert.match(result.operations.find((item) => item.operationId === "status")?.stdout ?? "", /hello\.txt/);
  assert.match(result.operations.find((item) => item.operationId === "diff")?.stdout ?? "", /\+new/);
  assert.ok((result.operations.find((item) => item.operationId === "branch")?.stdout ?? "").trim().length > 0);
  const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  assert.equal(count, "2");
});

test("runtime checks HTTP without exposing a shell command surface", async () => {
  const { allowed, workspace } = await fixture();
  const server = createServer((_req, res) => { res.statusCode = 204; res.end(); });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const pack = policyPack(workspace, join(workspace, "docs", "HARNESS_ENGINEERING.md"), [
      { id: "http", type: "CHECK_HTTP", url: `http://127.0.0.1:${address.port}/health`, timeoutMs: 2_000 },
    ]);
    const result = await executeDesktopTaskPack(pack, { allowedRoots: [allowed] });
    assert.equal(result.status, "completed");
    assert.match(result.operations[0]?.summary ?? "", /204/);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("Git commit publish pushes the exact commit to the current origin branch", async () => {
  const { allowed, workspace, harnessPath } = await fixture();
  initGit(workspace);
  await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
  execFileSync("git", ["add", "hello.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "chore: initial"], { cwd: workspace, stdio: "ignore" });
  const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  const remote = join(allowed, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: workspace });
  execFileSync("git", ["switch", "-c", "idea/camp/prod"], { cwd: workspace, stdio: "ignore" });
  await writeFile(join(workspace, "hello.txt"), "new\n", "utf8");
  const pack = policyPack(workspace, harnessPath, [{
    id: "commit", type: "GIT_COMMIT", cwd: ".", message: "feat: publish prototype", expectedHead, publish: true,
  }]);
  pack.stage = "COMMIT";

  const result = await executeDesktopTaskPack(pack, { allowedRoots: [allowed] });
  assert.equal(result.status, "completed");
  const local = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  const remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/idea/camp/prod"], { encoding: "utf8" }).trim();
  assert.equal(remoteHead, local);
  assert.equal(result.operations[0]?.reference, local);
});
test("Git commit publish retry reuses the committed HEAD after an initial push failure", async () => {
  const { allowed, workspace, harnessPath } = await fixture();
  initGit(workspace);
  await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
  execFileSync("git", ["add", "hello.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "chore: initial"], { cwd: workspace, stdio: "ignore" });
  const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  const missingRemote = join(allowed, "missing.git");
  execFileSync("git", ["remote", "add", "origin", missingRemote], { cwd: workspace });
  execFileSync("git", ["switch", "-c", "idea/camp/retry"], { cwd: workspace, stdio: "ignore" });
  await writeFile(join(workspace, "hello.txt"), "new\n", "utf8");
  const pack = policyPack(workspace, harnessPath, [{
    id: "commit", type: "GIT_COMMIT", cwd: ".", message: "feat: publish retry", expectedHead, publish: true,
  }]);
  pack.stage = "COMMIT";

  const first = await executeDesktopTaskPack(pack, { allowedRoots: [allowed] });
  assert.equal(first.status, "retryable-failure");
  const committed = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), "2");
  const remote = join(allowed, "remote-retry.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["remote", "set-url", "origin", remote], { cwd: workspace });

  const second = await executeDesktopTaskPack(pack, { allowedRoots: [allowed] });
  assert.equal(second.status, "completed");
  assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), "2");
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/idea/camp/retry"], { encoding: "utf8" }).trim(), committed);
});