# Native reviewer declaration repository

[English](workflow-2-native-reviewer-repository.md) | [한국어](workflow-2-native-reviewer-repository.ko.md)

Status: checkpoint 4 native reviewer declaration storage prerequisite. Workflow 2 remains **3/7
accepted checkpoints**. Actual issuer authorization, current approval/decision publication and
checkpoint exit acceptance remain open. See [ADR-0054](../architecture/0054-persist-complete-reviewer-authority-declarations.md),
the [memory/shared guide](workflow-2-reviewer-authority-repository.md) and
[entry audit](workflow-2-decision-entry-audit.md).

## Immutable declarations and exact ownership

[Migration 0066](../../packages/postgres/migrations/0066_release_reviewer_authority_storage.sql)
adds private normalized roots, original versions, role/group memberships, declarations, basis
references and terminal events. The first original fixes the exact installation/gate/reviewer
within its full scope. Another reviewer may own a separate root at the same gate; another project
or environment cannot acquire an existing target. Different tenants may retain colliding IDs.

Deferred exact-scope foreign keys, complete ordered projections, canonical definition bytes/hash,
native receipt order and canonical outbox intent bind the whole stored graph. Self-issued or
forged canonical records fail owning validation. Publication and terminal intent retries preserve
the first receipt. Changed bodies, target reassignment, missing/mismatched predecessors/successors,
causal time errors and second terminals fail wholly. All six tables are append-only with forced
RLS; the owner fixture also remains subject to RLS.

The [adapter](../../packages/postgres/src/postgres-release-reviewer-authority-repository.ts)
implements the existing trusted declaration port. It preserves original `synthetic_reference`,
`operator_verified`, `verified`, `unverifiable`, `rejected`, relationship/conflict/reason text,
memberships and complete original artifact references. These labels and hashes do not verify
expertise, authenticate an issuer or establish that basis content is currently available.
No new runtime role, default grant, route, job or worker is introduced. All existing runtime
credentials lose private table/function privileges during provisioning, including stale restored
grants. An administrative migration pool is never an API/reviewer/worker credential.

## Complete owning reads and held guards

`readPostgresReleaseReviewerTargetOnClient` derives its original root through an exact
installation/gate/reviewer target. A distinct coarse tenant reviewer guard protects every target,
version and terminal absence; mandatory writers retain the exclusive guard until transaction end.
The private VOLATILE root function observes READ COMMITTED state after shared guard acquisition.
Reader contention fails the whole cut without waiting for a favorable retry. This granularity
is a reference correctness choice, not a performance or availability measurement.

Fixed 16-entry keyset pages retain every future-effective/competing version and all revocation/
supersession history. No verified/current filter, latest lookup or caller-selected logical root
is used. Exact readers re-encode canonical definitions and compare normalized fields, ordered
memberships/declarations/basis, root/parent identity, full native causal history and outbox intent.
Broken sources fail instead of returning a favorable incomplete inventory or ordinary absence.

The original server-owned meter admits actual raw bytes and packed observation counts before deep
interpretation, including repeated reads and absences. Limits never return a truncated census;
caught failures taint the same meter. Fake/failed meters cannot begin new source acquisition.
Lexical UTC receipt text retains up to 30 fractional digits and numeric order keys are projected
as strings. Native outbox timestamps are projections, not the semantic ordering oracle.

Provided-client helpers neither begin/commit nor replace the caller's explicit scoped connection.
Their guards remain held for that caller. The repository convenience method closes its own
transaction before returning: **a detached census cannot authorize later publication**.

## Verification and remaining work

The unchanged [shared conformance cases](../../packages/core/src/testing/release-reviewer-authority-repository-conformance.ts)
run against real PostgreSQL. Native cases cover complete multi-page reads, backend/XID/savepoint
ownership, absence/revocation races, exact context/isolation/contention, owner RLS, normalized
corruption and deferred ordinal gaps with whole rollback. Unit transport fixtures capture actual
synthetic PostgreSQL 16.15 observations and exercise original/canonical/projection/intent damage,
exact/one-below budgets, caught failures and connection cleanup. They do not replace native
locking/SQL evidence or constitute an independent SQL oracle.

Recovery acceptance seeds every new normalized table, compares complete restored originals and
canonical outbox, then checks owning census/readback and first-receipt retries. Existing migration
checksum, role reprovisioning and whole recovery assertions remain. Use disposable `proofstack_test`
only; fixture privileges are test-only. Keep existing test assertions and coverage thresholds.

Next implement native approval storage and separate roles, actual issuer/reviewer/publisher
authentication, current basis/control/source/absence closure, recovery epoch and one still-held
atomic decision/outbox boundary. Bounded API/SDK, contributor flow, complete recovery and independent
checkpoint exit audit remain required. Then enter checkpoints 5–7 and measurement-gated stage 5.
