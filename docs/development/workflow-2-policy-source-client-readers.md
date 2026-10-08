# Policy source reads on a supplied PostgreSQL connection

Checkpoint 3 needs owning metadata validation on the connection holding the publication guards.
Opening another repository transaction would lose that protected database cut. The PostgreSQL
adapter now exposes the existing exact readers as supplied-client functions and routes ordinary
repository reads through those same functions. Workflow 2 remains **2/7 accepted checkpoints**.
[Korean guide](workflow-2-policy-source-client-readers.ko.md).

## Read inventory

The [evaluation owning storage guide](workflow-2-evaluation-storage-integrity.md) records shared
singular/history/retry validation, original receipts and remaining root admission, authority and
sealing requirements.

The [comparison owning storage guide](workflow-2-comparison-storage-integrity.md) records the three
kinds' fixed positional lineage, original intent, logical root and normalized presence checks.

The [dataset/fixture storage guide](workflow-2-regression-storage-integrity.md) records exact
logical roots, original intents, shared-format presence and remaining internal root admission.

| Domain | Supplied-client functions | Retained owning behavior |
| --- | --- | --- |
| Evaluation | `readPostgresEvaluationRecordOnClient` | All 17 kinds, canonical/scalar/native receipt agreement, selected physical registry/lineage/resource/root/unique binding, original intent and same-cut normalized presence |
| Model/human assurance | `readPostgresModelAssuranceRecordOnClient` | All 13 kinds, canonical record/digest, exact scope, full scalar identity/schema/receipt/actor/lifecycle agreement, selected physical registry/lineage and original intent |
| Comparison | `readPostgresComparisonRecordOnClient` | All three kinds, normalized/native receipt agreement, selected registry/positional lineage/resource/root, original intent and same-cut normalized presence |
| Candidate | `readPostgresReleaseCandidateOnClient` | Exact immutable candidate, normalized/native receipt, selected registry/lineage/resource/root, original intent and scoped normalized absence witnesses |
| Dataset/fixture | `readPostgresDatasetVersionOnClient`, `readPostgresFixtureVersionOnClient`, `readPostgresRecordedInteractionFixtureVersionOnClient`, `readPostgresRecordedInteractionFixtureContentOnClient` | Exact scoped/shared-format presence, normalized ordered members/events, logical resource/root and original intent; recorded ownership and revocation/tombstone/catalog metadata |
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
does not newly prove physical registry/lineage/outbox agreement. The subsequent
[model/human scalar validation](workflow-2-model-assurance-projections.md) strengthens owning
row checks without establishing complete physical reference agreement or current authority.
The subsequent [model/human physical validation](workflow-2-model-assurance-storage-integrity.md)
adds those thirteen kinds' selected cross-domain registry/lineage and original intent checks to
the same owning reads, without proving every domain's graph or complete current authority.

The subsequent [candidate storage validation](workflow-2-candidate-storage-integrity.md) adds its
selected registry/predecessor/resource/root and original-intent checks plus scoped normalized
orphan witnesses. Complete absence, first-publication chronology, authority and sealing remain open.

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

The internal request-owning graph/trace composers now accept their own retained capture for
reinspection. Before traversing references they compare each owning read and full verified receipt
against the original observation, then compare each ordered edge and selector outcome before
enqueueing targets. Selector-prefetched records are compared immediately. Missing-record creation,
changed receipts and changed selector outcomes fail before following newly introduced descendants.
Complete derived graph/comparison material, exact trace envelopes and all repeated artifact
occurrences must still agree. Stable missing/unavailable observations remain explicit; unchanged
unreadable observations do not prove equality of discarded invalid bytes.

Reinspection reuses the invocation's cumulative acquisition budget: every actual re-read and
repeated owning inspection consumes its original finite limits. Cumulative usage is excluded from
material equality only. Revision failures remain distinct from storage and budget failures. The
retained-input composers and matchers are not package-root exports or public request contracts.

Artifact capture's alternative optional `metadataTransactions` now invokes these graph/trace
comparisons after acquiring all request-owned artifact/policy guards on the same held metadata
connection, then performs its catalog/policy/criterion reinspection. The old `sourceTransactions`
mode remains source-only; supplying both modes fails before content I/O. See the
[composition and report boundaries](workflow-2-policy-source-recheck.md).
Complete semantic/mutable authority and physical integrity closure, worker lease/fence validation,
sealed contracts and atomic publication remain open. A successful internal comparison alone does
not establish any guard. The read-only transaction ends before returning its result.
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
Runtime grants and external dependencies remain unchanged. The subsequent model/human scalar
integrity migration validates old and new rows without changing the helper transaction boundary.

Evaluation's seventeen kinds, comparison's three kinds, candidates and the two replay definitions
now filter normalized tenant/project/environment and immutable ID in the first SQL read, before
parsing the canonical body or evaluating returned native timestamp projections. An outside-scope
row remains opaque absence even if its retained body is damaged. A replay plan outside the requested
scope does not load its budget or boundary rows. Found rows still undergo all owning canonical and
normalized checks, including canonical-versus-normalized scope agreement; exact-scope damage remains
an error. Private publication loaders deliberately omit the optional exact-scope filter so tenant-wide
immutable identity conflicts and owning lineage failures remain visible to publication. This change
adds no scope GUC mutation, role, grant, migration, public route or new transaction.

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

`source-read-scope-integrity.integration.test.ts` publishes the evaluation/comparison/candidate
fixtures through their existing API or execution roles. It covers all twenty-one kinds with ordinary
exact/outside reads, absent IDs and API-role supplied-client reads after administrator-only disposable
damage. Each tenant/project/environment mismatch returns no row; an exact-scope damaged definition
still fails. Fingerprints and original owning reads verify complete rollback. The replay definition
suite separately covers both definitions and damaged subordinate budget/boundary sets: outside
reads stop after the empty parent lookup, while exact-scope damage fails. These are damaged-storage
regressions, not a claim that normal runtime roles can mutate immutable records. Existing publication
conformance still exercises tenant-wide identity conflicts and original receipts.

The guarded repository mode additionally routes all evaluation/model/comparison fixtures through
the same backend under the existing forced-RLS API read role, keeps dataset/fixture/replay absence
inside the barrier, validates exact event order and complete envelopes, and blocks an absent
candidate's concurrent publication until guard release. A caught scope escape rolls back without
source SQL; retained nested ports cannot run after return. Unit cases cover guard/ledger failure
before callback, every fixed read route, invalid/bounded exact inputs, copied static catalogues,
scope/array ownership and draining unawaited successful/failed nested reads. The admin fixture's
private-guard acquisition does not grant the API role private guard or future worker authority.
