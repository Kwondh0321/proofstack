# Native original approval receipt repository

[English](workflow-2-native-approval-repository.md) | [한국어](workflow-2-native-approval-repository.ko.md)

Status: checkpoint 4 trusted native approval storage prerequisite. Workflow 2 remains **3/7
accepted checkpoints**. Actual current authorization, decision publication and checkpoint exit
acceptance remain open. See [ADR-0055](../architecture/0055-persist-complete-original-approval-receipts.md),
the [shared semantics](workflow-2-approval-repository.md) and
[entry audit](workflow-2-decision-entry-audit.md).

## Whole original records and retries

[Migration 0067](../../packages/postgres/migrations/0067_release_approval_storage.sql) stores
original approval records, six exact subject references, ordered condition/conflict declarations,
ordered compensating control references and revocations. Canonical bytes/hash, full exact scope,
deferred completeness/ordinal/lineage constraints and canonical outbox intent bind whole writes.
Each original has at most one successor and one revocation. Forced RLS and append-only protection
apply to all five tables, including their owner. Upstream reference retention does not prove that
an owning record exists or currently authorizes release.

The [adapter](../../packages/postgres/src/postgres-release-approval-repository.ts) implements the
unchanged trusted storage port. Original definition hashes bind authentication, authority and native
receipt. Equal retry intent plus reviewer principal returns the entire first record even after
another login, current authority version, later recording time or revocation. Those derived fields
cannot overwrite the original receipt. Changed intent or another principal conflicts. Revocation
checks original reference, same reviewer and native causal order before checking existing event
intent; equal retries retain the first event and login. No record is reactivated or rewritten.

## Complete guarded reads

`readPostgresReleaseApprovalOnClient`, `readPostgresReleaseApprovalRevocationOnClient` and
`readPostgresReleaseApprovalSubjectOnClient` use a supplied explicitly scoped client. Whole-kind
and full-subject reads acquire a shared nonwaiting coarse tenant approval transaction guard before
a private VOLATILE READ COMMITTED presence observation. All five tables have mandatory exclusive
writer guards. Absence creation, supersession and revocation remain blocked through the caller's
transaction. Contention fails the whole cut. This correctness granularity is not measured capacity.

Fixed 16-entry keyset pages preserve all four actions and every original, successor and revocation
for the exact kind/subject. Normal approvals and rule exceptions remain distinct. Nothing filters
to latest, approved, unexpired or conflict-free records. Owning readers recompute canonical hashes
and compare complete normalized fields/references/declarations/controls, lineage and outbox intent.
Corruption fails; it cannot become ordinary absence or a favorable partial inventory.

The original meter admits actual raw bytes, repeated original and relationship observations,
packed metadata, pages and absence before deep interpretation. Approval observations are individual
records; packed child counts remain metadata. Whole-subject absence charges one metadata record.
Exact limits pass, one unit below fails wholly, and caught failures leave the same meter tainted.
Lexical UTC times retain up to 30 fractional digits; native numeric ordering keys travel as text.
Original OIDC authentication receipt time remains milliseconds. No Date rounding changes lineage.

Provided-client helpers do not begin/commit or replace the caller's connection. The convenience
repository closes its own transaction before returning. **A detached census is not current
publication authority.** Stored synthetic OIDC receipts do not authenticate a real user.

## Verification and remaining work

The unchanged [shared conformance cases](../../packages/core/src/testing/release-approval-repository-conformance.ts)
run against native PostgreSQL. Additional native cases exercise multi-page all-action inventories,
caller backend/XID/savepoint, held absence/revocation/successor races, context/isolation/contention,
owner RLS across nonempty tables, corrupt normalized projections and deferred ordinal gaps with
whole rollback. Unit transport data captures synthetic PostgreSQL 16.15 observations; malformed
rows, canonical/normalized/lineage/intent damage, budgets, retry receipts, sticky failures and
connection cleanup are checked separately. Captured data is not an independent SQL oracle.

Recovery fixtures seed all five tables, including declarations, exception controls and revocation,
then compare restored originals, full kind/subject readback, canonical intent and first-receipt
retries. Existing role reprovisioning removes stale private access. Use only disposable
`proofstack_test`; fixture administrator privileges are not runtime approval authority.

No runtime role, default grant, public mutation, worker or scheduler is added. Current issuer,
reviewer and publisher authentication/authorization, separate roles, complete owning source and
absence closure, recovery epoch and DB validity must join the same held atomic decision/outbox
transaction. Bounded API/SDK, contributor service flow and independent checkpoint exit audit remain
required before checkpoint 4 acceptance, followed by checkpoints 5–7 and measurement-gated stage 5.
