import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRuntimeLock, loadRuntimeHostConfig, saveRuntimeHostConfig } from "../scripts/iseol-runtime-host.js";

test("runtime host loads explicit roots and derives a durable lock path", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-"));
  const file = join(root, "runtime.json");
  await writeFile(file, JSON.stringify({ dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"), webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile") }));
  const config = loadRuntimeHostConfig(file);
  assert.equal(config.dataRoot, root);
  assert.equal(config.lockPath, join(root, "runtime", "iseol-runtime.lock"));
  assert.equal(config.version, 1);
});

test("runtime host persists bounded lifecycle metadata atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-config-"));
  const file = join(root, "runtime.json");
  await saveRuntimeHostConfig(file, {
    dataRoot: root,
    modelRoot: join(root, "model"),
    runRoot: join(root, "runs"),
    webWorkerRoot: join(root, "workers"),
    browserProfileRoot: join(root, "profile"),
    lockPath: join(root, "runtime", "lock"),
    codeVersion: "abc123",
    projectRuntimeEnabled: true,
    desktopAgentId: "agent-project",
    projectModelRoot: join(root, "project-model"),
    projectRunRoot: join(root, "project-runs"),
    projectWebWorkerRoot: join(root, "project-workers"),
    projectDesktopStateRoot: join(root, "project-desktop"),
  });
  const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(saved.version, 1);
  assert.equal(saved.codeVersion, "abc123");
  assert.equal(saved.projectRuntimeEnabled, true);
  assert.equal(saved.desktopAgentId, "agent-project");
  assert.equal(saved.projectRunRoot, join(root, "project-runs"));
  assert.equal("token" in saved, false);
  assert.equal(loadRuntimeHostConfig(file).projectRuntimeEnabled, true);
  assert.equal(loadRuntimeHostConfig(file).projectDesktopStateRoot, join(root, "project-desktop"));
});

test("runtime host rejects invalid project lifecycle metadata before startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-invalid-"));
  const file = join(root, "runtime.json");
  await writeFile(file, JSON.stringify({ dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"), webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile"), projectRuntimeEnabled: "yes" }));
  assert.throws(() => loadRuntimeHostConfig(file), /projectRuntimeEnabled/);
});

test("runtime host rejects project roots that overlap Idea Lab roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-overlap-"));
  const file = join(root, "runtime.json");
  await writeFile(file, JSON.stringify({
    dataRoot: root,
    modelRoot: join(root, "model"),
    runRoot: join(root, "runs"),
    webWorkerRoot: join(root, "workers"),
    browserProfileRoot: join(root, "profile"),
    projectModelRoot: join(root, "model"),
    projectRunRoot: join(root, "project-runs"),
    projectWebWorkerRoot: join(root, "project-workers"),
    projectDesktopStateRoot: join(root, "project-desktop"),
  }));
  assert.throws(() => loadRuntimeHostConfig(file), /project.*overlap/i);
});

test("runtime host lock prevents concurrent ownership and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-lock-"));
  const path = join(root, "runtime.lock");
  const release = await acquireRuntimeLock(path);
  await assert.rejects(acquireRuntimeLock(path), /already owns/);
  await release();
  const releaseAgain = await acquireRuntimeLock(path);
  await releaseAgain();
});

test("runtime host reclaims a lock only after its recorded owner exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-stale-"));
  const path = join(root, "runtime.lock");
  await writeFile(path, JSON.stringify({ version: 1, pid: 999999, startedAt: "2026-01-01T00:00:00.000Z" }));
  const release = await acquireRuntimeLock(path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
  await release();
});
