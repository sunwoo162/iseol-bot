import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapOperatorCredential, encodePowerShellCommand, isValidDpapiCiphertext, operatorCredentialPath, readOperatorCredential, rotateOperatorCredential, verifyOperatorCredential, type CredentialCrypto } from "../src/runtime/operator-credentials.js";

function cryptoFixture(): CredentialCrypto {
  return {
    protect: async (value) => `protected:${Buffer.from(value, "utf8").toString("base64")}`,
    unprotect: async (value) => Buffer.from(value.slice("protected:".length), "base64").toString("utf8"),
    userSid: async () => "S-1-5-21-test",
  };
}

test("PowerShell DPAPI scripts are passed through encoded command input", () => {
  const script = "$s = ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force";
  assert.equal(Buffer.from(encodePowerShellCommand(script), "base64").toString("utf16le"), script);
});

test("DPAPI output validation rejects CLIXML, errors, and empty ciphertext", () => {
  assert.equal(isValidDpapiCiphertext("#< CLIXML"), false);
  assert.equal(isValidDpapiCiphertext(""), false);
  assert.equal(isValidDpapiCiphertext("not-a-ciphertext"), false);
  assert.equal(isValidDpapiCiphertext("0".repeat(128)), true);
});

test("operator bootstrap stores only protected credential material and verifies the Windows identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-operator-"));
  const path = operatorCredentialPath(root);
  const crypto = cryptoFixture();
  const created = await bootstrapOperatorCredential({ path, operatorId: "operator-1", now: "2026-09-20T00:00:00.000Z", crypto });
  assert.equal(created.operatorId, "operator-1");
  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes("protected:"), true);
  assert.equal(raw.includes("operator-1"), true);
  assert.equal(await verifyOperatorCredential({ path, operatorId: "operator-1", crypto }), true);
  assert.equal(await verifyOperatorCredential({ path, operatorId: "other", crypto }), false);
  assert.equal(await verifyOperatorCredential({ path, operatorId: "operator-1", token: "wrong", crypto }), false);
});

test("operator bootstrap is one-time and rotation replaces the protected credential without exposing a token", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-operator-"));
  const path = operatorCredentialPath(root);
  const crypto = cryptoFixture();
  await bootstrapOperatorCredential({ path, operatorId: "operator-1", now: "2026-09-20T00:00:00.000Z", crypto });
  await assert.rejects(() => bootstrapOperatorCredential({ path, operatorId: "operator-1", crypto }), /already exists/);
  await rotateOperatorCredential({ path, operatorId: "operator-1", now: "2026-09-20T01:00:00.000Z", crypto });
  const record = await readOperatorCredential(path);
  assert.equal(record?.rotatedAt, "2026-09-20T01:00:00.000Z");
  assert.equal(record?.protectedToken.includes("protected:"), true);
});

test("rotation is bound to the Windows identity that performed bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-operator-"));
  const path = operatorCredentialPath(root);
  const crypto = cryptoFixture();
  await bootstrapOperatorCredential({ path, operatorId: "operator-1", crypto });
  const otherIdentity = { ...crypto, userSid: async () => "S-1-5-21-other" };
  await assert.rejects(() => rotateOperatorCredential({ path, operatorId: "operator-2", crypto: otherIdentity }), /registered Windows identity/);
});
