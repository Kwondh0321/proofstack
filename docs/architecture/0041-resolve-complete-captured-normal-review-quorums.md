# ADR-0041: Resolve complete captured normal-review quorums

Status: Accepted captured-data design. Owning current sources, publication and checkpoint 4 remain open.

Date: 2026-10-15

## Context

[ADR-0040](0040-inspect-owned-release-authority-preimages.md) validates original source preimages.
Group matching alone cannot establish current reviewer eligibility or retain opposing actions.
The original assignment helper also admitted only 512 people while the frozen aggregate approval
read contract admits 4,096 rows. Truncating a valid census could hide the only required human group.

## Decision

Inspect complete captured installation/gate/reviewer authority histories. Preserve exact original
versions, predecessor/successor closure, competing active versions, revocation and supersession.
The owning reader must separately establish the immutable logical-root binding and guarded absence.

Derive reviewer eligibility from the original action receipt, exact authority, original action time,
current binding/grant and native session state. Current authority must also have been effective and
published at the original action; a later authority publication cannot repair that missing original authority.
Preserve current capability/resource scope, known inactive versus unavailable states, role/group
membership and synthetic provenance. A declaration is not expertise certification.

Always exclude the policy author. A policy may permit a candidate author in an ordinary approval
seat, but that person cannot satisfy an independent-human requirement. Exceptions additionally
exclude candidate authors and all original evaluators; unknown evaluator provenance cannot qualify.
The fixed owning composition must derive those authors/evaluators from exact original sources.
Public requests cannot supply the context or declare an actor independent.

Resolve normal approval from the complete exact immutable subject and kind. Wrong subjects/kinds
are invalid owning census data, not records filtered out to improve a result. Supersession must
retain the same subject, kind and principal. A revocation retains an original reviewer's actual
new action receipt; it cannot impersonate another person. Owning authenticated mutation remains a
separate gate. Preserve every action and terminal event; never infer supersession from latest time.

Missing history or actor bindings stays unavailable. Duplicate/forked histories and multiple
unsuperseded active actions by one principal stay conflicted. Preserve eligible opposition,
escalation and abstention. Opposition/escalation blocks a matched result; abstention contributes no
seat. Active declared conflicts and unresolved approval conditions cannot be discarded for a
favorable witness. Arbitrary condition prose is not automatically verified.

Inspect every retained actor and source even when its action is expired, revoked or superseded.
Count actual approval rows, actor bindings, complete authority histories and current grant/session
observations against the same original aggregate meter. Repeated physical binding, credential,
authority and lifecycle observations must agree; inconsistent preimages make the cut unavailable.
Compare physical source identity separately from principal labels and normalize history ordering.

Match all eligible unique principals against distinct groups using the existing assignment
algorithm and independent exhaustive small-graph oracle. Align its person bound with the existing
4,096 approval-read admission. Exact 4,095/4,096 matching cases and a full 4,096-action resolution
retain a final required human-group member. The full case charges 20,480 normalized records.
No source collection is favorably truncated. Preserve original receipt/hash and assurance on every
supporting witness; returned validity is bounded by every selected approval and authority expiry.

## Boundaries and remaining work

These are pure core captured-data helpers. They introduce no route, credential backend, SQL role,
DB grant, native guard, repository mutation, worker or publication function. A matched report is
not proof of actual authentication, complete owning enumeration or a retained publication guard.

The reviewer eligibility branch for exceptions is not an exception quorum or retained-control
verification. Complete versioned cut contracts, exact actor provenance, owning ports, guarded
approval/selection/authority administration, memory/shared/native atomic decision+graph+outbox,
reservations/recovery, authorization-first API/SDK, real-service contributor and the independent
exit audit remain open. Material 0.1 is historical transport. Workflow 2 remains 3/7 accepted.
