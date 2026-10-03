# Captured policy assessment membership

[English](workflow-2-policy-assessment-bindings.md) |
[한국어](workflow-2-policy-assessment-bindings.ko.md)

Status: request-owned declaration inspection; Workflow 2 checkpoint 3 remains open.

`capturePolicyRecordGraph` now includes `policyAssessments`. A policy can reference an assessment
that is readable in the same scope but absent from the release candidate's declaration. This
report makes that distinction explicit before later rule projections consume assessment evidence.

## Exact roots and occurrences

The internal inspector uses the invocation's exact request candidate and policy, including their
full captured record hashes. It never selects another captured policy version or a latest record.
If either root is missing or unavailable, `roots_unavailable` retains those observations instead
of returning a successful empty rule inventory.

For verified roots, `members` retains every candidate `assessments` and
`modelAssuranceAssessments` declaration in that order, including unused and unreadable members.
`rules` retains each assessment-bearing rule in original policy order: assessment-sample
`coverage_floor`, `uncertainty_bound`, and both classes of `eligibility_required`. Repeated uses of
one assessment remain separate occurrences. Each item points to its original graph edge; the
candidate and policy root observations retain their full record hashes.

Membership requires the exact source kind, repository ID and definition digest. `declared` includes
the candidate edge index; `not_declared` is a known declaration mismatch, even when the record is
otherwise verified. Missing/unavailable/verified record observations remain a separate field.
A missing declared record never becomes verified through membership. Conflicting references under
one identity fail graph acquisition rather than choosing a convenient digest. The inspector adds
no repository, object, key, or network I/O.

## Admission and boundaries

Every candidate declaration and policy assessment occurrence consumes a reference and its canonical
UTF-8 bytes again for this inspection. `inspectionUsage` reports that additional work; graph
`usage.references` and `usage.referenceBytes` include it under the existing cumulative request
limits. Deduplicated record reads do not erase repeated policy uses. Limit or provenance failures
return no partial graph.

This report proves only a relationship between captured declarations. It does not establish
assessment-to-aggregate/run/criterion/dataset/target lineage, semantic eligibility, applicability,
current source authority, complete closure, or any predicate outcome. Existing snapshot and
model-assurance consistency reports remain separate prerequisites. Future closure must join and
validate all of them before freezing typed rule operands and sealing a snapshot. The
[guarded source recheck](workflow-2-policy-source-recheck.md) remains a report after a completed
read-only transaction, not permission to publish later from released guards.

The regression suite covers every supported assessment predicate, repeated and unused declarations,
readable non-members, missing/invalid/wrong-reference/future records, unavailable roots, conflicting
digests, graph provenance corruption, defensive results and exact/one-below count and byte limits.
No public API, scheduler, database role, release approval or checkpoint acceptance is introduced.

The subsequent [candidate assessment lineage report](workflow-2-candidate-assessment-lineage.md)
joins retained histories with candidate dataset/target and fixture membership. It remains separate
from this declaration report and does not complete source authority or sealing.
