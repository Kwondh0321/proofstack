# Durable reservations before each policy computation

Workflow 2 checkpoint 3 remains open. The trusted worker composition
`publishPolicyEvaluationWithReservedRules` commits one fresh reservation for every ordered
rule before invoking the native result publisher. Original stored snapshot data and pages
come from server composition, not a public request. There is no computed-result POST,
new role, migration, worker executable or automatic mutation retry in this prerequisite.

Non-delegable service-token execution is authorized before payload parsing or dependencies.
The full fence must identify the authenticated worker. The composition reads the owning job
in the exact authorized scope, requires its original running attempt and snapshot, validates
the complete original page set and derives the complete rule count from that sealed input.
It does not choose a rule subset or select a newer source cut.

The existing `reserveWork` mutation commits independently before calculation/publication.
Its fresh server-generated occurrence must return `created: true` and an immutable history
receipt. The composition verifies exact scope, job, fence, reservation ID, whole-count delta,
before/after graph hashes and a complete independently replayed transition. Duplicate or
ambiguous acknowledgements stop computation. If concurrent work changes the prepared graph,
the acknowledgement is rejected conservatively after retaining its charge; the worker must
coordinate its heartbeat/operations and observe current state before any bounded retry.

Native receipt time determines the remaining lease/attempt/job window. A monotonic timer
started before the reservation call conservatively includes acknowledgement wait and validation.
An already expired acknowledgement cannot start calculation. The native publisher separately
rechecks live authority at publication and deferred commit; this helper cannot extend it.

Publication failure, rollback, cancellation or a lost acknowledgement never refunds the
committed fee. Another actual invocation needs a fresh ID and additional complete work.
A duplicate acknowledgement cannot pay for a second invocation. Completion must retain
every acknowledged usage counter and its original deciding fence, snapshot and receipts;
the returned evidence is independently revalidated. Historical integrity recomputation is
bounded verification, not a new source cut or a new authoritative computation attempt.

Already completed jobs use exact historical result reads/retries, preserving original receipts.
This new-invocation composition refuses to charge or execute them. Stored immutable outbox
conflicts remain conflicts; tests do not delete records or relax their protection to retry.

Native regressions cover independent committed payment before result publication, whole
result rollback with retained payment, refusal of duplicate payment reuse, a second failed
invocation's additional fee and cancellation after payment. Fault-model unit tests separately
exercise authorization order, complete input binding, budget exhaustion, delayed and ambiguous
acknowledgements, forged paid/completed responses and refund refusal. Models are not native
transaction evidence.

Complete durable metadata/read/reference and input transport charges, memory/shared
conformance, the executable worker, all-state recovery, API/SDK, contributor acceptance and
the independent checkpoint exit audit remain required. No checkpoint, release authority,
human approval, provider truth or production readiness follows from this composition. See
[native result publication](workflow-2-policy-result-publication.md) and the
[entry audit](workflow-2-policy-evaluation-entry-audit.md).
