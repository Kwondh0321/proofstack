# Policy metadata acquisition allowances

Workflow 2 checkpoint 3 remains open. This workspace-only prerequisite defines owning
metadata credit and settlement; [optional internal capture wiring](workflow-2-policy-acquisition-capture.md)
uses it without claiming worker, transport or checkpoint acceptance.
It introduces no public route, worker executable, approval or production composition.

`PolicyEvaluationAcquisitionRepository.reserveAcquisition` commits one allowance before
metadata I/O. Its strict versioned record binds the exact scope/job/attempt/worker/lease/
fence/recovery epoch and the original request's remaining reads, records, references and
shared record/reference bytes. Credit is not spent usage. It cannot extend a deadline,
replace request limits or be issued concurrently for another occurrence. Duplicate open
credit returns its original allowance and creates no history; that acknowledgement must
never authorize another acquisition. A closed occurrence cannot be reused.

After all started work drains, trusted server composition settles the observed five
metadata counters. `usage: null` means costs cannot be established; the entire outstanding
allowance is charged and the job closes `budget_exhausted`. Cancellation, interruption,
lease reclaim, history exhaustion and coordinated recovery also consume unknown credit
before recording attempt usage. Cancellation/deadline outcomes retain their own priority.
No refund follows a lost response, rollback, crash or restored old worker. Observed settlement
is a single mutation; ambiguous acknowledgements require authoritative reads, not automatic
mutation retries or a second acquisition funded by the same allowance.

Artifact bytes and predicate invocations remain separate, independently charged counters.
Out-of-band metadata reservations are rejected while an allowance is open. Historical
graphs without the optional allowance field retain their canonical bytes and hashes.
The final fixed history slot remains an operational budget-exhaustion receipt.

Migration `0061_policy_acquisition_allowances.sql` adds a private, forced-RLS billing ledger
and fixed evaluator-only mutations. Original credit and closed billing records are protected
from mutation/deletion. A deferred constraint checks the actual database time and recovery
epoch at commit, including unknown settlement after its current lease is cleared. Owner
cancellation/recovery can close uncertain credit after expiry without reviving execution.
Existing migration checksums, role boundaries and coverage thresholds remain unchanged.

Shared memory/PostgreSQL cases cover original credit, duplicate history, exact remaining
limits, observed/unknown settlement, scope/fences and cancellation. Separate PostgreSQL
cases exercise expiry after mutation but before commit. The comprehensive PostgreSQL/S3
restore fixture retains an open allowance and independently reconstructs its conservative
closure, original billing record, attempt, job and history after epoch advancement.
Transport fault models test corrupted acknowledgements; they are not native SQL evidence.

The optional composition connects one bounded, drained meter and settles through the same
held client before guarded snapshot publication; its guide distinguishes response admission
from still-required complete physical transport accounting.
Failure/ambiguous costs must remain charged when publication rolls back. Complete shared
snapshot/result conformance, executable worker, public API/SDK, contributor acceptance and
the independent [entry-audit exit gates](workflow-2-policy-evaluation-entry-audit.md) before
claiming checkpoint acceptance. See [artifact admission](workflow-2-policy-artifact-admission.md)
and [rule reservations](workflow-2-policy-rule-reservations.md).
