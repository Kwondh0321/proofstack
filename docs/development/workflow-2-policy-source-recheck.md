# Request-owned guarded policy source recheck

[English](workflow-2-policy-source-recheck.md) | [한국어](workflow-2-policy-source-recheck.ko.md)

Status: optional, trusted read-only reinspection integrated into authorized artifact capture.
Workflow 2 remains **2/7** accepted checkpoints. This is not a snapshot publisher, worker,
lease/fence, policy result, release approval or a token of freshness after transaction completion.

## Ownership and connection

`capturePolicyArtifactEvidence` accepts one optional server-owned `sourceTransactions` or
`metadataTransactions` dependency. Supplying both fails after authorization and before content I/O.
Without either, capture retains its existing observation/guard-plan behavior and has no `sourceRecheck`
field. Unavailable roots never start a source transaction or report a successful empty recheck.
The request cannot supply a transaction, guard subset, graph, SQL, source URL or publication callback.
The composer still requires independently authorized metadata/trace ports and an authenticated
artifact principal. No HTTP route, SDK option, database role or runtime grant is introduced.

The fixed internal composer derives the [complete request-owned plan](workflow-2-policy-source-guard-plan.md)
after object/key I/O. It sequentially tries every known artifact/policy guard before any authoritative
source read. Only the literal boolean `true` succeeds. False, malformed results, errors and admission
failure abort the whole observation transaction; there is no savepoint, partial result, unguarded
fallback or automatic retry.

`PostgresPolicySourceTransactions` implements composer-owned read-only ports. It snapshots exact
tenant/project/environment before connecting, explicitly begins READ COMMITTED before scope SELECTs,
sets only transaction-local scope and uses the existing private migration-0050 guard function.
The [normalized source readers](workflow-2-policy-transaction-reads.md) use that same connection and
retain all owning adapter validation. Pool/role isolation defaults cannot create a stale pre-lock
repeatable-read snapshot. Commit/rollback clear the scope without changing the session default.

The source-only ports expose `tryMetadataGuard`, `tryGuard`, `findCriterion`, `listCriterionSetStatuses`,
`findArtifact`, `findPolicy`, `listPolicyHistory` and `observationTime`. They do not expose a client,
caller SQL, DML, content/key I/O or publication.
Their lifetime ends before transaction cleanup. Started reads are drained before commit/rollback
and connection release. A caught or unawaited port failure still taints the whole operation; later
calls cannot query. A rollback failure preserves the original error and destroys the connection.
Draining a hung query is not a statement timeout, job deadline or cancellation mechanism.

### Complete retained graph/trace mode

`metadataTransactions` uses `PostgresPolicySourceTransactions.runMetadata`, which admits the tenant
metadata barrier and current migration ledger before its callback. The fixed composer then acquires
all original artifact/policy resource guards before any graph, trace, catalog or history re-read.
It uses the [owning metadata ports](workflow-2-policy-source-client-readers.md) on that same held
connection and the original cumulative acquisition budget. No content/key I/O is repeated under guards.

Each newly read parent and selector-prefetched record must match its original observation and full
verified receipt before following descendants. Ordered edges and selector outcomes must agree before
enqueueing targets; newly created missing records and newly resolved selectors cannot expand a new
unguarded artifact/policy frontier. Complete derived graph/comparison material, exact trace envelopes
and repeated artifact occurrences must agree. Stable unreadable observations remain explicit; equal
unavailable classifications do not prove equality of discarded invalid bytes. Revision mismatches
use the existing source-recheck error; budget and storage failures retain their own errors.

Existing catalog, root policy lifecycle and complete criterion history/known successor inspections
run within the same transaction. Complete history inventories still compare before reading a new
successor. Optional `sourceRecheck.metadata` counts retained record/trace observations and actual
graph/selector and trace re-reads. Graph read counts can include policies/criteria also inspected by
the separate source counters; node inventory size is not a repository-read count. A metadata barrier
does not imply a criterion-history read when no criterion authority was observed.

Real PostgreSQL tests use stored candidate/policy roots and explicit missing upstream evidence,
including actual missing-dataset creation, competing publication waits and barrier-conflict cleanup.
Object bytes remain authenticated memory fixtures in these tests, not additional S3 acceptance.
The report is historical as soon as its read transaction ends: a waiting publisher can create a
previously missing source immediately afterward. This mode does not close all mutable/reverse/logical
authority, physical registry/lineage/outbox integrity or live installation/worker authority. Complete
sealed contracts and atomic snapshot/job/fence publication remain required before checkpoint acceptance.

The acyclic workspace dependency is `postgres -> policy-evaluation -> artifacts/core/contracts/datasets/replay`.
Owning validators do not move into PostgreSQL and the composer does not import persistence.
[ADR-0026](../architecture/0026-recheck-policy-sources-through-scoped-transaction-ports.md)
records this dependency change. Existing API credentials are denied guard-function execution;
constructing an adapter does not confer dedicated worker or snapshot authority.

When the request graph requires criterion authority, the composer first acquires the private
[0052 metadata barrier](workflow-2-policy-metadata-barrier.md), including migration/recovery
coordination, before all resource guards. The adapter loads bundled migration files before
connecting and validates the complete current ledger on the guarded connection. New criterion
and complete-history reads reject before SQL unless that acquisition and verification succeeded.
A false/invalid barrier or ledger failure taints and rolls back the whole transaction. Graphs
without criterion sources retain the original artifact/policy protocol; `not_required` does not
prove unavailable upstream parents have no criteria.

## What is compared under the complete installed-domain guard set

- Read each unique policy version once, including known missing versions and retained successors.
  Reinspect graph policy nodes at the exact request semantic time and compare complete observations.
- Read each unique supported artifact catalog once. Reuse the owning authorized catalog inspector
  and compare the complete catalog hash/public metadata/ownership plus time-dependent observation.
  A malformed `undefined` read is not normalized into known absence.
- Unsupported content descriptors still retain their known guard coordinate, but remain unqueried
  by the managed catalog reader. Missing/unavailable/repeated occurrences stay in the original capture.
- Re-read the root's complete terminal history. Compare it before successor resolution, so a newly
  introduced successor is never queried without its guard. Reuse owning lifecycle validation on
  the cached guarded records and compare full event/successor observation hashes.
- Re-read complete criterion status history and compare every retained row before querying any
  successor. Read each known criterion and already retained successor uniquely on that connection;
  compare graph observations and complete control-read material, including full receipt hashes.
  Preserve the original criterion and status selections; no newer approval replaces them.
- Obtain the database clock after the metadata reads, while all guards remain held. Reject an invalid
  cut or one preceding capture-phase completion. Preserve its native precision for artifact receipt
  and exact expiry comparisons. Existing policy/event and fixture-ownership receipt contracts remain
  milliseconds; this change does not admit microsecond ownership records.

The internal criterion interpreter uses the exact UTC database cut without passing through Date.
`criterionAuthority.underGuards` retains its own history/control reads and policy/capture-time
projections alongside both content-phase observations. A status becoming effective or expiring
between those cuts changes the projection even when stored material is identical. Its `completedAt`
and `atCapture.at` equal the held database cut; they do not promise authority after it.

A previously byte-verified artifact, missing object or failed content-integrity observation must
reinspect as `content_pending` with the same complete catalog. That means catalog eligibility for
the retained content attempt, **not another content verification**. No object fetch, key lookup or
decryption is performed under database guards. Other explicit absence/unavailability observations
must remain identical. A changed state, receipt, encryption metadata, ownership, expiry, policy
record or terminal event yields `source_revision_changed`.

The catalog-only inspector now accepts the existing full-precision UTC evaluation-time format for
its trusted observation cut. Initial content acquisition still uses the existing millisecond Date
clock. The aggregate completion is the later of the monotone host clock and the exact database cut;
it cannot precede its contained recheck observation. The final retained-content expiry check still
runs after this phase. A later change does not retroactively make this report a sealed revision.

## Shared admission and output

The same invocation-wide acquisition meter covers guard-port calls, normalized source reads,
complete history response rows/JSON and the database clock response. It does not reset after graph,
trace or object acquisition. The guard array's canonical bytes were already admitted during plan
derivation. No new source-reference occurrences or repeated object charges are invented by reinspection.
Exact remaining capacity succeeds; one record or byte less fails rather than skipping a guard/read.

These are logical port-operation/raw-response counts, not every SQL statement inside a normalized
reader, driver buffer allocations, hidden transport retries or measured database execution time.
A throwing invocation has no success usage envelope; durable failure/retry accounting remains a
future worker obligation. Finite counts and JSON limits do not replace statement deadlines.

Successful optional output is `sourceRecheck` with status `observations_rechecked`, exact `observedAt`,
guard count and unique artifact/policy read counts. Additional fields are `metadataGuard`,
`criterionReads`, `criterionHistoryReads` and `criterionHistoryRows`. The shared meter charges
every reread history row and repeated interpreter reference; cached interpretation does not charge
the actual reads twice. The metadata flag is false and all criterion counters zero when no
criterion source is captured. The output contains no plaintext, key, locator, seal, snapshot digest,
evaluator verdict, live execution fence or new capability. Typed composition failures use
`policy_evaluation_source_recheck_failed` with reasons `guard_unavailable`, `guard_invalid`,
`source_revision_changed` or `clock_invalid`; owning integrity/storage/admission errors retain
their own failure. This report returns **after the read-only transaction has ended**.

## Verification and still-open publication requirements

The [public composition tests](../../packages/policy-evaluation/src/capture-artifact-evidence.test.ts)
exercise real memory repositories/authenticated encryption, all-guards-first order, whole failure,
catalog/policy/history changes, malformed absence, later successors, unsupported coordinates,
retained failed content attempts, precise cuts, root failure and shared exact-limit admission.
The [adapter unit suite](../../packages/postgres/src/postgres-policy-source-transactions.test.ts)
checks one connection, exact scope, isolation, strict guard responses, taint, lifetime, deferred
read draining, migration-ledger failure, required metadata admission and rollback failure.
The [PostgreSQL composition suite](../../packages/postgres/src/postgres-policy-source-transactions.integration.test.ts)
uses actual catalog/policy/lifecycle and criterion/history adapters, guards and competing writes.
The criterion scenarios seed synthetic control/execution records using an isolated admin fixture;
existing API credentials still cannot publish execution records. It observes advisory
waits via `pg_blocking_pids`, rejects committed intervening changes and known-absence creation,
proves rollback releases earlier guards, checks pool reuse and existing runtime permission denial.
Its privileged observation pool is a disposable test fixture, not production worker provisioning.
Candidate/remaining upstream fixtures and encrypted memory objects are explicit: this is not a complete
real-service sealed-policy acceptance flow or a new S3 integration test.

The conditional metadata barrier protects the installed tenant source-write domain, while this
composer rereads only artifacts, policies and captured criteria/status history. It does not close
every upstream absence, selector, logical root, mutable source authority or complete semantic
lineage. Before publication, a future trusted publisher must keep every required
guard **in the same still-open transaction**, validate all remaining closure and execution
lease/fence conditions, and atomically publish snapshot and job state. It must not accept this
post-transaction report as fresh authority or release guards between reinspection and publication.
Current installation/migration verification, dedicated worker privileges, snapshot contracts,
pure predicates, durable retry/deadline/cancellation accounting, recovery, API/SDK and independent
end-to-end acceptance remain open under the [entry audit](workflow-2-policy-evaluation-entry-audit.md).
