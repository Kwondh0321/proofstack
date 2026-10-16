# Reviewer authority, original approval receipts and bounded group assignment

[English](workflow-2-release-approval-contracts.md) | [한국어](workflow-2-release-approval-contracts.ko.md)

Status: checkpoint 4 contract/assignment prerequisite. Workflow 2 remains 3/7 accepted checkpoints.
Current authorization, repositories, native publication, decisions, API and contributor acceptance
remain open under the [decision entry audit](workflow-2-decision-entry-audit.md) and
[ADR-0036](../architecture/0036-bind-decisions-to-current-selection-and-reviewer-authority.md).

## Accepted dependency

[Installation selection contracts](workflow-2-policy-selection-contracts.md) at
`40cf38f07278c09410d60bf26ae96dc5fc5a5411` passed 16,348 package plus 16 runner tests
(16,364 total), 31 builds and both uncached Turbo phases (93 + 29 tasks). Exact full log SHA-256:
`7a78b6a9fcc4ef00209edcb454c6714969be001101997ff4f99807be9288a7ab`.
[CI 38768468831](https://github.com/Kwondh0321/proofstack/actions/runs/38768468831) passed all
13 jobs; [Security 38768468715](https://github.com/Kwondh0321/proofstack/actions/runs/38768468715)
passed CodeQL. Clean local HEAD, actual remote and GitHub main agreed; exact receipt SHA-256:
`f77ebbce328b04c2efa691424cbc780a8263d78e863d2c1139add8e503b6fb3c`.
These checks accept the dependency, not this subsequent prerequisite commit.

## Attributable current-authority declarations

[Reviewer authority contracts](../../packages/contracts/src/release-reviewer-authority.ts) retain
exact scope, installation/gate, logical authority/version, reviewer and distinct issuer, eligible
roles/groups, affiliations, relationships, conflicts, retained review basis, rationale, validity
and predecessor. Memberships are unique and bounded by the policy's original 32-role/group limits.
An issuer cannot grant their own reviewer authority. Verified declarations cannot hide conflicts
or unresolved reasons; rejected/unverifiable declarations require reasons. Append-only revocation
and supersession retain the exact logical reviewer/installation target. A parser proves none of
the issuing actor's authority, source truth, qualification, human presence or current lifecycle.

`operator_verified` and `synthetic_reference` remain explicit provenance values. Every committed
example vector uses synthetic reference authority. Actual OIDC authenticates an account, not
expertise. Owning application/native logic must prevent synthetic reference assumptions from
being silently represented as real human approval or production authority.

## Public intent versus original authenticated action

[Approval contracts](../../packages/contracts/src/release-approval.ts) keep normal approval and
known-rule exception distinct. The exact subject binds scope, selection, candidate, policy,
evaluation request/job/snapshot/result and rule. It is untrusted input: a later route must derive
tenant and authorized scope from the actual principal before lookup and reject a foreign subject.
It must rederive every original relationship and installed requirement, not trust matching IDs.

Public intent names action, exact subject, rationale, declared conflicts, non-executable conditions,
compensating-control references, expiry and optional supersession. It cannot supply reviewer,
authentication receipt, authority, recording time, result or execution identity. `approve`,
`oppose`, `escalate` and `abstain` are attributable review actions, not release dispositions.
Conditions/conflicts can be retained as claims; shape admission does not count them as eligible
support or resolve them. An affirmative exception requires retained control evidence; ordinary
approval cannot smuggle exception controls. Retained bytes do not automatically prove a control.
Unknown conditions remain unresolved; they cannot silently disappear from a successful decision.

The server-derived immutable definition includes original OIDC user, credential/request IDs,
authentication time, exact reviewer-authority reference and native recording cut. Authority must
bind the same reviewer and installation target. The action must follow authentication and precede
exact expiry. No private session proof, session digest, cookie or bearer token is a public record field.
Revocation is a separate original-user receipt and does not overwrite the action or evaluation.

The [canonical encoder](../../packages/contracts/src/release-approval-encoding.ts) includes original
authentication and recording time in the approval digest. Future retry equality must compare exact
intent and reviewer identity after current authorization, then return the original stored record;
it cannot reissue that digest with a new login/time or let another reviewer reuse an action ID.
Original read integrity, current session/grant/authority and held native publication remain required.
Public receipt IDs alone cannot authenticate a native approval function.

## Time, strict bytes and fixed vectors

Both definitions retain UTC semantic precision and strict unknown-field rejection. Authority
definition admission is 64 KiB; public approval intent is 60 KiB with 4 KiB reserved for the
server-derived actor/authority/cut, giving a 64 KiB approval definition ceiling. Each response has
a further 4 KiB reserve. Tests independently measure JSON UTF-8 at one byte below, exactly at
and one byte above each admitted input ceiling using non-BMP scalar text, and serialize actual
receipts with escaped maximum request IDs. Transport bounds remain a separate later API gate.

Three [fixed vectors](../../packages/contracts/vectors/release-approval-definition-v1.json) were
independently generated with Python sorted scalar/integer JSON. TypeScript must match exact bytes
and hashes: reviewer authority 1,374 bytes, normal approval 2,307 bytes and exception 2,543 bytes.
Domains are `proofstack.release-reviewer-authority.v1` and `proofstack.release-approval.v1`, with
distinct definition-JCS encodings. Exact scope equality and original actor/session/reference/time
changes are checked; private proof and authority/result/receipt smuggling are rejected.

## Internal assignment witness

[Group assignment](../../packages/core/src/release/match-reviewer-groups.ts) is an internal pure
combinatorial utility, not a package-root capability or approval decision. A complete owning
eligibility pass must first establish actual user/session, roles, current authority, absence,
authors/evaluator exclusions, conflicts and action/lifecycle state under held publication guards.
The utility never reads time, authenticates a reviewer or establishes source completeness.

The finite graph now admits at most 4,096 distinct principals and 32 groups; one person occupies at most one
group and each group at most one person. A required human-group witness must be met alongside
the actual quorum. Unknown required groups, duplicated people/memberships, truthy human flags,
malformed IDs and caller authority fields are rejected. Other non-eligible group memberships
cannot create an edge. Output is an actual witness, not a complete reviewer census.
Owning inventory admission must reject an over-budget graph wholly rather than select favorable
people from a larger set. Current opposition and unavailable authority cannot disappear through sampling.

The initial assignment slice admitted 512 people. The [complete captured review implementation](workflow-2-current-release-reviews.md)
aligns that bound with the frozen 4,096-row approval admission and tests the complete larger graph.

Rectangular minimum-cost assignment admits at most groups-minus-quorum unmatched rows. Human
edges are preferred among feasible quorums; impossible edges cost more than all human bonuses and
never appear as supporting evidence. Matrix size is bounded; no external dependency was added.
A first implementation incorrectly prioritized maximum seats over a valid smaller human quorum;
its regression failed before correction. Both flexible/single-group and human-quorum counterexamples
remain. An independent exhaustive enumerator checks all 512 three-by-three membership graphs,
8 human masks, 8 required-group masks and 3 quorums: 98,304 comparisons. Larger bounds, input-order
invariance, unique witnesses and malformed/duplicate identities are covered separately.

## Remaining acceptance

Full uncached repository checks, unchanged coverage, exact-commit CI 13 jobs and CodeQL are required
before dependent work. Complete deterministic decision contracts/oracle, memory/shared conformance,
current guarded authority/session publication, distinct roles/capabilities/recovery, authorization-first
API/OpenAPI/SDK, real user-session contributor and the checkpoint exit audit. C3 approval predicates
remain indeterminate with `approval_not_evaluated`. No approval, decision, signature, CI enforcement,
deployment or production qualification is established by these parsers or matching witnesses.
