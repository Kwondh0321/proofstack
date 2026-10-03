# Complete criterion status history reads

`CriterionStatusHistoryRepository.listCriterionSetStatuses` returns the complete status-record
inventory for one exact tenant/project/environment scope, ordered by status ID. Memory and
PostgreSQL share the same conformance cases and canonical response admission. PostgreSQL also
exposes `listPostgresCriterionSetStatusesOnClient` for a connection that already holds the source
barrier. Workflow 2 remains **2/7 accepted checkpoints**.
[Korean guide](workflow-2-criterion-status-history.ko.md).

## Completeness and finite admission

The reader deliberately scans the scope's status kind without filtering by an unvalidated JSON
criterion selector, effective time, lifecycle state or a caller-selected approved status. It keeps
different criterion roots, multiple drafts, branches, withdrawals, supersessions, expiry fields
and legitimately later control receipts. ID ordering is deterministic transport order, not a rule
for choosing authority. The request-owned interpreter must subsequently bind exact criterion
references and inspect their complete chains; it must not select a favorable or latest row.

Callers provide finite `maxRecords` and `maxRecordBytes` within the existing policy acquisition
ceilings. Zero records and the canonical empty array's two bytes permit an empty scope. PostgreSQL
uses a fixed `maxRecords + 1` lookahead. Overflow throws `CriterionStatusHistoryLimitError` and
returns no partial history. The shared validator checks every record's owning schema/digest,
exact scope, unique increasing ID and complete canonical UTF-8 array size. Returned records and
scope/limit inputs are owned across asynchronous boundaries. These are response admission limits,
not a statement about database transport buffers, query planning cost or execution deadlines.

A scope-wide scan can exhaust a request's budget because of other criterion histories in that
same authorized scope. That is an explicit conservative acquisition failure. An indexed or narrower
future design must prove equivalent complete discovery and normalized projection integrity before
replacing this reference behavior. No scale or throughput target has been established.

The shared acquisition meter now counts each returned history row as well as the read invocation,
including repeated reads. This prepares cumulative request accounting; it does not automatically
add a history lookup to artifact capture or durable retry accounting.

## Database integrity and transaction boundaries

The evaluation adapter now compares all owning normalized record columns with their canonical
body: identity/schema/scope/digest, original receipt and actor, resource, lifecycle/verdict,
run/attempt coordinates and unique lineage-reference count. It reuses the publication projection
and owning reference derivation across all 17 evaluation kinds. This is normalized **row** agreement,
not a new proof of every physical registry/edge/outbox relation or source truth.

The supplied-client function issues ordinary SELECTs without a new transaction, scope mutation,
row lock or connection release. A caller holding the [metadata barrier](workflow-2-policy-metadata-barrier.md)
can retain complete history absence/presence against concurrent participating writers. The ordinary
repository method owns and ends its own transaction. Neither returned list is a fresh publication
token. Future sealing must validate complete authority, current migration/epoch and live worker
lease/fence on the same held connection and commit snapshot/job state before releasing guards.
Existing [source recheck](workflow-2-policy-source-recheck.md) behavior is unchanged.

This increment does not interpret status transitions, choose a current head, resolve successor
criterion content, upgrade historical run eligibility, add a policy verdict, seal inputs or create
a worker/API. Those remain entry-audit requirements. An immutable predecessor or replacement record
must not be silently treated as a revocation rule.

## Verification

Shared memory/PostgreSQL cases cover exact scope, detached values, every retained branch/root,
future and terminal records, other criteria in the same scope, exact count/byte limits and
one-below failures. Pure admission rejects invalid limits, malformed/corrupt bodies, duplicate or
reordered IDs and substituted scope. Real PostgreSQL corruption fixtures change lineage count or
unexpected attempt columns while keeping CHECK constraints enabled, verify both exact and history
reads fail, then roll back all fixture changes. A real advisory-wait test proves a new withdrawal
cannot commit through a held metadata barrier, verifies history input ownership during the read,
and observes the additional record only after guard release. The cumulative-meter regression
rejects a repeated history read one record below its complete allowance.
