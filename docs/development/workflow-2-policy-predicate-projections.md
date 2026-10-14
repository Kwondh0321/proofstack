# Pure policy predicate projections

[English](workflow-2-policy-predicate-projections.md) | [한국어](workflow-2-policy-predicate-projections.ko.md)

Status: internal calculation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The internal `evaluatePolicyPredicateProjection` helper validates one existing strict rule
projection and produces one bounded `PolicyEvaluationRuleResult`. It preserves the original
rule index/identity, exact operands and source-specific missingness. It has no database, object,
clock, random, worker-mutation or publication port, and is not exported by the core package root.

All seven predicate kinds are covered: exact comparison thresholds; same-population count/ratio
coverage; retained Wilson bounds with the original method/version/confidence/sampling assumptions;
evaluation/model eligibility; required artifact type/classification/content; safety event ceilings;
and the explicit unevaluated approval prerequisite. Numeric comparisons reuse the existing exact
integer/rational primitives. No floating-point ordering or overall safety score is introduced.

Known ineligibility, missing declared components/artifacts and incompatible declared artifact
types can violate their explicit requirement. Unavailable observations remain indeterminate.
A known safety excess can violate even with incomplete candidate observation, while preserving
that limitation. Satisfaction requires complete observed candidate population rather than a
paired subset. Approval always remains indeterminate with `approval_not_evaluated`; model
assurance does not become a human approval.

Tests use retained independent contract vectors plus a Python `fractions.Fraction` numeric oracle
for signed rational/large integer boundaries and all six comparators. Synthetic source witnesses
do not establish source authority, provider honesty or real reviewer qualifications. Strict
shape checks reject conflicting source roles, inconsistent metrics and unknown fields before
arithmetic. Original source detail/reasons remain in the owning snapshot rule projection.

This helper is not an owning sealed-input evaluator. Its caller must first validate the complete
snapshot record/pages against the authoritative job/request/scope/reference, rederive exact
source/projection/closure bindings, and apply global policy/candidate/criterion authority,
applicability and source qualification gates. Shape validity or a helper's favorable result
cannot replace those gates. An owning evaluator must preserve all original rules and derive
the complete result against the same sealed input; authoritative result reads must recompute it.

Durable complete source admission, shared memory/native conformance, the owning whole-snapshot
evaluator, atomic result/attempt/job/outbox publication, worker/API/SDK/contributor integration
and independent checkpoint exit remain open. Historical projected data is not fresh publication
authority, and this calculation grants no approval, attestation or release permission.
