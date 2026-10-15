# Installation-owned gate policy selection contracts

[English](workflow-2-policy-selection-contracts.md) |
[한국어](workflow-2-policy-selection-contracts.ko.md)

Status: checkpoint 4 contract prerequisite; persistence, current authority and decisions remain open.
Workflow 2 remains 3/7 accepted checkpoints.

## Accepted dependency and scope

The [decision entry audit](workflow-2-decision-entry-audit.md) and
[ADR-0036](../architecture/0036-bind-decisions-to-current-selection-and-reviewer-authority.md)
fix the decision boundary. Entry publication at
`c6acd147fe71c5ab148f184650eacd857589b393` passed the uncached full cloud gate: 16,309 package
tests plus 16 runner tests (16,325 total), 31 builds and both Turbo phases uncached (93 + 29).
Its log SHA-256 is `4473eb05c477cd5fcc602506bf3c6482ed2c94c053fc2951909fabfab003ac88`.
[CI 38764185084](https://github.com/Kwondh0321/proofstack/actions/runs/38764185084) passed all
13 jobs; [Security 38764185029](https://github.com/Kwondh0321/proofstack/actions/runs/38764185029)
passed CodeQL. Exact clean HEAD and remote main matched; receipt SHA-256:
`c1618446b9306c0058d7f2541b359976c9b414a0bb3edb7c67cc2b0efc73c949`.
These are entry evidence, not acceptance of the subsequent contract commit.

The new [contracts](../../packages/contracts/src/release-policy-selection.ts) describe immutable
installation selection, compact exact references, server receipts and append-only withdrawal or
supersession. They add no database table, role, capability, route, worker, approval or decision.

## Complete exact target and finite inventory

A definition binds full tenant/project/environment scope, installation, named gate target, logical
selection/version identity, the complete original `ReleaseCandidateTarget`, issuer, authorized
decision publishers, authority artifact, rationale, UTC validity and optional exact predecessor.
Target fields retain task, purpose, classification, risk, population tags, jurisdiction and locale;
environment must equal scope. Gate target is an opaque identifier, not a URL or executable callback.

At most 16 selected exact policy references are ordered by distinct logical policy ID; two versions
of the same logical policy cannot hide in one inventory. Each retains its explicit advisory or
mandatory mode and optional installation-owned exception requirement. At most 32 distinct ordered
publisher IDs are retained. These bounds do not change the existing 128-rule policy limit.

`enforce` requires at least one explicit mandatory policy. `observation_only` cannot contain one;
it may explicitly install an empty or advisory-only inventory. Missing selection authority is not
an empty inventory and cannot parse as one. Owning publication must later compare every mode with
the actual policy: parsing a caller's advisory mode cannot downgrade a stored mandatory policy.
Owning reads must prove complete current selection and policy lifecycle, source authority and
exact target applicability; a valid shape is insufficient.

## Explicit exception authority

`nonWaivable=false` never invents an approver or quorum. An optional exception requirement reuses
the existing strict `PolicyApprovalRequirement` with candidate-author exclusion and a nonempty
independent human group. The bounded reference requires this for every exception, including lower
risk, so it cannot guess later rule impact from a compact policy reference. Policy authors remain
excluded. An absent requirement installs no exception authority. Required actual OIDC users,
current reviewer authority, unique-principal/group matching and evaluator exclusion remain later
owning application/native checks; these contracts do not manufacture them.

Normal policy approvals retain their original declaration. Evaluation `approval_required` remains
indeterminate with `approval_not_evaluated`; this slice changes no result or predicate semantics.

## Canonical identity, time and byte admission

The [encoder](../../packages/contracts/src/release-policy-selection-encoding.ts) retains schema
`0.1`, domain `proofstack.release-policy-selection.v1` and encoding
`proofstack.release-policy-selection-definition-jcs.v1`. It includes the entire definition and
the exact equal scope in the canonical envelope. Server publication fields and arbitrary authority,
result, secret or callback fields are rejected. Optional undefined JS fields are absent JSON.

UTC times retain supported native precision; expiry must follow effectivity and publication must
precede expiry. These checks do not read a clock or prove freshness. Supersession/predecessor
references retain logical selection, installation and gate identity and name a different version.
Owning repositories must still verify digest, scope, complete history and publication chronology.
There is no reactivation or overwrite event.

Definition admission measures canonical UTF-8 JSON at **256 KiB**, independently of character and
collection limits. A separate **4 KiB** receipt/envelope reserve is fixed. Tests construct valid
maximum inventories with non-BMP text at one byte below, exactly at and one byte over the ceiling;
an actual serialized server receipt with an escaped maximum request identifier fits the reserve.
Transport parsing and API deadlines remain unimplemented and must independently enforce their
eventual wire bounds. Canonical envelope domain/scope overhead is separate from definition bytes.

Two fixed [public vectors](../../packages/contracts/vectors/release-policy-selection-definition-v1.json)
were independently generated using Python sorted JSON over scalar strings and integral numbers:
mandatory selection with explicit exception protocol, 1,963 bytes and SHA-256
`87972818ae7ba175fc64d2f24122fbf4485b905c3181c44435619ee18e4e1124`; explicit empty observation,
1,426 bytes and `ff4198ed95d5c6f66f78c99b3e41ed3e5e618b8c54ed30c0c5bbd4a13f7b81b4`.
TypeScript canonical encoding must match both. Tests cover scope substitution, whole-target and
policy/version/authority/publisher/time/rationale changes, object ordering, unknown fields,
duplicated inventories, exception exclusions, native time and lifecycle identity.

## Remaining dependency order

The focused contract pair passed 39 cases. The full contracts package passed 6,138 cases with
unchanged coverage thresholds; the new encoder has 100% coverage and selection contracts have
100% statements/lines/functions and 97.56% branches. These are precommit focused gates, not the
exact-commit full repository or native integration gate.

This commit needs its own full uncached check, all 13 exact-SHA CI jobs and CodeQL before dependent
code. Then freeze reviewer/approval/decision contracts and independent matching/decision oracles;
add shared memory conformance and guarded current native authority, role provisioning and recovery;
add authorization-first API/OpenAPI/SDK and actual user-session contributor flows; complete the
adversarial exit audit. No checkpoint acceptance, current human approval, signature, CI gate,
deployment, production expertise or scale claim follows from this prerequisite.
