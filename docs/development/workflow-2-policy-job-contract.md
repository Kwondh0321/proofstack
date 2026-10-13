# Policy job contracts and execution authority

[English](workflow-2-policy-job-contract.md) | [한국어](workflow-2-policy-job-contract.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The immutable job definition binds exact scope, job identity and request reference. Its canonical
domain is separate from request, snapshot and result. Mutable scheduler receipts, counters, leases
and completion times are excluded from that definition digest. An independent Python JSON/UTF-8/
hashlib vector is 441 bytes with SHA-256
`1bba9ece0bec8f0852a4a9522c3cbad46cce4ac9a22178c570db3c6a803ab027`.
The vector is synthetic metadata, not an executed worker or published snapshot.

The scheduler projection distinguishes initial `queued`, active `acquiring`, `sealed` and `running`,
bounded `retry_ready`, and terminal `completed`, `failed`, `timed_out`, `budget_exhausted` or
`cancelled`. Only active states own a current lease. Acquisition has no snapshot; post-seal work
retains the same immutable snapshot. Operational completion requires a result and completed
computing attempt, regardless of the four rule outcomes. It never means policy satisfaction.

The complete compact graph validates the original request/scope/creator, native receipt order,
contiguous attempt history, unique attempt/lease identities, monotone fences/recovery epochs and
closure before replacement. Its deadline derives once from the original request receipt and
limits; each attempt uses the smaller of its original timeout and that job deadline. Heartbeats
cannot extend the frozen lease duration. Stored lease geometry is not live execution authority;
every actual mutation still requires normalized state, current epoch and strict native DB expiry.

All spent, reserved, failed and repeated work must consume one durable job budget. The contract
preserves cumulative acquisition records/reads/bytes, repeated-reference counts/bytes, artifact
read bytes and rule evaluations. Retries cannot refund or reset them. A post-seal attempt cannot
return to acquisition, switch snapshots or retry `source_revision_changed`; fresher evidence needs
a new request. Retry readiness cannot exceed the original finite attempt ceiling. Cancellation
before the first claim retains intent without inventing an attempt or lease.

`policy:evaluation:execute` is non-delegable and the worker boundary requires an explicitly capable
`service` principal authenticated by `service_token`. A user owner, workload, API-key/OIDC identity,
upstream evaluator, reviewer, policy author, enqueue or cancellation capability cannot substitute.
Existing `policy:evaluate` remains enqueue only. Separate `policy:evaluation:cancel` is workload
delegable within its issuer's capability/resource scope. Migration 0054 aligns the existing private
SQL capability vocabularies (32 user, 17 workload) and explicitly excludes workload execution.
It creates no execution role/grant, scheduler table or snapshot/result publication function.

`validatePolicyEvaluationJobSnapshotRecord` recomputes owning request and scoped job definition
digests and binds an independently expected exact job reference/scope. It checks graph integrity,
not a credential, current fence, original source truth or publication permission. Public enqueue,
read and cancel routes/SDK operations are not implemented by these contracts.

The compact job response ceiling is independently 64 KiB; cancellation input is at most 1 KiB.
One bounded request and at most eight compact attempt/usage/fence/receipt records leave headroom
for scope and escaped correlation metadata. Larger append-only transition, heartbeat, cancellation
acknowledgement and durable budget ledgers still require exact bounded history pagination. The
contracts do not establish native pool/SQL/wire admission or interrupt pending repository I/O.

Next implement memory/shared transition conformance, durable budget/history storage, complete
current source/authority/presence/selector closure and held atomic snapshot/pages/job/fence
publication. Capture content outside guards; lock the owning job/attempt first, then retain all
source/migration/recovery guards and native execution authority through the same transaction.
Pure predicates, authoritative result recomputation, atomic result/attempt/job/outbox publication,
private PG control/worker roles, recovery, API/SDK, worker and real-service contributor acceptance
remain required before independent checkpoint exit. Receiving a read-only source recheck does not
authorize later publication. Current contracts do not complete any remaining Workflow 2 checkpoint.

See [result contracts](workflow-2-policy-result-contract.md),
[snapshot contracts](workflow-2-policy-snapshot-contract.md), and
[entry audit](workflow-2-policy-evaluation-entry-audit.md).
