# Policy source reads on a supplied PostgreSQL connection

Checkpoint 3 needs owning metadata validation on the connection holding the publication guards.
Opening another repository transaction would lose that protected database cut. The PostgreSQL
adapter now exposes the existing exact readers as supplied-client functions and routes ordinary
repository reads through those same functions. Workflow 2 remains **2/7 accepted checkpoints**.
[Korean guide](workflow-2-policy-source-client-readers.ko.md).

## Read inventory

| Domain | Supplied-client functions | Retained owning behavior |
| --- | --- | --- |
| Evaluation | `readPostgresEvaluationRecordOnClient` | All 17 kinds, canonical record/digest, normalized scope |
| Model/human assurance | `readPostgresModelAssuranceRecordOnClient` | All 13 kinds, canonical record/digest, normalized scope |
| Comparison | `readPostgresComparisonRecordOnClient` | Definition, operand snapshots and result; normalized projections and lineage count |
| Candidate | `readPostgresReleaseCandidateOnClient` | Exact immutable candidate and normalized projections |
| Dataset/fixture | `readPostgresDatasetVersionOnClient`, `readPostgresFixtureVersionOnClient`, `readPostgresRecordedInteractionFixtureVersionOnClient`, `readPostgresRecordedInteractionFixtureContentOnClient` | Identity-first scope filtering, normalized ordered members/events; recorded fixture ownership/root binding and canonical publication intent; revocation/tombstone/catalog metadata for content availability |
| Replay definitions | `readPostgresReplayPlanOnClient`, `readPostgresTargetReleaseOnClient` | Exact resource, definition, budget and boundary projections |
| Replay job | `readPostgresReplayJobSnapshotOnClient` | Existing fixed database snapshot function and complete job/attempt/fence/history validation |
| Trace | `listPostgresTraceEvidenceOnClient`, `resolvePostgresExactEventsOnClient` | Exact scope, cursor presence, bounded page lookahead, ordered exact event resolution and stored envelope validation |

The earlier artifact catalog and policy/version/lifecycle supplied-client readers remain available.
Static runtime definitions remain operator-owned catalogue inputs, not new PostgreSQL records.
The recorded fixture **content** reader returns database ownership and availability metadata;
it does not fetch object bytes, decrypt content or contact a key service.

## Caller responsibilities

### Guarded repository ports

`PostgresPolicySourceTransactions.runMetadata` provides fixed repository-shaped reads for the
complete 44-kind record graph, exact trace events, complete criterion status history and recorded
fixture ownership/availability metadata. It acquires the tenant metadata barrier and verifies the
current bundled migration ledger on the same READ COMMITTED connection **before invoking the
callback**. This mode is separate from the existing optional artifact-capture `sourceTransactions`
recheck; that capture does not automatically invoke complete graph reinspection.

Every nested port checks its requested tenant/project/environment against the transaction's owned
scope before SQL. Invalid scope, identifiers, model kinds or exact event selections fail wholly;
trace IDs and the bounded unique event array reuse their owning contracts. Ports expire before
connection release. Caught or unawaited read failures still taint the transaction; started work is
drained before commit/rollback and cleanup. No pool, SQL/client, DML, content/key, worker or
publication interface is exposed. Each domain retains its existing owning validation; this mode
does not newly prove physical registry/lineage/outbox agreement or all model-assurance projections.

The adapter copies strict operator-owned installation bindings and runtime definitions at
construction, outside transaction guards. Each catalogue admits at most 256 entries; duplicates
or invalid records fail before connecting. These immutable in-process records are distinct from
participating database metadata and live installed-code authority. The callback receives only
their lifetime-bound exact read ports, with no external discovery or arbitrary resolver injection.

Trusted composition can run the existing bounded `capturePolicyTraceEvidence` with `ports.records`
and `ports.evidence` while the metadata barrier remains held. The composer meters actual repository
responses; the adapter does not introduce a second response meter. Additional history/content
metadata reads need that same cumulative request budget. This is not a hard SQL execution deadline
or streamed transport bound. Callers must keep object/key/filesystem I/O outside guards and
abandon the whole transaction if any later required artifact/policy guard cannot be acquired.

This increment exposes the protected owning reads; it does not implement request-owned full
before/after graph comparison, complete semantic/authority closure, worker lease/fence validation,
sealed contracts or atomic publication. The read-only transaction ends before returning its result.
Future publication must retain all required guards in the same still-open transaction through
complete validation and atomic snapshot/job mutation. Returned metadata is never later seal authority.

### Supplied-client helpers

These are trusted adapter building blocks accepting `Pick<PoolClient, "query">`. They neither
connect/release nor begin/commit/rollback, change scope GUCs or acquire guards. This TypeScript
shape is not a SQL sandbox or public worker port. The caller owns authorization, exact transaction
scope, READ COMMITTED isolation, migration/recovery/resource guards, finite cumulative budgets,
failure taint, cancellation/draining and whole rollback. A helper's rejected promise leaves that
cleanup to the caller and must not be caught as permission to publish.

Scope, event-ID arrays and page cursors/limits are owned before the first asynchronous boundary;
ordinary repository wrappers also own them before pool acquisition. Returned records retain the
existing validation and detached-result behavior. The evaluation reader's return type follows
its fixed record kind. Publication paths retain their tenant-wide conflict and lineage queries.
No SQL migration, runtime grant or external dependency is added.

Each helper preserves its owning reader's actual checks. An exact record read does not newly
prove every reverse history, logical selector, upstream absence or publication intent. In
particular, the recorded fixture reader's intent check is not a claim that all domain readers
already check intents. The complete closure/authority protocol must explicitly derive and inspect
those dependencies on the held connection.

The [metadata barrier](workflow-2-policy-metadata-barrier.md) protects the source write domain but
does not run these readers itself. Future composition must collect external content outside guards,
then re-read complete metadata, compare retained observations, validate closure and the live worker
lease/fence, and atomically publish snapshot/job state before releasing guards. The existing
[source recheck](workflow-2-policy-source-recheck.md) still ends its transaction before returning
`observations_rechecked`; neither that report nor a set of helper results is a seal or fresh
publication authority. Sealed contracts, complete authority histories, worker ports and publication
remain separate entry-audit requirements.

## Verification

`policy-source-client-readers.integration.test.ts` uses real PostgreSQL and forced-RLS API reads
inside an owner-acquired metadata barrier. It covers all 17 evaluation, 13 model/human and three
comparison kinds, each scope dimension, missing records, unchanged backend/transaction identity,
surviving savepoints and exclusion of another metadata publisher. Uncommitted candidate and trace
inserts are visible on the supplied backend and disappear on caller savepoint rollback. Missing
dataset/fixture/replay reads use the same held connection. Existing real repository conformance
continues through these extracted readers, including positive normalized dataset/fixture/replay
graphs and corruption cases. Unit regressions mutate caller inputs across query/pool awaits and
check original-error propagation without transaction cleanup by a helper. No throughput or
production availability claim follows from these checks.

The guarded repository mode additionally routes all evaluation/model/comparison fixtures through
the same backend under the existing forced-RLS API read role, keeps dataset/fixture/replay absence
inside the barrier, validates exact event order and complete envelopes, and blocks an absent
candidate's concurrent publication until guard release. A caught scope escape rolls back without
source SQL; retained nested ports cannot run after return. Unit cases cover guard/ledger failure
before callback, every fixed read route, invalid/bounded exact inputs, copied static catalogues,
scope/array ownership and draining unawaited successful/failed nested reads. The admin fixture's
private-guard acquisition does not grant the API role private guard or future worker authority.
