# Accountable decision contracts and conservative computation

[English](workflow-2-decision-contracts.md) | [한국어](workflow-2-decision-contracts.ko.md)

Status: checkpoint 4 contract/computation prerequisite; Workflow 2 remains 3/7 accepted.
Current authority ports/quorums, repositories, native publication,
API/SDK, contributor and separate exit audit remain open. See the [entry audit](workflow-2-decision-entry-audit.md),
[input contract](workflow-2-decision-input-contracts.md) and
[ADR-0038](../architecture/0038-retain-original-rule-outcomes-in-accountable-decisions.md).
Bounded material/header/page contracts and historical transport are documented separately in
[authority snapshots](workflow-2-decision-authority-snapshot.md); they confer no current authority.

## Accepted original-input dependency

`a54d7df361b464fe00c5317f67a7445f20ede924` passed 16,483 package plus 16 runner tests
(16,499 total), 31 builds and both uncached Turbo phases (93 + 29 tasks), preserving source/index.
Full log SHA-256: `81cf387139ee937bf035c331a96f28226868a8525fbb97e3efad6f19c3a026ea`.
[CI 38783464913](https://github.com/Kwondh0321/proofstack/actions/runs/38783464913) passed all
13 jobs and [Security 38783464842](https://github.com/Kwondh0321/proofstack/actions/runs/38783464842)
passed CodeQL without a rerun. Actual checkout/origin/remote/GitHub main matched cleanly. Receipt
SHA-256: `c7db130e3ad035e6b5036d1f0227f35583ccefe8bf974bf3462a5ed11b9ba390`.
The first input commit's full check and CI were intentionally interrupted after an adversarial
probe found malformed Unicode request IDs escaping safeParse. Four red regressions and the
follow-up fix precede the accepted final SHA above; the interrupted run was not a pass.

## Original evidence and separate resolution

[Decision contracts](../../packages/contracts/src/release-decision.ts) retain exact input/candidate/
selection/authority-snapshot references, actual original publisher receipt, native cut/expiry,
algorithm, rationale, disposition and the complete ordered policy/request inventory. Evaluated
members retain exact owning job/seal/result references and every contiguous original rule finding;
unavailable members retain typed missing/ambiguous/invalid observations and known original job
identity/status/seal. Distinct requests cannot share an owning job, seal or result. Original full
operands stay in their immutable evaluations. Public intent cannot supply results, actors or cuts.

Rule findings preserve original outcomes. Normal approval resolves only original indeterminate
`approval_required`; a scoped exception resolves only a known waivable violation. Both require
nonempty exact supporting approval references. No approval resolves unknown evidence or waives
nonWaivable. Opposing, escalating, conditional, conflicted, missing and insufficient review states
remain unresolved. Parsing a reference proves no real review or current authority.

[Internal classification](../../packages/core/src/release/classify-release-rule.ts) first checks
original and current policy state, original candidate source authority and applicability. Existing C3 emits its approval prerequisite
before those checks: approval-only policies therefore require explicit mismatch/unknown/expired/
withdrawn/superseded/unverified-authority counterexamples. Matched normal/exception labels never
override those conditions. The helper is private, performs no authentication or owning reads,
and cannot validate a real quorum or authorize publication from an externally supplied report.

[Complete aggregation](../../packages/core/src/release/derive-release-disposition.ts) binds every
original planned policy/request/mode; it rejects omissions, reorderings, substitutions, reused
jobs/seals/results and duplicate/over-budget supporting approval references. With current selection,
known mandatory non-waivable violations reject, otherwise missing/unresolved mandatory evidence
holds, otherwise enforcement proceeds. Advisory failures remain non-blocking. Explicit current
observation is advisory; non-current selection holds. A proceed field signs/deploys nothing.

## Finite record and historical authority boundaries

At most 16 policies with 128 findings each, 32 supports per resolved rule and 4,096 non-reused
supporting approvals fit a 2 MiB canonical UTF-8 definition plus 4 KiB response reserve. Tests
independently serialize the maximum complete 16x128/4,096 shape with maximum IDs, 30-digit cut,
escaped maximum authentication request ID and non-BMP rationale. All observed approvals, not
only supporting ones, still consume original input record/byte limits; native metering is open.

Maximum protocol validity is one hour. Owning composition must further intersect the original
input and every relevant authority interval. A new receipt cannot refresh old evidence. The
authority snapshot reference names a distinct complete publication-cut graph; its strict
records/pages and canonical encoding are separate from still-open current-authority ports and persistence.
Historical reads recompute from that original retained graph; later revocation does not rewrite
an old decision. New publication must independently revalidate current actual state and private
session/grant/publisher proof while holding guards through graph+decision+outbox commit. No
separate report or snapshot authorizes later publication, and no secret proof belongs in output.

## Independent checks

Four [Python UTF-8/hashlib vectors](../../packages/contracts/vectors/release-decision-definition-v1.json)
cover proceed with non-blocking advisory failure, pending mandatory hold, known non-waivable reject
and explicit empty advisory. They are synthetic contract data, not real approval/publication.
The [independent generator](../../packages/core/src/release/fixtures/generate-release-rule-oracle.py)
uses boolean satisfaction/known-violation formulas and ordered diagnostic precedence. Its 25
digests cover 793,800 combinations across seven predicates, original outcomes, policy states,
candidate authority, applicability, review states and waiver flags. These are comparisons, not 793,800 test cases.
A separate fixed mandatory matrix checks aggregate rejection/hold precedence and advisory
invariance. Actual owning current authority and full guarded native conformance are still needed.
