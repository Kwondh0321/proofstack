# Policy evaluation request contract

[English](workflow-2-policy-evaluation-request-contract.md) |
[한국어](workflow-2-policy-evaluation-request-contract.ko.md)

Status: request-contract implementation; full evaluation checkpoint remains open.

This contract implements part of the first slice in the
[policy-evaluation entry audit](workflow-2-policy-evaluation-entry-audit.md). It does not expose a
working enqueue endpoint or implement a scheduler, snapshot, evaluation result, approval, or release
decision. These boundaries still need their own contracts, authorization, persistence, and acceptance.

## Exact identity and immutable inputs

[The request definition](../../packages/contracts/src/policy-evaluation-request.ts) contains exactly:

- an opaque `evaluationRequestId`, distinct from the HTTP correlation `requestId`;
- exact candidate and policy IDs, version IDs, and definition digests;
- algorithm `proofstack.deterministic-policy` version `1.0.0`;
- an explicit UTC `evaluationTime`; and
- all execution limits and the predeclared set of retryable operational errors.

Nothing is defaulted. Scope is supplied by the authorized application boundary, not the request
body. The scoped canonical encoding binds all semantic fields, schema version, encoding version,
and a request-specific domain. The
[public vector](../../packages/contracts/vectors/policy-evaluation-request-definition-v1.json)
contains independently constructed UTF-8 length and SHA-256 expectations. Its references are
synthetic identities, not proof of retained source authority.

The stored request adds `createdAt`, `createdByPrincipalId`, scope, schema version, and digest.
Structural validation does not recompute the digest or authorize the actor: repositories and use
cases must do both. The control boundary must reject a changed definition under the same scoped
request identity and preserve the original receipt on an identical retry. This slice defines the
bytes needed for that check; it does not claim that storage behavior is already implemented.

Caller-supplied scope overrides, workers, credentials, leases, snapshots, operands, verdicts,
approvals, arbitrary source URLs, and other unknown fields are rejected, not stripped.

## Exact time, separate from database cursor order

Semantic evaluation time admits UTC timestamps with up to 30 fractional digits and retains their
original spelling in the definition digest. Equivalent spellings of the same instant therefore
remain distinct request inputs, although the time comparator orders them equally. Server receipts
remain canonical UTC milliseconds.

[The semantic time helper](../../packages/contracts/src/policy-evaluation-time.ts) validates the
source timestamp and compares whole seconds plus a bounded integer fraction. It also understands
the offsets supported by retained source records. It must not be replaced by the existing evidence
cursor key, whose intentionally rounded PostgreSQL microsecond order serves a different purpose.
Do not coerce semantic inputs to a `timestamptz` and then discard their original precision.

Enqueue time is not the observation cut. A future-at-enqueue semantic time is structurally valid;
capture must refuse to seal while `evaluationTime > captureTime`. It must separately reject evidence
created after the requested time and apply the half-open policy validity interval. No clock is
read by these schemas. Request receipts at the end of the supported calendar range must leave room
for the complete declared deadline, so scheduler timestamps cannot overflow into year 10000.

## Execution limits and accounting obligations

These are finite reference resource ceilings, not benchmarked throughput or production SLOs.
Every caller supplies its own limits within the ranges below; there are no hidden defaults.

| Limit | Admitted range | Accounting meaning |
| --- | --- | --- |
| `maxAcquisitionRecords` | 2–100,000 | Every attempted authoritative record lookup, including missing records and repeated lookups; the minimum accommodates both roots |
| `maxAcquisitionRecordBytes` | 1–67,108,864 bytes | Cumulative compact UTF-8 JSON bytes of structurally bounded returned metadata, before semantic processing; repeated records count again |
| `maxArtifactReadBytes` | 0–268,435,456 bytes | Actual content bytes read, including retransmitted bytes and partial reads; zero does not waive required content verification |
| `maxRuleEvaluations` | 1–1,024 | Charge before evaluating each rule on every attempt; additionally limited to 128 rules times the request's attempt cap |
| `maxAttempts` | 1–8 | Every claimed acquisition/execution attempt, including interrupted or expired attempts |
| `leaseDurationMilliseconds` | 1,000–60,000 | Lease duration, clipped at the attempt timeout and total deadline by the worker boundary |
| `heartbeatIntervalMilliseconds` | 100–10,000 | Must fit at least three intervals in the declared lease |
| `perAttemptTimeoutMilliseconds` | 1,000–900,000 | Elapsed time from attempt claim, including acquisition and evaluation |
| `totalDeadlineMilliseconds` | 1,000–3,600,000 | Elapsed time from original request creation, including queueing, acquisition, backoff, execution, and restarts |
| `retryBackoffMilliseconds` | 0–60,000 | Fixed delay before a permitted retry; shorter than the total deadline |

The byte and work counters are job-wide, not reset by retries, API/worker restart, sealing, or
recovery. A malformed record fails validation; it cannot become a free valid observation. Durable
accounting must charge or conservatively reserve work before doing it and reconcile partial reads.
These schema limits alone do not enforce runtime budgets or prevent a caller from choosing a budget
too small for its graph. Exhaustion must become explicit operational state, never silent omission,
a smaller favorable denominator, or a partly evaluated successful result.

The attempt timeout must fit the total deadline; the lease must fit the attempt timeout. The
deadline can end execution before all allowed attempts fit. One attempt requires no retry errors
and zero backoff. Multiple attempts require a nonempty, unique, sorted subset of `lease_expired`,
`source_revision_changed`, `source_temporarily_unavailable`, and `worker_interrupted`.

No rule outcome is retryable: `violated`, `indeterminate`, missing approval, and completed numerical
results are not retry causes. Source-revision retries apply only before sealing; after sealing,
every permitted attempt retains the same snapshot. Claims, accounting, retries, cancellation, and
recovery fencing still require the separate durable implementation.

## Request transport budget

[Request-only transport contracts](../../packages/contracts/src/policy-evaluation-request-api.ts)
reserve 4 KiB for an incoming request and 8 KiB for the exact stored-request read envelope. The
additional 4 KiB covers bounded scope, actor, digest, server time, a fully escaped 128-code-unit
correlation ID, and integer expansion after JSON parsing. Tests construct every maximal semantic
field and exercise ASCII, Korean, supplementary characters, controls, lone surrogates, quotes,
backslashes, and compact input exponent forms.

Those tests prove representation headroom, not HTTP or SDK enforcement. The future transport slice
must reject over-limit streamed bodies and test just-below, exact, and over-limit bytes. Snapshot,
result, job, and paginated manifest/history responses will have separately derived finite limits;
the request budget is not a limit or a completion claim for those unimplemented records.
