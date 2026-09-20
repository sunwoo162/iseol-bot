import { randomBytes } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const execFile = promisify(execFileCallback);

export type OperatorCredentialRecord = {
  version: 1;
  operatorId: string;
  userSid: string;
  protectedToken: string;
  createdAt: string;
  rotatedAt: string;
};

export type CredentialCrypto = {
  protect: (value: string) => Promise<string>;
  unprotect: (value: string) => Promise<string>;
  userSid: () => Promise<string>;
};

export function operatorCredentialPath(dataRoot: string): string {
  return resolve(dataRoot, "runtime", "operator-credential.json");
}

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function isValidDpapiCiphertext(value: string): boolean {
  return /^[0-9a-f]{100,}$/i.test(value.trim());
}

async function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const encodedCommand = encodePowerShellCommand(script);
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      const output = stdout.trim();
      const diagnostic = stderr.trim();
      if (code !== 0 || /#< CLIXML|<S S="Error">|CommandNotFoundException|CouldNotAutoloadMatchingModule/i.test(output) || /#< CLIXML|<S S="Error">|CommandNotFoundException|CouldNotAutoloadMatchingModule/i.test(diagnostic)) {
        reject(new Error(`PowerShell DPAPI command failed (exit ${code})`));
        return;
      }
      if (!output) {
        reject(new Error("PowerShell DPAPI command returned no output"));
        return;
      }
      resolveOutput(output);
    });
    child.stdin.end(input, "utf8");
  });
}

const dpapiCrypto: CredentialCrypto = {
  async protect(value) {
    if (process.platform !== "win32") throw new Error("operator credential protection requires Windows DPAPI");
    const encrypted = await powershell("$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $s = ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; $s | ConvertFrom-SecureString", value);
    if (!isValidDpapiCiphertext(encrypted)) throw new Error("PowerShell DPAPI command returned invalid ciphertext");
    return encrypted;
  },
  async unprotect(value) {
    if (process.platform !== "win32") throw new Error("operator credential protection requires Windows DPAPI");
    const plaintext = await powershell("$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $s = ConvertTo-SecureString ([Console]::In.ReadToEnd()); $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }", value);
    if (!plaintext || plaintext.startsWith("#< CLIXML")) throw new Error("PowerShell DPAPI command returned invalid plaintext");
    return plaintext;
  },
  async userSid() {
    if (process.platform !== "win32") throw new Error("operator credential identity requires Windows");
    const output = await execFile("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
    const match = /S-\d-\d+-(?:\d+-){1,14}\d+/.exec(output.stdout);
    if (!match) throw new Error("Windows user SID could not be determined");
    return match[0];
  },
};

async function saveRecord(path: string, record: OperatorCredentialRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function readOperatorCredential(path: string): Promise<OperatorCredentialRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as Partial<OperatorCredentialRecord>;
    if (record.version !== 1 || typeof record.operatorId !== "string" || typeof record.userSid !== "string" || typeof record.protectedToken !== "string") throw new Error("invalid operator credential record");
    return record as OperatorCredentialRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function bootstrapOperatorCredential(input: { path: string; operatorId: string; now?: string; crypto?: CredentialCrypto }): Promise<{ path: string; operatorId: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.operatorId)) throw new Error("operatorId must be a bounded identifier");
  const crypto = input.crypto ?? dpapiCrypto;
  if (await readOperatorCredential(input.path)) throw new Error("operator credential already exists; use rotate");
  const now = input.now ?? new Date().toISOString();
  const token = randomBytes(32).toString("base64url");
  const record: OperatorCredentialRecord = { version: 1, operatorId: input.operatorId, userSid: await crypto.userSid(), protectedToken: await crypto.protect(token), createdAt: now, rotatedAt: now };
  await saveRecord(input.path, record);
  return { path: input.path, operatorId: record.operatorId };
}

export async function rotateOperatorCredential(input: { path: string; operatorId: string; now?: string; crypto?: CredentialCrypto }): Promise<{ path: string; operatorId: string }> {
  const crypto = input.crypto ?? dpapiCrypto;
  const previous = await readOperatorCredential(input.path);
  if (!previous) throw new Error("operator credential is not bootstrapped");
  if (previous.userSid !== await crypto.userSid()) throw new Error("operator credential rotation requires the registered Windows identity");
  const now = input.now ?? new Date().toISOString();
  const token = randomBytes(32).toString("base64url");
  const record: OperatorCredentialRecord = { version: 1, operatorId: input.operatorId, userSid: await crypto.userSid(), protectedToken: await crypto.protect(token), createdAt: previous!.createdAt, rotatedAt: now };
  await saveRecord(input.path, record);
  return { path: input.path, operatorId: record.operatorId };
}

export async function verifyOperatorCredential(input: { path: string; operatorId: string; token?: string; crypto?: CredentialCrypto }): Promise<boolean> {
  const crypto = input.crypto ?? dpapiCrypto;
  const record = await readOperatorCredential(input.path);
  if (!record || record.operatorId !== input.operatorId) return false;
  if (record.userSid !== await crypto.userSid()) return false;
  if (input.token === undefined) return true;
  return (await crypto.unprotect(record.protectedToken)) === input.token;
}
