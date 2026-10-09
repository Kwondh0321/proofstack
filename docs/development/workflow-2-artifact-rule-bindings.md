# Candidate-owned artifact rule bindings

[English](workflow-2-artifact-rule-bindings.md) |
[한국어](workflow-2-artifact-rule-bindings.ko.md)

Status: retained input provenance implemented; Workflow 2 checkpoint 3 remains open,
with 2/7 checkpoints accepted. This report does not evaluate a predicate or seal input.

`capturePolicyArtifactEvidence` returns `artifactRules` from its fixed internal
[`inspectCapturedArtifactRules`](../../packages/policy-evaluation/src/capture-artifact-rules.ts).
The inspector independently revalidates the complete request-owned candidate and policy
bodies, original receipts/hashes and bounded parent references before interpreting roles.
It adds no repository, object, key or network I/O. The package exports its report type,
not an inspector accepting arbitrary caller graphs or computed policy results.

## Complete candidate declarations and original rule occurrences

The report retains both exact root sources and full record hashes. `members` contains
every candidate build artifact and runtime component in their original array order,
including unused components. Each artifact descriptor binds its original candidate
edge and actual authorized artifact-capture index. Captured scope, semantic time,
descriptor, catalog projection and verified plaintext digest/size must agree.

Every `artifact_required` rule appears in original policy order, with its original
predicate, rule index and policy edge. Component selection uses exact kind and role:

- `build_artifact`: the candidate's build artifact role.
- `prompt` and `tool_contract`: their exact runtime component kind and role.
- `model_resolution`: the model role's exact retained `resolutionEvidence`.

The owning candidate schema rejects duplicate component identities. A missing role
retains its exact explicit omission, if one exists; it does not invent a descriptor
or retrieve a similarly named artifact elsewhere. An alias-only model is a present
component with a separate `model_alias` member and its original declaration. It has
no resolution artifact/capture index and cannot supply exact model-version evidence.

Repeated rules retain separate occurrences even when they share one member. Media
type and classification constraints remain the original predicate. Verified bytes
do not by themselves satisfy those constraints. Present components with missing,
expired, tombstoned or unverifiable content remain present declarations; the original
artifact observation keeps the reason separately from genuine component absence.
Catalog ownership remains in the original capture. Generic candidate artifacts do
not receive recorded-fixture-only ownership requirements, and partial catalog fields
are not substituted for the owning private full-record hash.

## Admission and remaining boundaries

Complete parent references, every candidate component and repeated policy use are
charged to the same invocation-wide reference count and canonical UTF-8 byte meter.
Actual record bytes share the acquisition ceiling with reference bytes. Exact limits
pass and one below fails without a partial report. Broken root/edge/capture provenance,
duplicate origins, substituted scope/time/descriptor and inconsistent verified
content fail wholly. Returned arrays, declarations and omissions are owned copies.

This closes an input join only. Complete semantic/current authority and presence
closure, typed sealed operands, guarded atomic snapshot/job/fence publication,
deterministic predicates, durable workers, API/SDK, recovery and the independent
checkpoint exit audit remain open. A source recheck ends before returning its report;
these indexes never authorize publication after its guards have been released.
