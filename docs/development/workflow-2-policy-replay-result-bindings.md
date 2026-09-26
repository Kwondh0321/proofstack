# Captured replay-result bindings

[English](workflow-2-policy-replay-result-bindings.md) | [한국어](workflow-2-policy-replay-result-bindings.ko.md)

Status: bounded retained-history consistency is inspected during record graph acquisition.
Complete semantic closure, installed execution authority, sealed snapshots and Workflow 2
checkpoint 3 remain open. This does not execute or repair a replay job.

## Separate record integrity from execution meaning

The [exact replay-result reader](workflow-2-policy-evaluation-replay-result-reader.md) verifies the
full retained history, exact successful terminal source, scope, receipt cut, row/byte admission,
and schema-level identity, fencing and accounting consistency. It cannot infer that an attempt's
runtime, isolation or target reference equals the definition of the plan it names. A substituted
profile can have a valid full-record hash while violating that plan.

`inspectPolicyEvaluationReplayResultBindings` in `@proofstack/replay` accepts a verified captured
result and its exact captured plan observation. It revalidates both available bodies through fixed
owning inspectors, preserving the original full hashes. Strict three-field read envelopes reject
accessors, hidden/extra fields and omitted properties before reading their values. The plan source
must exactly equal the job's plan; an unavailable plan must retain a null body and original reason.
Invalid, changed, omitted or substituted evidence throws without returning a partial report.
Supplied missing observations are trusted capture provenance, not a public caller's proof that
storage was consulted or that a record does not exist.

The result reader's row and byte limits apply before inspection; there is a fixed maximum number
of emitted checks per admitted history row. Each result and its plan are reinspected as a pair;
a plan shared by several results is not claimed to be revalidated only once. This is not a new
I/O meter, a wire decoder or durable retry accounting. The enclosing request's global acquisition
meter remains authoritative and is not reset.

## Checks and provenance

The report retains `source`, the original result `recordSha256`, the exact `plan.source` and its
`recordObservation`, and deterministic ordered `checks`. Each check has a kind, a JSON pointer
into the retained history, and `matched`, `mismatch`, or an explicit `unavailable` reason.

| Check group | Meaning |
| --- | --- |
| Receipts and attempts | The plan was retained by job creation, job start matches the first attempt, and attempt count respects the plan |
| Every attempt | Exact target release, runtime profile, isolation profile and worker protocol match the retained plan, including unsuccessful predecessors |
| Retry declaration | A successor follows a retry-scheduled failed/expired attempt under the declared automatic retry and error classes; the fixed attempt schema already checks effect-safety shape |
| Retry timing | Ordinary failure receipts use the existing bounded retry decision, backoff and deadline calculation; unretained lease expiry remains unknown |
| Reservation policy | Each of the ten dimensions retains the plan's exact limit and measurement declaration |
| Boundary identity | Reservation work, execution kind/mode and optional usage boundary refer to the plan's declared boundary; global usage is not forced into a boundary |
| History receipts | Ledger and observation receipts lie within their fenced attempt; reconciliation does not precede its own reservation |
| Successful accounting | No open reservation or overrun is hidden by success; disputed usage stays explicitly unavailable |

No favorable last attempt replaces earlier failures. A mismatch does not erase other mismatches
or missing prerequisites. When the plan is unavailable, plan-dependent checks are unavailable,
but independent receipt/accounting checks remain inspectable. Returned data is detached from the
captured inputs. An empty ledger means no retained open reservation or dispute, not measured zero
resource consumption or proof that every operation reserved its budget.

### Why lease-replacement timing is not reconstructed

The reference memory/state-machine path records an expired attempt's `endedAt` at replacement.
Its retry decision used the old lease's expiry, which is absent from the terminal snapshot.
Treating replacement as failure time and applying backoff again would reject legitimate retries.
Such timing is `unavailable` with `lease_expiry_unretained`; no expiry is invented from attempt
start, receipt time or the current plan. The retry declaration can independently mismatch.
For other closed failure histories with a declared retry, the existing `decideReplayRetry`
calculation also verifies the next attempt does not start before the required backoff.

## Graph composition and verification

`capturePolicyRecordGraph` uses its own already-acquired plan observation for each available
replay result. It preserves reports in `replayResults.results` and unreadable result sources in
`replayResults.unavailableResults`. Missing results are not successful empty reports. No additional
repository reads, worker mutations or credential resolution occur. Reports remain present through
comparison, trace and artifact capture; their source/hash matches the graph node and `/job/plan`
edge. Storage failures still abort acquisition.

Tests build real memory-published plans, jobs, lease replacements, reservations, reconciliations,
observations and successful completion, then alter independently revalidated retained evidence.
They cover prior-attempt substitutions, exact plan references, unavailable observations, receipt
boundaries, declared retry timing, all budget dimensions, unknown boundaries, open/disputed/overrun
accounting, full-hash tampering, strict inputs and admission limits. Graph tests join an actual
completed job into upstream evaluation records and preserve exact read counts and provenance.

This is declared-history consistency, not proof of actual executable bytes, result artifact
ownership/content semantics, complete instrumentation, OS isolation, installed runtime authority,
current revocation, source trust or policy satisfaction. Existing dataset, plan and artifact
reports must be retained alongside it. Remaining relationships and mutable authority/revision
guards precede sealing, deterministic policy results, durable jobs, API/SDK and end-to-end audit.
Workflow 2 remains **2/7 accepted checkpoints**.
