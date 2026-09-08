# Policy evaluation evidence-source reader

[English](workflow-2-policy-evaluation-evidence-reader.md) |
[한국어](workflow-2-policy-evaluation-evidence-reader.ko.md)

Status: implemented record-level acquisition building block; recursive closure and the
policy-evaluation checkpoint remain open.

The [comparison-lineage validator](workflow-2-policy-evaluation-comparison-lineage.md) produces
exact references, not proof that their subordinate records exist. The next acquisition boundary
must resolve those references through authoritative read ports before expanding the graph.
`readPolicyEvaluationEvidence` implements that record-level read for all seventeen non-model
evaluation kinds and all thirteen model/human-assurance kinds. It reuses existing repositories and
canonical validators; it does not add a storage format, writer, database role, or public endpoint.

## Authority and identity

The enclosing capture supplies exact scope and semantic evaluation time from previously authorized
and validated roots. This internal function is not an HTTP authentication boundary and must not be
exposed as a caller-controlled arbitrary lookup. Its dependencies contain only evaluation `find*`
methods and model-assurance `find`; policy authorship, original-issuer impersonation, evaluation
execution, and reviewer publication are neither required nor granted.

The reader parses defensive copies of scope, UTC time, and the strict typed source reference before
any repository call. It selects a fixed repository operation and immutable record ID, passes a
separate scope copy to that operation, and makes no network discovery, alias, latest-version, or
favorable-result fallback. Repository callbacks cannot replace the captured input context.

After reading, it independently parses the expected record kind and recomputes its canonical
definition digest. It then checks tenant, project, environment, and **every** source-reference
field. Logical resource IDs and an evaluation result's parent run ID are checked in addition to
the lookup ID and digest. Equal numeric values and same-tenant records are not substitutes.

The source vocabulary's `blinded_plan`, `blinded_result`, and `model_assisted_evaluator_spec` map
explicitly to the repositories' `blinded_evaluation_plan`, `blinded_evaluation_result`, and
`model_assisted_evaluator` kinds. The other names are unchanged. Exhaustive type declarations and
the complete retained-fixture test matrix guard the thirty-kind mapping.

## Record observations

| Read outcome | Manifest observation | Returned record |
| --- | --- | --- |
| Exact lookup returns `null` | `missing` | None |
| Returned data fails strict kind/schema/digest validation | `unavailable`, `record_invalid` | None |
| Valid record differs in scope or any reference field | `unavailable`, `reference_mismatch` | None |
| Correct record was recorded/published after evaluation time | `unavailable`, `not_yet_available` | None |
| All record-level checks pass | `verified`, full-record SHA-256 | Defensive parsed record |
| Repository operation throws | No observation; original exception propagates | None |

Only `null` establishes absence; `undefined`, malformed data, and exceptions do not. Out-of-scope
normal repository reads remain hidden as absence. A repository that incorrectly returns a foreign
record is rejected without returning its body.

Each kind has an explicit authoritative receipt field: `createdAt`, `publishedAt`, `recordedAt`, or
`reviewedAt`. Equality with the evaluation time is allowed; a later receipt is unavailable even
across the smallest supported fractional boundary. The hash covers the complete canonical record,
including server receipts, rather than only the semantic definition. Two valid receipts with the
same definition digest therefore remain distinguishable during capture consistency checks.

## Verification and remaining work

The focused matrix creates the existing memory-backed evaluation and model/human graph in
dependency order, including a final assessment through its normal use case. Every kind exercises
exact reads, hidden absence, bad digests, unknown schemas, field smuggling, every reference-field
substitution, all three scope dimensions, receipt-time equality and fractional boundaries,
receipt-only hash changes, defensive copies, and repository failure. Additional cases cover
unsupported source families, malformed context before I/O, and callback-driven input mutation.
These tests prove the reader over retained memory records and hostile port responses, not a new
PostgreSQL integration or a completed policy worker.

`verified` here means only that this exact immutable record passed the stated checks. It does not
prove its child references, source truth, current qualification or applicability, retained artifact
bytes, policy satisfaction, approval, or a complete evidence set. A historically valid record may
describe expired or ineligible evidence; later authority and rule evaluation must retain that fact.

Still required are the remaining source-family adapters, explicit dependency expansion from every
validated record, complete parent-child/re-derivation checks, deterministic recursive enumeration,
conflicting-identity detection, cumulative record/byte/time/retry budgets, artifact verification,
policy lifecycle observations, revision guards, and one protected sealed snapshot. Do not assemble
an authoritative manifest merely by accepting caller-selected lists or this reader's individual
observations. Public API/SDK, durable jobs, worker authority, recovery and checkpoint acceptance
remain separate unfinished work under the [entry audit](workflow-2-policy-evaluation-entry-audit.md).
