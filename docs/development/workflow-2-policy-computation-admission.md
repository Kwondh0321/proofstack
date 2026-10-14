# Native admission to sealed policy computation

Workflow 2 checkpoint 3 remains open. Migration 0059 and
`PostgresPolicyEvaluationJobWorkerRepository.startComputation` advance an already sealed
job to `running` on its original live attempt. This operation does not acquire sources,
compute predicates, publish a result, or provide an executable worker.

The fixed evaluator-only function locks the owning job and checks exact scope, current
recovery epoch, full worker/attempt/lease/fence, native expiry and receipt order. The job
must be `sealed`, its open attempt must already be `computing`, and the exact stored
snapshot must bind the same immutable request. Snapshot, attempt, lease, deadline and
usage remain unchanged. Only status, state version and the native update receipt advance.
The original final history slot still produces explicit budget exhaustion.

The existing adapter commits the state, one `start_computation` history entry and canonical
intent validation together. A deferred history trigger checks the still-live native fence
again at final commit. An expired commit rolls back wholly. Concurrent starts admit one
transition; duplicated starts and cancelled/unsealed/foreign/stale work are rejected.
Reclaiming an already sealed job still uses its original snapshot and never recaptures
sources. A new claim on that retained snapshot already enters `running` through the
existing claim transition.

Only the separate `policyEvaluator` role can execute this mutation. API, policy control,
policy author and upstream worker roles do not acquire that grant. The private trigger
function has no runtime execution grant. Caller clocks and caller-supplied replacement
snapshots are absent from the port.

The core computation-admission interface is separate from the operational memory adapter.
Memory snapshot storage and shared sealing/computation conformance are still required;
an operational adapter without snapshot storage is not given a mock publication capability.
Historical [sealed-input computation](workflow-2-sealed-policy-computation.md) remains
separate from fresh execution and atomic result publication.

Remaining work includes complete durable acquisition costs, immutable result/closed
attempt/terminal job/outbox publication, authoritative result recomputation, memory/shared
conformance, a separate worker, running/completed recovery, API/SDK, real-service contributor
acceptance and an independent checkpoint exit audit. No checkpoint acceptance is inferred
from this prerequisite. See the [entry audit](workflow-2-policy-evaluation-entry-audit.md).
