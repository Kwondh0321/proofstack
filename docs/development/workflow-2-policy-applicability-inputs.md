# Candidate-bound policy applicability inputs

[English](workflow-2-policy-applicability-inputs.md) |
[한국어](workflow-2-policy-applicability-inputs.ko.md)

Status: retained applicability inputs implemented; Workflow 2 checkpoint 3 remains
open with 2/7 checkpoints accepted. These inputs are not a policy result or seal.

`capturePolicyArtifactEvidence` returns `applicability` from the fixed internal
[`inspectCapturedPolicyApplicability`](../../packages/policy-evaluation/src/capture-policy-applicability.ts).
It independently revalidates both exact request roots, full original bodies and
receipt hashes, complete parent references and the original installation binding.
Scope, evaluation time and ordered roots must agree. Verified installation records
must preserve exact installation/version/digest identity and scope. Missing binding
observations remain explicit; a replacement or latest binding is never selected.

## Authority before conditions

The projection reuses the existing owning static policy-authority inspector once;
the original `policyAuthority` report remains available. It revalidates the complete
captured root lifecycle through the owning lifecycle reader over retained copies,
without external repository I/O. Original terminal events and successor lineage,
full hashes, semantic state, observation digest and ordered millisecond receipts
must agree. A successor remains lineage evidence, never a substitute policy root.
Semantic evaluation time retains its supported fractional precision.

Invalid static authority, including unavailable installation/source/content,
not-yet-effective or expired policy, or a terminal event at evaluation time blocks
condition inspection. Every original selector/target pair remains present with
`not_evaluated` and `authority_unverified`. A convenient mismatch cannot create
`not_applicable` from invalid authority. A legitimately later terminal event remains
captured while the historical evaluation state is derived at the requested time.

## Seven complete dimensions

The fixed order is jurisdiction, locale, maximum data classification, population
tags, purpose, risk tier and task kind. Each dimension retains its original policy
and candidate JSON pointers, original selector, exact target value (or explicit
`null` for a genuinely absent optional value), status and bounded explanation.

- `any` explicitly matches, including an absent optional value.
- `absent` matches genuine optional absence and mismatches a present value.
- `equals` and `one_of` use exact equality/membership; an absent required optional
  value is `unknown`, never an empty string or established mismatch.
- `contains_all` and `exactly` compare the complete schema-validated sorted unique
  declared population set. Explicit empty `exactly` is a legitimate set.
- Enum conditions have no invented ordering of risk or classification. Artifact
  classification ceilings retain their separate existing ordered semantics.

With valid retained prerequisites, an established mismatch dominates the descriptive
conjunction; otherwise unknown dominates; otherwise every condition matches. All
seven observations/explanations remain, including unknowns alongside a mismatch.
The conjunction uses `match`, `mismatch`, `unknown` or `not_evaluated`; it is not a
policy outcome, human approval or certification of complete current authority.

## Admission and remaining work

Complete candidate/policy/binding reference reinspection, retained context and all
seven dimension frames consume finite canonical UTF-8 count/byte admission. Owning
static-authority inspection is charged separately once to the same invocation.
Record bytes share that ceiling; exact limits pass and one below fails before any
metadata transaction opens. Reports own their nested copies and add no external
dependency, role, grant, migration, route, worker or publication port.

`authorityBoundary` is explicitly `retained_prerequisites_only`. Complete semantic,
presence and mutable authority closure, strict sealed contracts, same-open-transaction
snapshot/job/fence publication, all seven predicates, durable jobs, API/SDK, recovery,
contributor acceptance and the independent checkpoint exit audit still remain.
An ended recheck report cannot authorize a later publication.
