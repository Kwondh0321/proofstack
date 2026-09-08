# Policy evaluation comparison selection

[English](workflow-2-policy-evaluation-comparison-selection.md) |
[한국어](workflow-2-policy-evaluation-comparison-selection.ko.md)

Status: implemented source-selection building block; the policy-evaluation checkpoint remains open.

This slice implements the first exact candidate-owned selection rule required by
[ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.md) and the
[evaluation entry audit](workflow-2-policy-evaluation-entry-audit.md). It determines whether each
comparison definition used by a policy has a unique, missing, ambiguous, or unresolved result in
the candidate's complete declared comparison inventory. It does not validate the selected result's
complete upstream lineage, seal an input snapshot, compute a rule outcome, publish an evaluation,
or grant release authority. The subsequent
[comparison-lineage building block](workflow-2-policy-evaluation-comparison-lineage.md) now closes
the direct definition/result/snapshot and candidate-ownership boundary while leaving recursive
subordinate acquisition and sealing open.

## Root and acquisition boundary

`resolvePolicyEvaluationComparisons` independently validates canonical definition digests for the
request, candidate, and policy before selection. The request must bind the exact candidate and
policy references, all three records must have one tenant/project/environment scope, and the
candidate and policy publication receipts must be no later than the request's full-precision
`evaluationTime`. A corrupt or substituted root rejects the operation; it is not represented as
ordinary missing rule evidence.

Acquisition input must correspond one-for-one and in exact candidate order with every comparison
result reference declared by the candidate. Missing, extra, duplicated, reordered, or changed
references reject the inventory before classification. The capture boundary, rather than a public
caller, must obtain these records through exact authorized repository lookups. A `null` result means
that lookup established absence. Unexpected repository or transport failures must abort or retry
capture and must not be passed as absence.

Every returned record is schema-validated and has its semantic definition digest recomputed.
Reference and scope equality are checked independently. Records created after `evaluationTime`, or
whose latest source cutoff is later than that time, are unavailable to the historical evaluation.
The bounded inventory retains one observation for every candidate member:

| Observation | Meaning |
| --- | --- |
| `verified` | The exact result is valid, in scope and available at the requested time; its comparison and two snapshot references, source cutoff and full-record SHA-256 are retained |
| `missing` | The exact authoritative result reference was absent at acquisition |
| `unavailable` | The returned record was invalid, mismatched, cross-scope or not yet available |

The full-record hash covers the validated record's canonical JSON, including receipt fields. It is
separate from the result's semantic definition digest and does not by itself prove that the
result's snapshots or their upstream dependencies are valid.

## Complete-set classification

Policy comparison references are deduplicated only when their repository identity and exact
logical ID/digest agree. Reusing one comparison version identity with different references is an
integrity conflict. For every remaining definition, classification scans all candidate members:

| Status | Exact condition |
| --- | --- |
| `unique` | Exactly one verified member matches and every candidate member is readable |
| `missing` | No verified member matches and every candidate member is readable |
| `ambiguous` | At least two verified members match; all matching and unreadable references remain visible |
| `unresolved` | Zero or one verified member matches and at least one member is missing or unavailable |

An unreadable member can therefore never turn an uncertain set into `unique` or `missing`.
Two established matches remain `ambiguous` even when another member is unreadable and even if the
results contain equal values. Structural contract refinement recomputes each classification from
the complete member table, so a stored or transported inventory cannot omit an unreadable member,
fabricate a match, or replace ambiguity with a favorable result reference.

## Verification and remaining gates

Contract tests cover all four classifications, complete unresolved membership, fabricated matches,
member and policy ordering, duplicate policy identities, and baseline/candidate snapshot-role
substitution. Core tests cover request digest validation, defensive copies, zero/one/multiple
matches, unreadable members, valid absence, invalid/mismatched/future/cross-scope results, complete
acquisition inventory, root substitution, scope and time boundaries, and conflicting policy
references.

This is deliberately not the sealed `PolicyEvaluationSnapshot`. The follow-on lineage validator
now verifies the direct definition, result, snapshots, candidate-owned dataset, replay target, and
assessment references and deterministically re-derives the result. Recursive subordinate-record
acquisition, complete expected-source closure, manifest observations, policy installation/source/
lifecycle authority, artifact revision guards, and one consistent seal remain next. Rule evidence,
applicability, evaluation results, repositories, durable jobs, worker authority, API, SDK, recovery
and checkpoint acceptance all remain open. This slice does not change the roadmap's completed item
count.
