# Workflow 2 policy jobs in PostgreSQL

Status: experimental operational prerequisite for checkpoint 3. Snapshot/result publication,
worker composition and checkpoint acceptance remain open. See
[ADR-0031](../architecture/0031-persist-policy-job-control-and-worker-history.md),
[job contracts](workflow-2-policy-job-contract.md) and
[bounded history](workflow-2-policy-job-history.md).

## Persistence and scope

Migration 0055 installs six exact tenant/project/environment roots: requests, jobs, attempts,
cancellations, job history and reservation indexes. All use forced RLS and mandatory metadata
writer triggers. SQL checks reject absent/null required projections; job guards preserve frozen
roots, deadlines, cumulative charges, bound snapshots/results and terminal receipts. An attempt
retains immutable admission identity and one closure, with its operations in append-only job
history. Readers compare graph projections with normalized owning records and independently
verify request/job hashes, exact retained history and canonical outbox receipts.

`PostgresPolicyEvaluationJobControlRepository` exposes create/cancel/read/history.
`PostgresPolicyEvaluationJobWorkerRepository` exposes claim/heartbeat/reserve/interrupt/reclaim
and reads. They accept a supplied pool and use one exact-scope READ COMMITTED connection. Fixed
SQL functions take the current store epoch and native `clock_timestamp()` receipt after acquiring
the job lock. Retained JSON is evidence of a past receipt, not a current execution grant.

Migration 0056 binds a graph read to the immutable history head at its own `stateVersion - 1`.
A valid concurrent cancellation can commit after the graph statement without substituting the
new head or falsely reporting corruption. Reads still validate exact scope/job digest, graph
hash and retained page; public history-head lookup remains the latest head. The coherent response
describes its original operational version and does not revive its lease or grant publication.

Semantic `evaluationTime` remains unchanged. Database operational cuts retain microsecond
precision; the original request receipt keeps its millisecond contract. Expiry is strict,
heartbeat cadence is frozen, retries/backoff are finite, and all physical reservation occurrences
consume cumulative usage. Identical reservation acknowledgements retain their original event
without another charge; changed scope/job/fence/nonce/delta conflicts. Validation checks the live
fence and expiry before considering even an identical reservation retry.

Canonical creation/cancellation/terminal intents commit with the graph and history. The
tenant-wide outbox subject uses `pej_` plus 60 characters of the exact owning job digest, so two
environments can retain the same logical job ID. Complete subject hashes and scope remain in
payloads; conflicting outbox subjects fail the entire transaction. Intent payloads contain
operational metadata, without evidence bytes, keys, policy disposition or release authority.

## Optional separate roles

Existing role provisioning keeps its ten-role configuration. To add policy operational jobs,
explicitly supply both `policyEvaluationControl` and `policyEvaluator` credentials through
`provisionRuntimeRoles`, or both CLI environment variables:

- `PROOFSTACK_POLICY_EVALUATION_CONTROL_DATABASE_PASSWORD`
- `PROOFSTACK_POLICY_EVALUATOR_DATABASE_PASSWORD`

Optional names use `PROOFSTACK_POLICY_EVALUATION_CONTROL_DATABASE_ROLE` and
`PROOFSTACK_POLICY_EVALUATOR_DATABASE_ROLE`; defaults are `proofstack_policy_evaluation_control`
and `proofstack_policy_evaluator`. A partial pair fails before connection allocation. Keep values
in the isolated service's credential mechanism; never print or commit actual credentials.

The control role receives fixed create/cancel functions; the evaluator receives fixed worker
functions. Both receive bounded exact-history/read helpers. Neither receives direct table DML,
role membership, arbitrary projection helpers, recovery or publication authority. The existing
API/policy-author/evaluation/reviewer/replay credentials gain no policy job worker grants.
Application authentication and exact scope authorization precede these internal repository ports.
Workload `policy:evaluate` remains enqueue only; `policy:evaluation:execute` is non-delegable.

## Restore and original history

Logical database restore first invalidates replay leases by advancing the global recovery epoch,
then calls owner-only `PostgresPolicyEvaluationJobRecovery.recoverAllAtCurrentEpoch`. Repair
retains the exclusive epoch lock, verifies the migration ledger and admits at most 100,000 job
coordinates before reading each graph. Queued jobs remain queued; active attempts close with
spent usage and follow the frozen retry policy; elapsed retry readiness can advance operational
time. Original deadlines or final history capacity cause their original terminal status.
Terminal jobs, frozen semantic time, request identity and any already bound snapshot remain intact.

Recovery appends an exact `recovery` history event with the forward epoch and native cut, and
atomically adds any required terminal intent. A second repair at the same epoch changes nothing.
Old worker fences are rejected even if repair later fails; restore returns failure if repair does
not finish. Runtime control/worker roles cannot invoke owner recovery. A rollback failure retains
the original error and destroys the connection once. Restored services still need explicit role
reprovisioning, coordinated object-state verification and contributor recovery acceptance.

## Verification and open boundaries

The shared eleven memory/native conformance cases exercise original request retries, immutable
detached reads, exact old history prefixes, reservation/cancellation races, spent work, deadline,
retry and three-tenant scope boundaries. Native tests additionally exercise separate grants,
concurrent claim, actual heartbeat/lease time, forced constraints, cross-environment outbox subjects,
epoch invalidation and original terminal/usage/history preservation. Adapter unit tests reject
malformed receipts and correctly hashed substitutions and verify rollback/connection cleanup.

The coordinated PostgreSQL/S3 backup-and-restore rehearsal includes representative queued,
acquiring, retry-ready and cancelled policy jobs, positive reservations and original cancellation.
It independently reconstructs every expected changed job/attempt/history row from the original
graph and native recovery cut; all six tables, original requests/reservations/intents and history
prefixes remain in the full database comparison. Separate restored role pools reject old worker
fences, direct DML and owner recovery, then admit a new forward-epoch claim with original inputs
and usage. This exercise does not establish the still-unimplemented sealed/running/completed result
publication flow or acceptance of every scheduler state.

Operational policy repositories require a supplied pool with a finite 1–500 ms checkout timeout,
1–16 connections and fewer than 64 waiting checkouts. They do not mutate its configuration.
`createPostgresPool` keeps its general 5-second default; explicitly set the server-owned
`connectionTimeoutMilliseconds` option to 500 for policy operation/recovery composition.
The recovery CLI does so. Configured pg `query_timeout` is rejected because it can return before
server work drains; the driver's disabled `false` default is accepted.

One operational transaction has a 2-second monotonic ceiling, fixed server statement timeout
up to 1 second, lock timeout up to 250 ms, 16 pending and 256 total query admissions. Owner bulk
repair has a separate finite 120-second / 1,200,016-query ceiling and the existing 100,000-job
coordinate admission. A caught or unawaited query failure taints the whole transaction. Expired
ports cannot execute SQL. On a stalled query/callback, the watchdog physically destroys the
connection, ends/drains started SQL and only then releases the destroyed client. Rollback failure
keeps the original cause. Racing a callback or pg read timeout alone is insufficient cleanup.

Migration 0057 adds an evaluator-only native I/O admission. It binds exact job/scope/version and
optional live fence to a fresh DB cut, floors remaining milliseconds across job/attempt/lease
expiry and caps them at 2 seconds. The adapter independently checks that descriptor, shortens its
monotonic limit from before the query invocation and tightens server statement/lock limits. New
claim/lease receipts are checked again before history/commit. Old idempotent request/reservation
receipts do not extend remaining time; an active claim itself is not idempotent. Control cleanup
and store-owned reclaim retain a bounded path after execution expiry. The admission report does
not grant authority after its transaction ends; every mutation still checks live normalized state.

Native probes exercise pg_sleep server cancellation and same-backend reuse, real advisory waits,
saturated checkout removal, destroyed backend replacement, and caught/unawaited whole rollback.
They also verify shrinking fresh native time while a reservation retry preserves its original
receipt, evaluator-only admission and strict expiry with later reclaim. Materialized limits still
do not establish complete worker-wide source SQL/wire/read admission. Source acquisition/crypto/
object I/O, all-state restoration and held publication composition remain required. No public route, service,
sealed snapshot publisher, predicate/result publisher or production composition is introduced by
these operational repositories. Read-only source recheck still ends before returning: never
publish a snapshot/result later from its report. Complete closure and held-guard publication,
all predicates, durable worker/API/SDK/recovery exercises and independent exit audit must pass
before checkpoint 3 is accepted.

Run service-backed tests only against disposable PostgreSQL 16.15 named `proofstack_test`:

```sh
pnpm --filter @proofstack/postgres test:integration
pnpm --filter @proofstack/recovery-operations test:integration
```

Use the repository's pinned isolated S3-compatible service where required by recovery. Frozen
install, uncached full checks, all independent CI service jobs and separate CodeQL still apply.
Unit/full-check success alone is insufficient service-backed or checkpoint acceptance.
