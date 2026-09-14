# Policy-evaluation replay-result acquisition

[English](workflow-2-policy-evaluation-replay-result-reader.md) |
[한국어](workflow-2-policy-evaluation-replay-result-reader.ko.md)

Status: record-level acquisition implemented; recursive acquisition, sealed snapshots, rule
evaluation, durable policy workers, and checkpoint acceptance remain open.

The [replay-result reader](../../packages/replay/src/policy-evaluation-replay-result-reader.ts)
extends the [definition readers](workflow-2-policy-evaluation-definition-readers.md) with the
`replay_result` source kind. A plan definition is not an execution result. This reader resolves the
exact retained job snapshot and verifies its successful terminal attempt against the complete
requested result reference. It does not start a replay or publish a policy outcome.

## Authority and identity

`readPolicyEvaluationReplayResult` takes a previously authorized scope, exact source reference,
explicit semantic `evaluationTime`, finite admission limits, and a read-only `findJob` method.
It validates and copies the inputs before its one repository call. There is no latest lookup,
result selection by score, alternate attempt, network discovery, or cross-scope fallback.

The returned history must pass `ReplayJobSnapshotSchema`, including root/attempt consistency,
contiguous attempt and observation sequences, scoped fences, budget reconciliation, and retained
cancellation relationships. Prior attempts must close before or at replacement. The successful
source must be the terminal, latest attempt; a queued, running, failed, timed-out, cancelled, or
budget-exhausted job cannot supply it. The strict result-reference projection checks:

- job and attempt identity and all three scope dimensions;
- plan ID, version ID, and definition digest;
- result artifact ID, SHA-256, size, media type, and classification;
- target ID, release ID, definition digest, adapter and worker-protocol identities; and
- successful terminal status, completed terminal code, and the exact attempt completion instant.

`completedAt` denotes the attempt's `endedAt`, **not** the job terminal's `committedAt`. Equivalent
timestamp offsets/fractional representations compare by exact instant, retaining all supported
precision. The original record timestamps remain unchanged in the returned record and its hash.
Every retained receipt must be at or before `evaluationTime`: job creation/start/terminal commit,
attempt starts/ends, budget reservation/reconciliation, cancellation request/acknowledgement, and
execution/usage observations. Cancellation intent cannot coexist with a successful terminal result;
the shared schema rejects that contradiction before result projection or time checks. Later records
are not silently dropped to reconstruct an older view.

The scope must already be authenticated and authorized by the enclosing acquisition boundary.
A TypeScript method pick does not restrict a database credential: production composition must
provide read authority without sharing replay control or execution credentials with a policy worker.

## Observations and bounded admission

| Condition | Result |
| --- | --- |
| Exact read returns `null` | `missing`, no record |
| Snapshot schema or internal history validation fails | `unavailable` / `record_invalid`, no record |
| Valid snapshot cannot establish the exact successful source | `unavailable` / `reference_mismatch`, no record |
| Any retained receipt is after the semantic cut | `unavailable` / `not_yet_available`, no record |
| All record-level checks pass | `verified`, complete canonical-record SHA-256 and a defensive record copy |
| Malformed input | `policy_evaluation_replay_result_read_input_invalid` before I/O |
| Admission limit exceeded | `policy_evaluation_replay_result_read_limit_exceeded`, not missingness or a rule outcome |
| Repository failure or unexpected validation exception | Original exception propagates |

The caller supplies `limits.maximumRecords` and `limits.maximumRecordBytes` from its remaining
acquisition budget. Their hard ceilings are the existing request-contract ceilings: 100,000 records
and 64 MiB. Record admission counts the job root, every attempt/ledger/acknowledgement/observation
row, and the cancellation request when present. The terminal receipt is embedded in the job root.
Counts are checked before parsing history elements; the reader never admits a truncated history.
Bytes are the complete canonical UTF-8 JSON representation, including all histories and receipts.
Exactly-at-limit values are admitted; larger values throw an operational limit error.

Only **after strict schema validation**, optional `undefined` properties are represented as absent
JSON properties. This matches existing in-memory state transitions and database/HTTP transport;
unknown fields, even when undefined, are rejected before normalization. The hash binds the complete
normalized record, not only the artifact reference or a selected attempt. A receipt-only or child
observation change changes the record hash.

These are admission limits for an already returned repository value, not a streaming database
transport, cumulative graph budget, wall-clock deadline, or cancellation mechanism. The enclosing
collector still needs bounded source materialization, total I/O/record/byte/time accounting, and
consistent revision guards. Exceeding a budget must never trigger a more favorable source choice.

## Verification and remaining scope

Cross-checking read semantics against the memory state machine and PostgreSQL completion functions
found that the snapshot schema previously admitted cancellation intent on queued or non-cancelled
terminal jobs. Both mutation authorities already require cancellation to win the terminal commit
and reject a new intent after completion. The shared schema now permits retained cancellation intent
only on running or cancelled jobs. Five negative cases failed before the correction; running and
cancelled histories remain valid. The old synthetic successful snapshot fixture incorrectly inherited
cancellation state from its running fixture and was corrected, without changing stored data or
mutation semantics. The result-reader tests also reject a forged success that ignores this intent.

The [tests](../../packages/replay/src/policy-evaluation-replay-result-reader.test.ts) build a real
in-memory target/plan/job/claim/accounting/observation/completion sequence from retained definition
vectors. They also exercise all reference leaves, three-scope hiding and adapter substitution,
every non-success job status, historical-attempt substitution, unclosed/overlapping histories,
schema corruption, full-precision completion/capture edges, successful-history receipt categories, optional-field
transport parity, defensive copies, input mutation, operational failures, and exact record/UTF-8
byte admission edges. Canonical hashes use an independent sorted-JSON test oracle.

`verified` is a record observation, **not** policy satisfaction, approval, execution attestation, or
proof that a provider or stale OS process behaved as reported. The repository is trusted to return
its complete authoritative history; hashing a returned snapshot cannot independently prove that
an adapter did not omit a history suffix. The result reference does not contain a prior digest of
the whole job history. The new hash records this observation for later snapshot binding.

Still required are recursive plan/target/dataset/fixture/profile and artifact lineage, ownership
and retained-byte verification, source authority, global conflict/closure validation, guarded
sealing, pure rule derivation, durable policy jobs and separate database roles, API/SDK/worker
composition, real-service contributor acceptance, and the complete
[checkpoint exit gates](workflow-2-policy-evaluation-entry-audit.md). No PostgreSQL mutation,
capability, endpoint, public website, or fixed user-facing port is added by this slice.
