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

Legacy locks without `ownerIdentity`, `ownerExecutable`, and `ownerCommandLine` remain `owner-unconfirmed` even when their PID is absent. They require independent operator evidence, the supported owner probe, and the exact additional confirmation `I confirm external owner inspection for Runtime lock <fingerprint> pid <pid>` before recovery can be authorized. PID absence alone is not stale proof.

The latest Runtime checks both maintenance and recovery ownership before startup. Older Runtime binaries do not know the recovery lock, so cross-version startup must remain stopped and externally supervised until the old binary is confirmed absent. This limitation is not solved by deleting a file.

The legacy `runtime-recover-stale` command is deliberately rejected because it cannot preserve the ownership handoff. Before the combined command, inspect `maintenance-status` and both pending jobs. Do not use stale-lock recovery approval as job containment approval. Do not run recovery against the production lock without the separate approval for the exact lock fingerprint and each job.
