# Replay definition owning storage integrity

Owning target release and replay plan reads now validate their original complete
canonical publication intent on the supplied PostgreSQL connection. Plan reads
also check exact-scope normalized presence and child coordinates before returning
the canonical definition. Workflow 2 remains **2/7 accepted checkpoints**.
[Korean guide](workflow-2-replay-storage-integrity.ko.md).

## Original receipts and normalized children

Ordinary repositories and supplied-client readers share owning validation. The
existing fixed intent-status function checks the expected event, aggregate, schema,
complete payload and original creation time through existing grants. Semantic retries
keep their original receipts and private tenant-wide identity/conflict logic. Mutable
outbox delivery fields do not change the original canonical intent.

Found plans retain every existing scalar, resource, native receipt, budget and
boundary check. Child rows must also match the validated parent project, environment
and logical plan ID with native boolean projections. Selection retains all rows for
that tenant/version instead of filtering out damaged coordinates. Budgets return
at most the existing ten dimensions plus one overflow row; boundaries return the
validated body's count plus one. The strict plan contract has 1–64 boundaries.
Returned-row bounds do not promise bounded SQL scans, sorting, time or wire bytes.

## One-cut plan absence

One SELECT observes exact tenant/project/environment plan-body presence and
child-owned budget/boundary witnesses in the same database cut. Exactly one row
with two native booleans is required. Both absent returns opaque absence. Disagreement,
malformed flags or a body disappearing/changing scope after a positive cut fails.
Normal atomic publication following an absent cut preserves that first absence.
Outside scopes stop at the presence query without loading bodies or children.

Target logical resources do not bind an exact release version. Their existence,
parent-only references and outbox aggregate IDs alone cannot establish an absent
release's scope. Target reads keep their existing exact parent lookup; this slice
does not claim complete target absence closure or invent a resource-root protocol.

## Remaining boundaries and verification

Helpers use only SELECT on the supplied connection. No migration, grant, role,
dependency, route or worker is added. Shared private plan child loaders now reject
incorrect coordinates too; their publication/intent rules are otherwise retained.
Internal SQL/row admission, hard execution/transport limits, complete parent semantics,
reverse/live authority and sealed publication remain separate requirements. An ended
read-only transaction report cannot authorize later snapshot/job publication.

Actual PostgreSQL cases cover missing/wrong original intents, each child coordinate,
bodyless budget-only/boundary-only witnesses, outside scopes, normal publication
after an absent cut and privileged body removal after a positive cut. Forty extra
boundaries return only two rows for a valid one-boundary plan, then fail. Normal
trigger-enabled delivery updates preserve both owning definitions. Seven-table
fingerprints and original owning reads verify rollback. Explicit port-response
mutations reject nonboolean flags and malformed row counts; these are simulated
faults, not malformed types emitted by PostgreSQL. Existing repository conformance,
RLS, supplied-backend/barrier and original-receipt gates remain required.
