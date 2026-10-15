# ADR-0034: Retain policy acquisition credit across failures

Status: accepted implementation boundary; Workflow 2 checkpoint 3 remains open.

## Context

An in-memory metadata meter bounds one invocation but loses work when its process or
publication transaction fails. Charging after I/O cannot establish admission, and an
independent pool mutation while sealing holds the job lock would deadlock. A lost response
cannot establish that no work occurred. Artifact buffers and rule invocations already have
separate owning charges; neither substitutes for metadata acquisition accounting.

## Decision

Commit a strict request-owned allowance before metadata I/O. Bind one occurrence to its
original scope, request, job and live attempt fence; derive exact remaining reads, records,
references and shared record/reference bytes from frozen limits. Only one allowance may
remain open. Duplicate open credit preserves its original allowance without new history;
closed occurrence IDs cannot fund another acquisition. Credit does not extend a lease.

After all started work drains, server composition settles observed counters. Unknown work
consumes the entire allowance and terminates budget-exhausted. Cancellation, interruption,
reclaim, history exhaustion and coordinated recovery also charge unknown credit before
attempt closure. Preserve cancellation/deadline priority and historical canonical graphs
that have no optional allowance. Reject out-of-band metadata deltas while credit is open.

Forward migration 0061 retains a private forced-RLS ledger, original immutable credit and
closed billing records. Fixed evaluator-only functions reserve/settle with native live-fence
checks; deferred commit checks retain native expiry and recovery authority even after an
unknown settlement clears its lease. Owner recovery/cancellation may conservatively close
expired credit without reviving execution. No runtime table DML or private helper grant is added.

The [optional internal capture composition](../development/workflow-2-policy-acquisition-capture.md)
applies remaining read/response limits and settles on the same guarded client before snapshot
publication. Publication rollback must retain the separately
committed credit; uncertain acknowledgements require authoritative reads, never automatic
retries or refunded work. Complete physical transport accounting remains a separate entry gate.

## Consequences

Unknown work can exhaust a whole job budget. This deliberately trades further retries for
bounded costs when truthful settlement is unavailable; known drained work retains exact
charges and remaining capacity. It does not prove wire-byte interruption or provider truth.
Shared memory/native cases, actual deferred-commit expiry and comprehensive PostgreSQL/S3
restore must cover ledger, normalized usage, histories and atomic terminal intents together.
Worker, API/SDK, contributor acceptance and independent checkpoint exit gates remain open.

See the [acquisition guide](../development/workflow-2-policy-acquisition-allowances.md).
