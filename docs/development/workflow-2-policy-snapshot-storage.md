# Native policy snapshot storage

[English](workflow-2-policy-snapshot-storage.md) | [한국어](workflow-2-policy-snapshot-storage.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`PostgresPolicySnapshotTransactions` implements the trusted held ports of
`sealPolicyEvaluationSnapshot`; see [ADR-0032](../architecture/0032-persist-policy-snapshots-through-held-worker-ports.md).
The workspace worker entry accepts server-owned identities/fence and repositories, never submitted
graphs, page definitions, operands or outcomes. Service-token execution and separately authorized
artifact reads precede acquisition. Native storage requires strict input version 0.2 and configured
owning logical-root readers; unresolved evidence remains explicit rather than becoming eligibility.

Content/key I/O completes before publication guards. The adapter locks the current job/attempt,
verifies native remaining time and canonical preceding history, then retains one READ COMMITTED
client through nonblocking metadata/resource guards, complete source reinspection and internally
compiled page/root publication. Native time binds the same acquiring attempt to its snapshot and
enters `sealed`; no replacement claim or invented attempt is used. Page/root integrity and the final
native fence check execute before commit. Any failure rolls back pages, binding, job and history.

Migration 0058 preserves earlier checksums and original history checks. Snapshot/page rows are
immutable and scoped by tenant/project/environment; deferred checks join every original page,
canonical frame encoding, full input bytes and owning request/job. The original authenticated
artifact retention text and upstream semantic time remain unchanged. Neither a historical read
nor the earlier closed source report grants current publication authority.

Use `createPolicyPostgresPool`: sealing rejects unbranded clients before SQL. Its separate finite
15-second/128-MiB/200,000-row-header purpose is tightened to the native lease/attempt/job expiry.
Normal transactions and owner recovery keep their original limits. SQL statement/lock bounds,
pre-decoder frame admission, taint, expired ports and physical destruction/drain still apply.
These protocol counts are distinct from semantic records/bytes and durable job-wide acquisition.

Opt in both separate control/evaluator role credentials. Only evaluator gets fenced guards and
snapshot publication; control gets fixed snapshot reads. Required owning source SELECT/intents
do not grant DML, upstream publication, identity/credential reads or original unbound guards.
Existing workload/user/API/policy-author/evaluation/reviewer credentials cannot substitute for the
service-token execution principal or new worker pool.

Real PostgreSQL cases cover held source composition/readback, same-attempt binding, denied roles
and direct DML, absent guards, stale epoch, exact-scope mismatch, lease expiry during content I/O,
caught/unawaited failures, expired ports, missing/substituted pages and post-publication rollback.
The real PostgreSQL/S3 restoration graph includes original snapshot roots/pages and a sealed job;
recovery preserves those bytes/receipts while invalidating leases and re-provisioning roles.

This increment does not compose a production worker or a public route. Durable job-wide admission
before all source I/O remains open: charging inside this transaction would refund spent work on rollback.
The optional [expected artifact byte admission](workflow-2-policy-artifact-admission.md) now commits
reservations before get and preserves them on publication rollback; this does not close the entire
metadata/object transport/oversized-response accounting boundary.
Memory/native full publication conformance, computing/completed restoration states, all predicates,
atomic results, worker/API/SDK/contributor acceptance and the independent checkpoint exit still
precede checkpoint approval. No policy verdict, human approval or release authority is introduced.
