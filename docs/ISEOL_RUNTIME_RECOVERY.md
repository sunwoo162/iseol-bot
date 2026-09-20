# Runtime lock recovery

`npm.cmd run iseol:runtime -- status` is read-only. It reports the lock fingerprint and distinguishes `running`, `stale`, `owner-unconfirmed`, `owner-reused`, `unreadable`, and `stopped`.

The Runtime host never removes a lock as a side effect of status or startup. A stale lock must be recovered explicitly. Recovery and the maintenance handoff use one command:

```powershell
npm.cmd run iseol:runtime -- maintenance-recover-stale-contain-batch
```

The command reads JSON from stdin and uses `ISEOL_OPERATOR_TOKEN` and `ISEOL_OPERATOR_ID` from the operator's authenticated environment. The JSON must contain the exact fingerprint from the immediately preceding inspection, a separate recovery confirmation, and independently approved job entries. The recovery confirmation is:

```text
I approve stale Runtime lock recovery for <exact fingerprint>
```

Recovery acquires a recovery ownership file, re-reads the lock, verifies the fingerprint and owner state, acquires maintenance ownership while recovery ownership is held, removes only the unchanged stale lock, and processes the independently approved job entries before releasing maintenance ownership. This combined command is required because a short-lived recovery process cannot safely hand off ownership between separate commands. A changed lock, live or reused owner, unavailable owner identity, competing recovery/maintenance owner, or unreadable lock fails closed.

When the pending jobs are already contained and only the Runtime lock remains, use the lock-only command instead of the batch command:

```powershell
npm.cmd run iseol:runtime -- maintenance-recover-stale-lock
```

It authenticates the registered Windows identity and protected credential record; no plaintext token is part of this command's stdin. Stdin contains only the exact fingerprint, legacy owner-inspection confirmation, and recovery confirmation. It does not read or mutate Project Desktop jobs. It holds recovery ownership through the maintenance handoff, rechecks the owner and fingerprint immediately before removal, removes only the unchanged lock, and releases both ownership files. It must not be used while the Runtime owner is alive or unconfirmed without the required independent legacy-owner evidence.

For a Runtime whose legacy lock is still present and whose original console is unavailable, the separately approved controlled external stop command is:

```powershell
npm.cmd run iseol:runtime -- operator-stop
```

This command authenticates the registered Windows identity, rechecks the exact PID, process creation time, executable, command line, lock fingerprint, configured data root, and active Desktop leases/mutation states, then sends an external termination signal only to the approved PID. It never removes the lock. External termination can leave the lock and in-flight work indeterminate; run lock-only recovery only after the PID and listener are confirmed absent.

Legacy locks without `ownerIdentity`, `ownerExecutable`, and `ownerCommandLine` remain `owner-unconfirmed` even when their PID is absent. They require independent operator evidence, the supported owner probe, and the exact additional confirmation `I confirm external owner inspection for Runtime lock <fingerprint> pid <pid>` before recovery can be authorized. PID absence alone is not stale proof.

## First operator setup

The repository does not accept an arbitrary environment value as the first production operator credential. On Windows, the operator must bootstrap a DPAPI-protected credential bound to the current Windows user:

```powershell
'{"operatorId":"<operator-id>"}' | npm.cmd run iseol:runtime -- operator-bootstrap
```

The command writes only encrypted credential material under the configured runtime data root and does not print a token. It is one-time; rotation is explicit and must be performed by the registered Windows identity:

```powershell
'{"operatorId":"<operator-id>"}' | npm.cmd run iseol:runtime -- operator-rotate
```

The recovery CLI verifies the protected credential and Windows identity. It no longer requires a plaintext token in `.env` when the protected credential exists. The bootstrap and rotation commands must be run by the authorized operator in the intended Windows account; do not place tokens in command-line arguments, logs, Git, or plaintext `.env`.

The latest Runtime checks both maintenance and recovery ownership before startup. Older Runtime binaries do not know the recovery lock, so cross-version startup must remain stopped and externally supervised until the old binary is confirmed absent. This limitation is not solved by deleting a file.

The legacy `runtime-recover-stale` command is deliberately rejected because it cannot preserve the ownership handoff. Before the combined command, inspect `maintenance-status` and both pending jobs. Do not use stale-lock recovery approval as job containment approval. Do not run recovery against the production lock without the separate approval for the exact lock fingerprint and each job.
