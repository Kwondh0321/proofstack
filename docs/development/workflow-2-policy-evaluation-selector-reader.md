# Parent-bound policy evaluation selector resolution

[English](workflow-2-policy-evaluation-selector-reader.md) |
[한국어](workflow-2-policy-evaluation-selector-reader.ko.md)

Status: implemented single-occurrence acquisition boundary. Recursive graph capture, artifact
bytes, authority observations, sealed snapshots, policy evaluation, and checkpoint acceptance
remain open. The 44-kind source inventory and roadmap completion count do not change.

## Why a separate boundary exists

Some retained records intentionally contain an immutable version selector without a digest:
criteria can refer to evaluator/oracle digests only after those definitions declare supported
criterion versions, and an evaluator includes the exact digest of its previously published model
profile. Guessing a digest or asking for the latest version would break those publication boundaries.
Comparison predecessors also lack a logical comparison ID, while run results retain only a run ID.

[`readPolicyEvaluationSelector`](../../packages/core/src/policy/policy-evaluation-selector-reader.ts)
resolves these four forms through existing fixed read-only repository ports. It accepts an exact
parent source, its captured record/observation, scope, semantic evaluation time, occurrence pointer,
and finite parent-frontier limits. It does **not** accept a caller-supplied child selector, source
digest, validator, arbitrary URL, principal override, or mutable latest lookup.

## Parent binding before child I/O

The function captures its context before reading the supplied parent. Existing fixed inspectors
and enumerators revalidate the parent's schema, definition digest, scope, every reference field,
original receipt cut, and full-record observation hash. A changed receipt is not ignored simply
because the semantic digest is unchanged. The complete parent frontier must fit its count and
canonical UTF-8 byte limits before the selected occurrence can be read; no early truncation or
path shortcut bypasses the remaining parent fields.

Only an exactly enumerated pointer with a supported selector kind is accepted. Repeated selectors
at separate pointers remain separate occurrences, including array indices beyond nine. One exact
repository read follows. Copies isolate both the port's scope and returned records from mutations.
This integrity check is not authorization: trusted capture composition must supply the parent and
repository authorities, not public clients.

| Occurrence | Exact lookup | Additional relationship check |
| --- | --- | --- |
| `criterion_selector` | `findCriterionSet(scope, criterionSetVersionId)` | Logical set ID, immutable version ID, and membership of the exact criterion |
| `model_evaluator_selector` | Model assurance `find(scope, model_assisted_evaluator, evaluatorVersionId)` | Evaluator ID/version and all three fields of its reciprocal exact model-profile reference |
| `evaluation_run_identity` | `findEvaluationRun(scope, evaluationRunId)` | Exact run identity; observations and result derivation remain separate graph obligations |
| `comparison_predecessor` control declaration | `findComparisonDefinition(scope, comparisonVersionId)` | Declared version and digest, plus independently checked membership in the parent's logical comparison family |

Criterion resolution establishes supported-set membership, not that the criterion selected this
particular oracle/evaluator, is approved, applies to a task, or is correct. Model profile/evaluator
backreferences are legitimate logical graph cycles without circular definition hashing. Later
traversal must retain those edges and use bounded revisit accounting, not reject all backreferences
or recurse indefinitely. Global conflicts, ordering, history and cumulative budgets remain open.

## Outcomes and failure boundaries

Every response retains the parent source/hash and exact occurrence. `resolved` additionally returns
the validated child body, a full exact reference derived from that body, and its complete canonical
record SHA-256, including original receipts. Fixed owning validators reject malformed or incorrectly
hashed records; existing inspectors enforce all three scope dimensions and the full-precision
evaluation-time cut without replacing receipt fields.

`missing` means the selected port returned `null`. `unavailable` retains `record_invalid`,
`reference_mismatch`, `lineage_mismatch`, or `not_yet_available`. Both have `evidence: null`:
hashless missing selectors cannot become manifest entries by inventing a digest. They must remain
an explicit unresolved acquisition frontier. Neither outcome silently becomes an empty successful
dependency list or causes another version to be tried.

Malformed context or an unsupported/nonexistent selector occurrence throws
`PolicyEvaluationSelectorReadInputError`. Parent reinspection/conflict/limit failures retain
`PolicyEvaluationEvidenceReferenceError`. Repository exceptions propagate unchanged, including
domain-typed errors thrown by a port; an outage is not fabricated absence or invalid content.

## Verification and remaining integration

The [tests](../../packages/core/src/policy/policy-evaluation-selector-reader.test.ts) cover all eight
selector-bearing parent kinds and four lookup routes with actual memory repositories, independent
reference projections and full-record hashes, exact routing, malformed/missing records, substituted
IDs/scopes/digests, criterion membership, reciprocal profiles, unrelated comparison families,
receipt boundaries, parent substitution, whole-frontier limits, repeated occurrences, and mutation
across getters and asynchronous storage calls. The test graph retains an additional criterion set
declared by the model vector instead of rewriting that already-published evaluator/profile pair.

This helper performs one bounded parent expansion and one child read, not recursive capture or a
durable worker. The enclosing acquisition must account for cumulative reads, bytes, time, attempts,
and identities; acquire every subordinate record and retained artifact byte; verify mutable
authority/lifecycle revision guards; preserve unresolved frontiers; and seal an independently
derived complete snapshot. Qualification policies, implementation registries, trace selectors,
protocol/profile declarations and artifact-contained graphs require their own owning authorities.
No evaluator is executed, policy is satisfied, approval is granted, or release is authorized here.
