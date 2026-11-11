# Demo ledger safety candidate — 5 November 2026

Base: `7fee5ef2baa9c0482617e1cec29c6de109e0702c`, current default
`claude/upbeat-fermat-b4s6fj`. This is a code-only candidate; no production
settings, credentials, money movements, merges or deployments were performed.

## Behavior changed

- Production startup refuses an absent, whitespace-only, short (<32 characters)
  or known development signing key. Length is a minimum validation, not an
  entropy guarantee. Operators must supply an appropriately generated existing
  secret through their approved secret-management procedure.
- Unverified registration email no longer grants production administrator status.
  `EUROFLOW_ADMIN_EMAILS` remains a development convenience only. Existing saved
  roles are not changed; review them before any launch. An authenticated,
  auditable production administrator provisioning mechanism is still needed.
- Demo self-funding and self-verification return 503 in production. No payment
  processor or identity vendor has been fabricated. Outside production the demo
  remains usable; top-ups now share finite-number, cent-precision and amount-limit
  validation with transfers.
- Split details require creator/participant membership and otherwise return 404.
- The entire synchronous HTTP write handler (including invoice/request/split
  status and notifications) commits in one snapshot. Scheduler runs use the same
  boundary. The exported core transfer also starts/joins a transaction. Failed
  operations roll back; an insufficient-funds rejection no longer exposes a
  transaction ID for a rolled-back, nonexistent record.
- Standalone insert/update operations roll back their in-memory mutation on
  pre-commit persistence failure. Other multi-step service callers must explicitly
  use `store.transaction(...)`, as the HTTP and scheduler entrypoints do.
- Snapshot writes use a private same-directory temp file, file fsync, atomic
  rename and directory fsync. A failure before rename preserves the prior image.
  Failure after rename has an uncertain durable outcome: the store is poisoned,
  reads/writes and health fail closed, and recovery is required. It is never
  silently rolled back in memory and retried against potentially committed data.
- Malformed JSON and invalid collection/record shapes stop startup and preserve
  the original snapshot. This is structural validation, not proof that historic
  balances, ownership or business relationships are correct.
- An exclusive sidecar lock permits one writer per configured snapshot path.
  Graceful shutdown drains requests before releasing it. The lock is deliberately
  not automatically stolen based on a PID, age or timeout.

## Operational limits and recovery

This implementation is **single-process, synchronous, local-file demo storage**.
Use one canonical data path on a filesystem with the assumed local atomic rename
and fsync semantics. Do not run multiple replicas, use different aliases for the
same file, or place the data on an unverified network filesystem. Full snapshot
cloning/writing is unsuitable for a large ledger. Existing old binaries do not
honor locks; all old writers must be stopped before any separately approved
rollout. No rolling mixed-version deployment is safe.

A crash intentionally leaves a stale `.lock` file. Before removing it, an operator
must verify that all writers using that snapshot are stopped, preserve a backup
of the snapshot and any temp files, and validate the committed snapshot. A temp
file is not automatically a committed transaction. If durability was uncertain,
reconcile the transaction/invoice state before accepting a retry. Then remove
only the confirmed stale lock and restart one reviewed binary. Do not delete or
replace corrupt files to make the app boot; restore/reconcile using a verified
backup and retain the damaged evidence.

Transactions accept synchronous internal callbacks only; no awaited/provider
operations may run inside them. Nested transactions join the outer boundary;
exceptions must propagate rather than be swallowed. Direct edits to `store.data`
are not a supported external API. This change does not provide request idempotency
for arbitrary repeated P2P sends/top-ups. A response lost after a successful
commit remains ambiguous to the client; check the ledger, do not blindly retry.
Server-side intent keys and client reconciliation remain future work.

PR #4 (`fa6573a677d71d4063acdec6a99fc4a28bd42ce7`) was inspected and preserved. It
replaces this store with asynchronous per-record Postgres write-through while
retaining in-memory reads; it does not provide an atomic, authoritative
multi-instance ledger. These branches must be consciously reconciled, not merged
mechanically. A real database version needs one database transaction for balances,
ledger, invoice/request status and idempotency, with locking/constraints and failure
and concurrency tests against Postgres.

## Validation

`node --test`: full existing suite plus new failure/security tests. New cases cover
invoice atomicity, post-debit failure, disk replacement failure, uncertain directory
fsync, corrupt files, process exit before commit, exclusive cross-process lock,
competing invoice requests, production secret validation, production demo/admin
restrictions, split access, and invalid top-ups. Tests use temporary files,
loopback HTTP and child processes; no provider or production requests occur.

Remaining commercial gates: real-money rails, identity/KYC provider and operating
model, provider reconciliation/reversal, financial-grade database ledger, durable
request idempotency, revocable sessions/account recovery, verified admin
provisioning, monitoring and restore drills. Passing these tests does not authorize
customer deposits or establish compliance.
