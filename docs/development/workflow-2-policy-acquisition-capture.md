# Owning acquisition credit during policy capture

The later [bounded initial source facade](workflow-2-policy-initial-sources.md) binds owning
metadata reads to exact live credit and pre-decoder limits. Actual executable worker wiring
remains required; semantic counters and physical transport limits stay separate.

Workflow 2 checkpoint 3 remains open. The workspace-only `sealPolicyEvaluationSnapshot`
entry optionally accepts server-owned `acquisitionAdmission`. This connects committed
[acquisition allowances](workflow-2-policy-acquisition-allowances.md) to the existing capture
and held snapshot publisher. It adds no public route, executable worker or production wiring.

Execution authorization, service-token identity, exact scope and deciding fence are checked
before job dependencies or credit. Read the owning acquiring job and commit one fresh
allowance before source I/O. Independently validate the whole reserve transition against the
original request. Duplicate, ambiguous, substituted or expired acknowledgement cannot start
another acquisition. A monotonic window starts before reservation, deducts acknowledgement
delay from the native cut and rounds submillisecond remaining time down. It cannot extend a lease.

Keep the original request/digest unchanged. One invocation meter receives separate remaining
reads, records, references and shared record/reference bytes. Reads and known requested trace
rows are admitted before I/O; variable response rows and JSON bytes are admitted on response.
This is **response admission, not a wire decoder**. It does not establish complete physical
transport costs or prevent an oversized variable response from reaching its bounded driver.
Dedicated wire/streaming admission and variable-list bounds remain required before checkpoint exit.

A failed or unmeasurable started metadata read makes actual costs uncertain. Drain every
started task, including rejected pre-I/O calls and sibling reads. Known drained counters settle
exactly; uncertain costs consume the complete frozen allowance. Artifact byte reservations and
rule invocations remain separate counters, and metadata settlement cannot refund either.

On successful capture, retain the job and source guards on one connection. Drain the meter,
settle through its fixed `settleAcquisition` port, validate exact metadata costs and then publish
the snapshot. The PostgreSQL adapter compares the entire pure owning settlement, appends its
history atomically, updates the held before-image/head and publishes from that head. No second
pool transaction runs while the job lock is held. Duplicate/out-of-order/expired ports and
caught or unawaited failures taint the transaction. All started work drains before release.

Await held capture/publication before the outer `finally`; returning a promise without awaiting
it there would run cleanup before later reads/publication completed. A settlement is acknowledged
as committed only after `runSealing` resolves its commit, not when its callback returns.

If publication fails or rolls back, the original independently committed allowance remains.
After releasing the failed transaction, independently settle known drained costs or burn unknown
credit, and validate that receipt too. Preserve the original capture error. If settlement also
fails or its receipt is invalid, return both errors; authoritative credit/job history still controls
later recovery. No automatic mutation retry, refund, new cut or successful seal is inferred from
an ambiguous response. Native cancellation/expiry/recovery can conservatively close pending credit.

Tests distinguish transport fault models from actual PostgreSQL evidence. Focused capture cases
check authorization order, fresh/duplicate credit, separate artifact fees, unknown-cost closure and
forged fallback receipts. Native cases check same-client settlement before sealing, whole seal
rollback with retained independent charges, caught/unawaited failure taint and expired ports.
Coverage thresholds and existing deadlines remain unchanged.

Complete transport accounting, shared snapshot/result conformance, full-state recovery, the
separate worker, API/SDK, real-service contributor flow and independent
[checkpoint exit gates](workflow-2-policy-evaluation-entry-audit.md) remain necessary. Legacy
internal composition without this option does not demonstrate durable acquisition admission.
