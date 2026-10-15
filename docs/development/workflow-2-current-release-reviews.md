# Captured current release reviews

[English](workflow-2-current-release-reviews.md) | [한국어](workflow-2-current-release-reviews.ko.md)

Status: checkpoint 4 captured reviewer/normal-quorum prerequisite; Workflow 2 remains 3/7 accepted.
See [ADR-0041](../architecture/0041-resolve-complete-captured-normal-review-quorums.md), the
[entry audit](workflow-2-decision-entry-audit.md) and [source inspection](workflow-2-decision-source-validation.md).

## Accepted source dependency

`e715a3c5fa909ff591944a6831a52057fac01052` passed the uncached whole-repository check:
16,773 package + 16 runner tests (16,789 total), 31 builds and both Turbo phases (93 + 29 tasks)
with zero cached tasks and unchanged source/index. Full log SHA-256:
`e9136f83c8b88c9e5c5c305de8c21006cc023723c55b1958b4e29ea7550979db`.
[CI 38818023963](https://github.com/Kwondh0321/proofstack/actions/runs/38818023963) passed all
13 jobs; [Security 38818023945](https://github.com/Kwondh0321/proofstack/actions/runs/38818023945)
passed CodeQL. Exact clean checkout/origin/actual remote/GitHub main receipt SHA-256:
`b9954b4a61446afb58bba6187d5ad11a7080f28bea027ebf5ac9484c103d94f4`.
These dependency results are separate from this slice's eventual exact-commit gates.

## Authority and original reviewer eligibility

[Reviewer census](../../packages/core/src/release/release-reviewer-census.ts) validates every
retained exact authority version and terminal event. Missing predecessor/event/successor closure
stays unavailable. Duplicates and competing current versions stay conflicting. Revocation and
supersession retain the original version. A reverse-ordered 256-version chain uses bounded,
non-recursive traversal. The owning reader still must verify complete logical-root enumeration
and absence guards for the installation/gate/reviewer target.

[Eligibility](../../packages/core/src/release/captured-release-reviewer-eligibility.ts) binds the
original user/OIDC action, current grant/capability/resource scope and native session state.
Authority must be effective both at the original action and current cut. Reviews before native
session creation or at/after absolute expiry cannot qualify. Natural expiry of an old login alone
does not erase an already-recorded review; explicit revocation and current grant changes apply.
Every new action still requires actual live authentication through its owning boundary.

Policy authors never qualify. An optionally permitted candidate author can occupy an ordinary
seat but is not an independent human witness. Exceptions additionally exclude candidate authors
and original evaluators; missing evaluator provenance stays unavailable. The context must come
from owning original sources, not a public author list. Synthetic authority remains explicitly
synthetic and cannot certify real expertise.

## Complete normal approval and distinct witnesses

[Normal quorum resolution](../../packages/core/src/release/captured-normal-approval-quorum.ts)
requires the complete exact subject/kind census and original actor bindings. It validates canonical
record digests, scope, native receipts, exact supersession and revocation. It does not select latest
actions or filter wrong subjects/kinds out of a supposedly complete owning query.

Expired/revoked/superseded actions remain observed. Active opposition and escalation block matched
approval; abstention contributes no seat. Conflicting histories, duplicate active principal actions,
declared conflicts and unresolved conditions cannot be hidden behind enough positive votes.
An actual reviewer may supersede their own exact action, never someone else's. A new revocation
receipt does not replace the original approval's receipt. Native authenticated creation is separate.

Every observed source is charged to the original shared row/byte/approval meter. Repeated physical
binding/session/authority/event preimages must agree, including across different principal labels;
history ordering alone is not a difference. Catching quota failures cannot publish a partial cut.

The assignment helper now admits the complete original 4,096-row approval bound, rather than a
favorable 512-person subset. Independent exhaustive small graphs remain unchanged. Full resolution
of 4,096 actions charges 20,480 normalized records and retains the last required human-group member.
Each selected support retains its exact reference, principal, group and assurance. Validity is the
earliest selected approval/authority expiry; it does not extend the old login or original approval.

## Remaining publication gates

A matched result is a captured-data calculation, not actual authentication, complete current
source authority or permission to publish later. The read-only helpers hold no transaction.
Do not accept a caller's census/context/matched report as authorization. They expose no public route.

Next close complete versioned cut/actor provenance, actual owning sources and exception/control
verification, memory/shared behavior, native identity/absence guards and atomic graph+decision+
outbox, reservations/recovery, API/SDK, real-service contributor and the independent exit audit.
No production credentials, signing, external CI status or checkpoint 4 completion is introduced.
