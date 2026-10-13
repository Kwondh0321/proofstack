# Strict rule inputs for policy snapshots

[English](workflow-2-policy-snapshot-rule-inputs.md) |
[한국어](workflow-2-policy-snapshot-rule-inputs.ko.md)

Status: rule-component contract prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`PolicyEvaluationSnapshotRuleInputs` version 0.1 retains the exact request, scope, full-precision
evaluation time, candidate/policy body witnesses, original rule count and every complete rule in
original policy order. All seven predicate kinds use strict, bounded input families. The contract
rejects omitted/reordered rules, substituted source kinds or identities, extra authority fields,
incorrect operand selection and fabricated approval. It is a component of future sealed input,
not a complete snapshot, a policy result or a public submission API.

Comparison inputs preserve the complete owning selection, including zero, unique, ambiguous and
unresolved mappings. A bound metric retains its original definition, result, stratum, calculation
policy, comparability, pairing and source cutoff. Four exact source witnesses bind its comparison,
selected result and baseline/candidate snapshot roles. Metric indices use the existing metric and
stratum ceilings; future source cuts cannot become current operands. Incompatible evidence remains
retained: this contract does not invent compatible units, qualification or a successful predicate.

Assessment inputs preserve declared membership and missing/unavailable observations. Available
inputs retain the original assessment witness and bounded aggregate/policy projections. Coverage
keeps every verdict count and its declared decided/observed field. Uncertainty keeps the original
Wilson interval, confidence, supported assumption, successes/trials and selected bound; a reported
interval must bind the original pass/decided counts. Evaluation eligibility retains its original
dimensions and reasons; model eligibility retains its reasons and base assessment reference.
No full aggregate member list, upstream run body or classified content is copied into these inputs.

Artifact inputs distinguish a missing component, alias-only model declaration and declared artifact.
They retain the exact content descriptor, catalog body hash, ownership and captured content
observation. Verified content requires the unchanged digest/size and a catalog witness.
Missing, invalid, unsupported or mismatched catalogs retain no valid catalog witness; later
content/lifecycle failures retain their validated catalog. Contradictory presence is rejected.
Ownership must match the exact scope and artifact identity. Missing or unreadable content is retained without
manufacturing verified bytes. Approval inputs remain `not_evaluated` with `approval_not_evaluated`;
the original rule separately preserves group, role, quorum, conflict and independence requirements.

The server-owned rule composer first reproduces the original artifact, comparison and assessment
reports, full rules and dependency closure. Its internal fixed projection then validates this
contract without additional repository, object or key I/O. The returned `snapshotRules` includes
separate inspection usage: context/rule frames and selected witnesses consume remaining reference
admission, and each complete canonical frame consumes remaining byte admission. Capture adds
these charges to the same cumulative acquisition meter; no parsing or projection resets budgets.
These frame charges are not a wire-transfer or native database-query budget.

`encodePolicyEvaluationSnapshotRuleInputs` uses the existing canonical JSON encoder, domain
`proofstack.policy-evaluation-snapshot-rules.v1` and encoding
`proofstack.policy-evaluation-snapshot-rules-jcs.v1`. The independent Python JSON/UTF-8/hashlib
[vector](../../packages/contracts/vectors/policy-evaluation-snapshot-rules-v1.json) binds original
rules, unresolved inputs and exact request/root/source identity. Schema checks and projection
digests cannot recompute or authenticate full source bodies; owning source verification still
precedes projection, and complete snapshot validation must join every witness to its manifest.

Complete authority/selector/artifact/trace closure, whole snapshot/result and transport contracts,
same-transaction guarded snapshot/job/fence publication, native job-wide admission, all seven
predicates, durable workers, API/SDK/recovery and the independent checkpoint-3 exit audit remain
open. A read-only `sourceRecheck` ends its transaction before returning; it cannot authorize later
publication of these inputs. Checkpoints 4–7 and measured scale work remain dependent on their
respective entry and exit gates.
