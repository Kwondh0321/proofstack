# Model and human assurance scalar projection integrity

An isolated PostgreSQL reproduction found that the existing model-assurance publication function
accepted a valid profile body with a null normalized actor. The body retained its publisher and
canonical digest, and the owning reader accepted it. SQL equality checks could evaluate to
`UNKNOWN`, which a CHECK constraint accepts. Checkpoint 3 requires agreement between authoritative
records and their stored projections. Workflow 2 remains **2/7 accepted checkpoints**.
[Korean guide](workflow-2-model-assurance-projections.ko.md).

## Forward database validation

Migration `0053_model_assurance_scalar_integrity` adds a validated parent CHECK across all 13
model/human assurance partitions. It compares identity, schema, scope, digest, original receipt,
actor and lifecycle with the body and requires the complete conjunction to be `IS TRUE`. Required
actors and lifecycle states cannot be null. The existing native timestamp/lexical receipt checks
remain active. The migration changes no record, old migration, function, grant or runtime role.

Normal null cases remain valid: blinded-plan, human-review-protocol, model-evaluator, model-profile
and model-qualification-suite definitions have no lifecycle state; the model-assurance assessment
has no actor projection. These are explicit kind-specific cases, not permission to discard a
required publisher, reviewer, executor or recorded lifecycle.

The migration validates existing rows before recording its ledger entry. An inconsistent old
row prevents the migration wholly; its body, receipts, graph, outbox and previous migration ledger
remain intact. There is no backfill that guesses a receipt or silently repairs evidence. Diagnose
that retained inconsistency through the owning evidence process before retrying an upgrade.
Existing [migration and tenant boundaries](../architecture/0005-postgresql-tenancy-and-migrations.md)
and migration/recovery coordination are unchanged.

This is scalar projection validation. PostgreSQL does not newly execute the complete TypeScript
schema, canonical digest, semantic assurance algorithms or current authority checks.

## Owning reads

`readPostgresModelAssuranceRecordOnClient` and the ordinary repository share the same validation.
They compare the complete scalar projection with the strict, canonically validated body, reusing
the publication's 13-kind projection map. Original receipt text must match, and the database-native
timestamp comparison must return the boolean `true`; truthy strings and rounded Date comparisons
are insufficient. Existing model/human receipt contracts still use milliseconds. Full-precision
policy database-cut observations remain a separate clock boundary.

Exact reads filter normalized tenant/project/environment in SQL before parsing a body or casting
an outside-scope receipt. A damaged record in another project/environment therefore remains opaque
absence. Publication keeps its tenant-wide kind/ID conflict lookup and validates an existing row
before accepting an identical retry. Helpers still use only the supplied connection and neither
start/end transactions nor acquire guards, change scope or release the connection.

These checks do not prove complete physical registry/lineage/outbox agreement. In particular, the
model-only logical reference helper is not the complete cross-domain physical reference inventory;
its length must not be substituted for the stored physical lineage count. Reverse histories,
mutable/live authority, complete closure, worker leases/fences, sealed contracts and atomic
snapshot/job publication remain open. Returned read reports still end before publication authority
could be exercised; the same-transaction guarded/sealed protocol remains required.

## Verification

Real PostgreSQL runtime-role cases omit every required actor and lifecycle across control,
model-worker and human-review publication. Rejection leaves registry, body, lineage and outbox
unchanged; subsequent valid publication and exact read succeed. Missing canonical scalar fields
cannot exploit SQL `UNKNOWN`. Supplied-client cases use real backend responses with deliberately
false or text-typed receipt projections, and damaged body reads remain null outside each scope.

Isolated upgrade cases preserve all 13 valid legacy kinds, complete stored rows, original receipts,
historical checksums and function privileges. The installed parent plus 13 partition constraints
are validated, and repeat migration is idempotent. A legacy null-actor mismatch is rejected by the
owning reader before upgrade and prevents migration without changing retained state or advancing
the ledger. Existing forced-RLS supplied-client coverage reads all 13 kinds under the metadata
barrier. These fixtures establish no production readiness or additional checkpoint acceptance.
