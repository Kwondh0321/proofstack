# Exact policy snapshot reads and shared store conformance

[English](workflow-2-policy-store-conformance.md) | [한국어](workflow-2-policy-store-conformance.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`PolicyEvaluationSnapshotReader` takes the exact scope, owning job definition, request and
snapshot references. `PostgresPolicySnapshotRepository` uses the existing fixed control-role
functions on bounded scoped connections. It verifies the original sealing attempt, canonical
job history and outbox intents before returning a header or page. A later attempt, completed
job or recovery epoch does not relabel the original seal. No SQL, migration, grant or role is added.

`readCompletePolicyEvaluationSnapshot` reads every advertised page sequentially, checks each
canonical descriptor and reconstructs the original definition. It then invokes the existing
complete semantic validator. Missing, substituted, reordered or foreign-scope material fails
closed; absence never selects another snapshot. Header integrity alone does not validate all
semantic inputs. Historical reads do not establish fresh source or execution authority.

The existing memory job store now retains original pages and results with their owning jobs.
Its trusted snapshot publisher requires complete configured version 0.2 inputs, exact request,
worker/fence, settled acquisition credit and history headroom. Its result publisher computes
from retained pages and requires prepaid whole-rule work on the live running attempt. Both
validate the final server clock after calculation and serialization, before the synchronous
state swap. Failure preserves preceding committed charges and changes no publication material,
job, history or intent. Exact completed retries retain the original result and receipts.
Memory state remains process-local and is lost on restart. The server composition must perform
source reinspection before invoking its trusted publisher; fixtures cannot provide that authority.

The same shared cases run unchanged against the real memory store and actual PostgreSQL:

- Complete original header/pages, copied outputs, exact absence and bounded page indexes.
- Atomic paid result, deciding attempt, terminal job, history and canonical intent.
- Original receipts on exact retry, with conflicting identity or worker rejected.
- Unpaid or substituted-page publication rolls back wholly.
- Cancellation retains the original seal and refuses result publication.
- Interrupted execution retains the same seal and prior charges; the new attempt pays again,
  rejects the stale worker and records its own deciding fence.

Backend-specific tests cover final-clock expiry/regression, unsettled credit, scope collisions,
native roles/RLS and source guards. The three configured synthetic memory fixtures were decoded
from actual disposable native stored pages, checked against their original input hashes and
validated without rewriting domain scopes or relationships; see their
[provenance](../../packages/core/fixtures/README.md). They are not provider truth or credentials.

This increment does not provide the separate worker executable, complete initial transport/list
admission, all-state restore acceptance, public API/SDK, real-service contributor flow or independent
checkpoint exit audit. Existing native storage, execution and publication boundaries remain in the
[snapshot storage](workflow-2-policy-snapshot-storage.md),
[result publication](workflow-2-policy-result-publication.md) and
[entry audit](workflow-2-policy-evaluation-entry-audit.md) guides. No human approval, release
authority or production readiness follows from this prerequisite.
