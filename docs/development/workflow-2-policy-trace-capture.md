# Exact retained trace capture

[English](workflow-2-policy-trace-capture.md) |
[한국어](workflow-2-policy-trace-capture.ko.md)

Status: exact trace acquisition and request-rooted integration implemented; Workflow 2 checkpoint 3
remains open. This is not a sealed snapshot, policy verdict, or release authority.

## Fixed selectors, not current trace pages

`readPolicyEvaluationTrace(input, repository)` in `@proofstack/core` accepts an exact scope, UTC
evaluation time, and strict `RegressionTraceSnapshot`. It captures those inputs before asynchronous
I/O, including the selector's original ordered unique event IDs, declared count, trace ID, and
`capturedAt`. The existing selector contract bounds the list to 1–1,000 events. The only repository
operation is `ExactEvidenceRepository.resolveExactEvents`; no `listByTrace`, latest-page lookup,
fallback, sorting, deduplication, or partial-result substitution is allowed.

The fixed inspector validates each complete `EvidenceEnvelope` before normalizing schema-admitted
optional undefined values. It checks exact tenant/project/environment, trace ID, array cardinality,
and each event ID at the selector's original position. Unknown fields remain invalid. Verified
output includes defensive copies of the full envelopes, one canonical SHA-256 per envelope, and a
canonical SHA-256 of the ordered array. Server `receivedAt` receipts are included in those hashes.

The selector retains `sourceCompleteness: observed_snapshot`. Successful acquisition proves neither
that the trace contains no other events nor that the producer reported true events or timestamps.

## Receipt cut and observations

The selector's capture time cannot be after `evaluationTime`. An event's server receipt cannot be
after either boundary. Timestamp comparisons preserve supported offsets and all 30 fractional
digits; they do not round to database microseconds. Equality is allowed. These checks concern
retained receipts, not the truth or synchronization of producer `startedAt`/`endedAt` clocks.

| Observation | Meaning |
| --- | --- |
| `verified` | Every requested envelope is valid, exact, ordered, and within both receipt cuts |
| `missing` | The authorized exact repository returned `null`; no partial events or empty verified hash is invented |
| `unavailable: record_invalid` | The returned value or an envelope fails its strict contract |
| `unavailable: reference_mismatch` | Cardinality, event order/identity, scope, or trace does not match |
| `unavailable: not_yet_available` | Selector capture or an event receipt is after evaluation time; a future selector is rejected before I/O |
| `unavailable: snapshot_cut_mismatch` | An otherwise in-time event was received after the selector's capture cut |

Unavailable/missing reads retain `events: null`, never a misleading successful subset. The fixed
`inspectPolicyEvaluationTrace(input, raw)` supports pure reinspection with the same rules; caller-
supplied `null` cannot establish authoritative absence. Invalid input throws
`PolicyEvaluationTraceReadInputError`; storage and unexpected implementation failures propagate.
Neither primitive authenticates a caller, proves selector provenance, or meters a global job budget.

## Request-rooted composition

`capturePolicyTraceEvidence(request, repositories, evidence)` in `@proofstack/policy-evaluation`
owns a validated request, acquires its [record graph](workflow-2-policy-evaluation-record-graph.md),
and resolves [captured comparisons](workflow-2-policy-comparison-capture.md). It follows only trace
selector occurrences emitted by verified graph parents. `edgeIndex` identifies that exact graph
edge, including parent source, full parent-record hash, and JSON pointer. Callers cannot submit a
replacement graph, a preferred comparison, or a successful trace observation to this entry point.
Both sets of read-only ports must be authorized by the future trusted worker composition.

Missing/unavailable roots return `roots_unavailable`, not an empty successful trace inventory.
Otherwise `traces_captured` retains every observed selector and its explicit read outcome. It does
not mean that all traces verified or that all required parents existed. Repeated identical selectors
from different parents remain separate occurrences and each consumes an exact lookup. Differing
observations of one exact selector abort with `observation_conflict`. Overlapping verified selectors
must observe the same full hash for every shared event ID, including its receipt.

Every verified event content-reference occurrence is retained with its trace-capture index, event
ID, event-record hash, and `/events/<index>/evidence/contentReferences/<index>` pointer. Duplicate
occurrences are not erased. An artifact ID with incompatible complete descriptors conflicts with
both prior metadata references and other captured trace references. This aborts with
`reference_conflict`; it does not choose the last or most convenient descriptor.

These are the original `ContentReference` descriptors, not silently narrowed managed-artifact
contracts. An evidence descriptor may have a zero size or media-type spelling that the managed
artifact catalogue does not admit. It remains declared evidence, not proof of managed ownership,
readable bytes, classification authorization, or retention availability.

## One acquisition budget

Graph reads, comparison integration, and trace acquisition share one invocation-local meter. No
phase resets the request's limits. An exact trace lookup reserves one read record plus every
requested event row **before I/O**, including for a null or malformed response. An oversized returned
array also charges its extra rows. Response JSON is admitted before cloning and semantic inspection;
cycles, accessors, hidden/symbol properties, and unmeasurable values abort without invoking getters.

Trace artifact occurrences consume the same reference ceiling and their canonical occurrence bytes.
The combined response and reference byte total cannot exceed `maxAcquisitionRecordBytes`.
`maxAcquisitionRecords` separately bounds records and reference occurrences. Repeated selectors,
events, and artifact occurrences consume budget again rather than hiding actual acquisition cost.

The top-level `usage` is the total acquisition. `comparisonCapture.graph.usage` remains the earlier
metadata-phase usage, and that graph's unresolved counters still describe its metadata frontier.
Trace observations do not rewrite these counters into an unsupported closure claim. Errors abort
the operation without returning a partial successful capture, and started repository calls are
drained. These are not wire-memory ceilings, semantic CPU deadlines, interruptible I/O, artifact-byte
budgets, or a durable retry ledger. Internal shared-meter and graph-reuse helpers are not exported
from the package root; the existing public graph and comparison operations retain their behavior.

## Verification and remaining work

Tests use actual memory evidence, dataset, candidate, policy, and comparison repositories. They
cover exact ordering with extra current events, immutable-body and receipt hashes, defensive input
ownership, full-precision time boundaries, strict failure observations, parent provenance, repeated
selectors, changed overlapping events, descriptor conflicts, unmanaged content declarations,
pre-I/O row reservation, exact shared byte ceilings, reference overflow, and operational failures.
A composed case retains verified direct comparison lineage while acquiring a candidate dataset's
exact trace through the same graph; missing unrelated descendants remain explicitly unresolved.

This is not a PostgreSQL policy-worker acceptance test or evidence that source bytes and all semantic
relationships are valid. Complete cross-record semantic validation, artifact-byte acquisition,
mutable authority/lifecycle capture and race guards, snapshot sealing, all policy predicates,
authorized durable jobs, API/SDK, recovery, isolation, and end-to-end acceptance remain open.
Workflow 2 still has two accepted checkpoints out of seven.

The subsequent [authorized artifact observer](workflow-2-policy-artifact-observation.md) provides
the owning-domain exact content-read prerequisite. The
[request-rooted artifact capture](workflow-2-policy-artifact-capture.md) now connects these trace
occurrences and graph artifact references under shared admission. Owner/authority semantics and
guarded sealing remain open.
