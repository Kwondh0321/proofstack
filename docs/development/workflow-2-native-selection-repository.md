# Native target-owned selection repository

[English](workflow-2-native-selection-repository.md) | [한국어](workflow-2-native-selection-repository.ko.md)

Status: checkpoint 4 native selection storage prerequisite; Workflow 2 remains **3/7 accepted
checkpoints**. Actual installation authority and complete native decision publication remain open.
See [ADR-0053](../architecture/0053-persist-complete-target-owned-policy-selections.md) and the
[entry audit](workflow-2-decision-entry-audit.md).

## Original ownership and atomic storage

[Migration 0065](../../packages/postgres/migrations/0065_release_policy_selection_storage.sql)
adds five private append-only tables for original target roots, immutable versions, ordered
policies/publishers and terminal lifecycle. Forced RLS uses all three scope coordinates. Deferred
constraints bind exact original roots, predecessor/successor references, complete projections and
canonical outbox intents. Publication of any incomplete graph fails wholly.

The [PostgreSQL adapter](../../packages/postgres/src/postgres-release-policy-selection-repository.ts)
implements the same trusted declaration port as the [memory reference](workflow-2-selection-repository.md).
It validates original canonical definitions before storage, reads back normalized graph/intent
before commit and preserves first receipts on equal intent retries. Version/target/lifecycle/
terminal conflicts cannot partially publish. Different tenants can reuse physical identities;
another project/environment cannot read a foreign declaration or take over its target owner.

This storage is internal. Constructing an administrative pool, writing an attributable actor or
passing an already computed census does not authenticate an installer or authorize a release.
No new runtime role, default capability, public POST, job or worker is added. Role provisioning
revokes these private functions/tables from PUBLIC and all existing managed roles, including
restored obsolete privileges. Policy evaluator read grants explicitly exclude these tables.

## Complete reads and retained guards

`readPostgresReleaseSelectionTargetOnClient` derives the owner from exact installation/gate
coordinates, acquires a shared tenant selection guard and reads every version and terminal event
through fixed 16-entry keyset pages. Future-effective versions, competitors and withdrawal history
remain visible. Missing target is one whole absence observation; broken indexes or normalized
records are integrity failures. No favorable prefix or mutable latest lookup is returned.

The guard uses a distinct C4 domain, with mandatory exclusive writer triggers on every inserted
selection record. Missing-target creation and later terminal events wait for the reader's
transaction. A contended reader fails without waiting or choosing another cut. The private
VOLATILE root function takes its READ COMMITTED observation after guard acquisition. The coarse
tenant granularity is a reference correctness choice, not a measured scale claim.

`readPostgresReleasePolicySelectionOnClient` and
`readPostgresReleaseSelectionLifecycleOnClient` inspect exact original records, normalized
relationships and canonical outbox intent. They do not acquire complete publication authority.
The target helper admits original raw bytes, packed record counts, absence and every repeated
relationship read on the original server-owned verification meter. Failure taints it, including
pool/transaction failure in the repository wrapper. Fake or previously tainted meters cannot
start new source I/O. Lexical UTC values retain up to 30 fractional digits; exact order keys travel
as strings rather than rounded JavaScript numbers. Native outbox timestamps remain projections.

Provided-client helpers require the caller's explicit scoped READ COMMITTED transaction. They do
not begin, commit, replace the connection or release its guards. The repository convenience read
ends its transaction before returning: **a detached returned census cannot authorize publication**.

## Verification and next boundary

The unchanged shared conformance suite runs against the real PostgreSQL repository. Native cases
exercise multi-page inventory, exact backend/XID/savepoint ownership, absence/lifecycle guard
races, contention, foreign/isolation rejection, forced owner RLS, whole outbox conflict and damaged
normalized storage. Runtime-role acceptance checks stale private grant removal. The unit transport
fixture contains actual synthetic PostgreSQL 16.15 wire records; it tests malformed projections,
receipt/canonical/lineage/intent substitutions, original budgets and rollback cleanup. It is not
an independent SQL oracle or a substitute for the required native suite.

The coordinated recovery fixture seeds original/successor selection versions and supersession
with every normalized table nonempty. It compares the full restored graph and canonical outbox,
then exercises owning complete reads and original-receipt retries after restore. This extends
the existing database/ciphertext/key rehearsal; complete decision authority recovery remains open.

Use only a disposable `proofstack_test` PostgreSQL instance. Keep all existing assertions,
coverage thresholds, migration checksum verification and required CI jobs. Native fixture
privileges are test-only; never give an API, reviewer or evaluator the migration connection.

Next implement reviewer and approval native persistence, separate least-privilege roles, actual
current installation/reviewer/publisher composition, complete source/absence guards and recovery
epoch on the same held connection through atomic decision/outbox publication. Recovery, bounded
API/SDK, real-service contributor flow and independent checkpoint exit audit still precede
checkpoint acceptance. Checkpoints 5–7 and measurement-gated stage 5 remain later work.
