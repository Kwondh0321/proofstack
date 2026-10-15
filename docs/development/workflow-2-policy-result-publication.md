# Native atomic policy result publication

The later [exact reader and shared store conformance](workflow-2-policy-store-conformance.md)
implements memory persistence and unchanged memory/native cases. Remaining checkpoint gates
are recorded there; the historical prerequisite boundary below remains distinguishable.

Workflow 2 checkpoint 3 remains open. Migration 0060 and
`PostgresPolicyEvaluationResultRepository` publish one immutable result from an owning
running job's original stored snapshot and complete retained pages. The internal port
accepts exact scope, the worker fence, a result identity and original pages. It accepts
neither computed rule outcomes nor a caller clock, SQL client or replacement snapshot.

The adapter locks and validates the job, its exact history and canonical intents on one
bounded scoped connection. Before computation, it checks the live native execution budget
and prepaid work for every ordered rule. It reads the original snapshot on that connection,
validates the complete page set, computes all evidence with the sealed-input calculator,
and binds the canonical definition to the immutable request and snapshot. A cancelled,
foreign, stale, expired, unsealed or insufficiently prepaid attempt cannot publish.

The evaluator-only fixed SQL function inserts the immutable result, closes the same
computing attempt and makes the job terminal. The adapter appends one replayable `complete`
history entry and canonical terminal outbox intent before committing the same transaction.
Failures leave the original running graph, history and result storage unchanged. Result
storage has exact-scope forced RLS, normalized/canonical projection checks, append-only
protection and no runtime DML grants. API, policy author, policy control and upstream worker
roles do not receive the publication function's execution grant.

A deferred result trigger retains the original native lease, attempt deadline and job
deadline independently of the completed job's cleared lease. It rechecks the recovery epoch,
terminal result binding and canonical intents at final commit. Clearing a lease during
completion therefore cannot authorize a commit after that lease expires. The existing
deferred history constraint also requires the job and its final history to agree.

An exact retry of an already committed result preserves its original definition, receipts,
closed attempt, graph, history and outbox. It checks the original fence and canonical
intents without granting a fresh execution window. A different result identity or definition
conflicts. An authoritative result read derives its expected subject and original fence from
the owning completed job and closed attempt, reads the original stored snapshot, and
recomputes every rule's expected evidence from complete retained pages. A coherent digest
alone cannot certify substituted rule evidence or a substituted receipt.

The native regression suite covers atomic publication, insufficient work, conflicting outbox,
cancelled work, direct publication without history/intent, expiry before deferred commit,
exact retry after expiry and least-privilege grants. A separate fault-injecting transport
suite checks malformed native responses, changed completion/retry graphs, substituted
receipts, missing result records and incomplete original pages; that model is not evidence
of PostgreSQL behavior.

The coordinated PostgreSQL/S3 recovery rehearsal keeps both an active sealed job and a
distinct completed job with a real stored result. It compares every authoritative table,
including result rows, across backup and isolated restore, verifies the original sealed
evidence and result receipts under reprovisioned roles, and retries the original completion
without reviving its old execution epoch. Full scheduler-state recovery acceptance remains
required. CI prepares the exact existing database suites' dependency builds with bounded
parallelism before running those suites serially; test assertions and timeouts are unchanged.

The worker must reserve complete rule work before each computation invocation. This
adapter checks prepaid admission; it does not by itself account for every failed or repeated
computation invocation. That durable worker composition remains required.
The subsequent [per-invocation reservation composition](workflow-2-policy-rule-reservations.md)
commits a fresh complete fee before invoking this publisher and retains it on failure.

This prerequisite does not complete the checkpoint. Complete durable acquisition accounting,
memory/shared snapshot and result conformance, a separate executable policy worker,
running/completed recovery acceptance, public API/SDK, real-service contributor acceptance
and the independent exit audit remain required. Sealed source projections retain their
declared trust limitations; no provider truth, human approval, overall safety score or
production readiness follows from a policy result. See the
[result integrity guide](workflow-2-policy-result-integrity.md) and
[checkpoint entry audit](workflow-2-policy-evaluation-entry-audit.md).
