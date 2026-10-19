# Workflow 2 accountable decision and scoped approval entry audit

[English](workflow-2-decision-entry-audit.md) | [한국어](workflow-2-decision-entry-audit.ko.md)

- Status: accepted design entry, subject to this document's exact-commit publication gate
- Reviewed: 2026-10-15
- Dependency: accepted checkpoint 3 at `bc2dcb1af49f06aeae014475aceca8f52e265bc9`
- Architecture: [ADR-0021](../architecture/0021-separate-release-policy-authority.md) and
  [ADR-0036](../architecture/0036-bind-decisions-to-current-selection-and-reviewer-authority.md)
- Checkpoint 4 implementation and acceptance: open; Workflow 2 remains 3/7 accepted checkpoints

## Entry decision and verified dependency

Accountable decisions and scoped approvals may begin after this entry's own publication gate.
This is a source and requirement review by the implementation writer, not independent human
certification. Completion requires a separate adversarial exit audit.

The [checkpoint 3 audit](workflow-2-policy-evaluation-audit.md) publication completed at the exact
dependency above. Its uncached full cloud check passed 16,309 package tests plus 16 runner tests
(16,325 total), all 31 builds, and 93 static plus 29 unit Turbo tasks with zero cached tasks.
Log SHA-256: `3b3e9d0fd52f276c19164b46bf16f6e591d67e85517d014c7bb5f895105c95d5`.
[CI 38757913660](https://github.com/Kwondh0321/proofstack/actions/runs/38757913660) passed all
13 jobs and [Security 38757913725](https://github.com/Kwondh0321/proofstack/actions/runs/38757913725)
passed CodeQL. Exact HEAD, actual remote main, GitHub main and a clean checkout were verified;
the cloud receipt SHA-256 is
`5735e392a901eae51ae4de4e082ebcee4c15ed273bf6650bd8a8e0d8763ac2f8`.

The contributor CI job failed on its first attempt with generic exit annotations. The cloud's
Actions log download was blocked by proxy HTTP 403, so the underlying failure is **unknown**.
One bounded rerun of that failed job passed at the same SHA; the other twelve jobs were retained.
A fresh local disposable contributor run independently passed all five workflow and nine native
worker cases (14/14), preserving the exact source/index, and removed its owned services.
Its log SHA-256 is `d48053a8558b917591746122cd2c05495649f721045a6b4ad4cb76bd7d0741b4`.
This does not establish a fix for the first CI failure or a stable availability measurement.
Retain the first failure and investigate any recurrence without retry-until-green.

## Existing requirements and inspected facts

Authority: docs/product/constitution.md and roadmap.md; workflow-2-entry-audit.md section 4;
ADR-0021. The exact dependency evidence above supersedes earlier cancelled publication attempts.
This is a source/requirement pass by the same writer, not independent human certification.

Existing candidate/policy/evaluation contracts are retained. Candidate author is the original
createdByPrincipalId; policy author is publishedByPrincipalId/issuerPrincipalId. Policy rules
already carry nonWaivable, severity, exact rule identity, seven typed predicates and at most 128
rules. Approval declarations already fix quorum, eligible role/group IDs, human groups,
excludePolicyAuthor=true, optional candidate-author exclusion and reject_declared_conflict.
Existing evaluation approval_required remains indeterminate with approval_not_evaluated forever.

approval:decide already exists and is excluded from workload delegation. Generic principal roles
are owner/admin/member/viewer/ingest, not arbitrary policy reviewerRoleIds. Actual stored OIDC
sessions create user principals; API keys create workloads and service tokens create services.
An old evidence-review record is not release approval. Current policy installation bindings
authorize policy publication, not complete mandatory-policy selection for an enforcement target.
Existing C3 metadata guards do not protect identity sessions/grants or nonexistent C4 records.

## Required complete target-owned selection

Introduce an installation-owned immutable, versioned selection plus append-only lifecycle and an
exact intended gate target. It binds tenant/project/environment/installation, original candidate
target coordinates and all selected exact policy versions/digests. The target is a named gate,
not a URL, shell command, deployment identity or wildcard supplied by a release requester.

Only a separately authorized installer may publish/activate/supersede/withdraw this selection.
The [authenticated installer service](workflow-2-authenticated-selection-publication.md) implements
the first native installation/lifecycle boundary with preserved original provenance. This is a
component gate, not complete current decision authority or checkpoint acceptance.
The [authenticated memory reference and shared service cases](workflow-2-authenticated-selection-reference.md)
exercise matching reference semantics without composing production memory identity or accepting the checkpoint.
Requests name a target and exact expected selection reference; they cannot provide a favorable
policy list, select a mutable latest evaluation or downgrade required policy mode. Publication
derives and validates the complete original selection inventory through owning authoritative
readers. Missing, duplicate, unreadable, conflicting, expired or withdrawn requirements remain
explicit; they cannot disappear from a shorter successful result.

Distinguish explicit observation-only/no mandatory requirement from unavailable selection authority.
No configured mandatory policy does not invent a gate: advisory disposition with an explicit
no-mandatory/no-applicable reason is different from policy rule not_applicable. An explicitly
required policy missing or not applicable must hold. ADR-0021's four decision dispositions remain
advisory/proceed/hold/reject; do not invent a fifth disposition from rule applicability vocabulary.

## Required immutable subject and result

A decision binds the exact candidate, complete selection, every selected policy/evaluation and
original job/request/snapshot/result digest, actual accountable publisher, current native cut,
bounded validity, intended enforcement target and complete approval/exception references.
Decision disposition and typed reasons are computed by the server; callers cannot POST them.
Keep full rule evidence in its original immutable evaluation rather than reinterpreting or copying
an outcome into approval. A historical decision is never silently relabelled after later action.

No caller-supplied authority report, reviewer membership, worker/fence/receipt or arbitrary callback
may replace owning state. Original result reads recompute their evidence. Current selection,
policy lifecycle, eligibility of approvals and authority are revalidated at publication; a policy
withdrawn after evaluation retains its historical result but cannot authorize a new proceed.
New evidence requires a new explicit evaluation request, never favorable retry/cut selection.

The contract slice must freeze strict versioned shapes, canonical domains/vectors, ordering,
collection and UTF-8 byte bounds, complete rule/result references and readable response headroom.
Reuse existing exact reference/time/canonical primitives. Maximum policy rules remains 128;
job-wide maxRuleEvaluations is not a larger rule-count allowance. Bound multi-policy and approval
inventories explicitly and prove serialized headroom before accepting those contracts.

## Required approval and exception authority

The [authenticated reviewer reference](workflow-2-authenticated-reviewer-reference.md) preserves
original administrator provenance and atomic synthetic publication. Native administration, complete
current reviewer/basis authority and checkpoint acceptance remain open.

The [predeclared complete input contracts](workflow-2-decision-input-contracts.md) retain the
original request inventory. Native reservations and current publication authority remain open;
immutable integrity is not checkpoint acceptance.

Use separate exact normal-approval and known-rule-exception subjects. Both bind one immutable
candidate/policy/evaluation/selection/target/environment, original rule identity, actual user
authentication receipt, rationale, non-executable conditions, validity and supersession/revocation
history. Compensating-control claims remain attributable declarations with exact retained evidence
and explicit unresolved conditions; do not claim arbitrary prose automatically verified.

Require an actually authenticated user and approval:decide plus an independently supplied current
reviewer authority record. Bind principal/type/request/authentication method/time/credential ID to
the authenticated principal as existing human-review publication does. Workload/service/model or
development credentials cannot become independent human approval merely by declaring a role.
Any explicitly supported synthetic reference mode must remain unambiguous in records and claims.

Reviewer authority owns eligible roles/groups, human status, independence, conflicts, scope,
validity and provenance; requests cannot mint them. Policy authors are excluded. Apply the original
candidate-author declaration to normal approval, while high/critical decisions still require an
independent human distinct from subject authors. An exception cannot be self-issued by its subject
author/evaluator. Reject expired, conflicted, wrong-candidate/environment/target and over-broad
records. A post-hoc approval cannot change an earlier decision; a later action needs a new decision.

Quorum counts unique authenticated principals and independently eligible groups without counting
one person's multiple memberships as multiple people. Use bounded bipartite matching for distinct
eligible-group requirements and check it with an independent exhaustive small-case oracle. Do not
use a greedy favorable reviewer ordering or omit opposing/current revocation/conflict observations.

approval_required stays indeterminate in the evaluation. The decision may resolve only its exact
typed approval_not_evaluated prerequisite from current valid approvals. This is separate from an
exception to a known waivable violation and cannot launder missing evidence or unknown authority.
Never waive nonWaivable, missing mandatory selection/policy, unknown applicability or unrelated
indeterminate evidence into proceed. Preserve original rule outcomes and every counterexample.

## Required conservative decision table

The [decision contract/computation prerequisite](workflow-2-decision-contracts.md) preserves
original outcomes and separately derives bounded findings. Current authority and native acceptance
remain open; a pure report cannot publish.

| Exact situation | Disposition boundary |
| --- | --- |
| Explicit observation-only selection; advisory failures | advisory, non-blocking and attributable |
| Unavailable/expired/conflicting selection, source or reviewer authority | hold |
| Explicit mandatory policy absent/wrong version/non-applicable/selector-unknown | hold |
| Known compatible mandatory non-waivable violation | reject |
| Known waivable mandatory violation without valid scoped exception | hold |
| Mandatory non-approval indeterminate evidence | hold |
| Satisfied evidence but missing/currently invalid approvals | hold |
| All explicit mandatory evidence/prerequisites valid and required approvals/exceptions current | proceed only for the named gate and validity window |

Advisory failures do not block a separately satisfied mandatory gate. Approval cannot replace a
missing prerequisite or waive an unknown value. No proceed field deploys, signs or publishes CI.
Do not define rejection only from job operational failure or equate completed evaluation with pass.

## Required mutation/read boundaries

Add a separately grantable non-delegable decision publisher capability and dedicated native role/
pool; release:manage, policy author/evaluator, evidence and identity credentials do not substitute.
Use actual OIDC users for public publication and separately authenticated service-token
principals for a bounded private CLI, each authorized by current installation publisher authority.
The publisher cannot be a candidate or policy author or an evaluator of the decision's subject.
ADR-0036 fixes these restrictions before contracts; publishing is never itself human approval.
Do not infer reviewer expertise from successful login or conflate generic admin with decision power.

Separate installer, reviewer and decision publisher DB authority; fixed search paths, no direct DML,
forced RLS, exact scope and strict effective-grant readiness. Every publication must validate current
migration/recovery epoch, complete selection/lifecycle/approval authority and original result on
one still-held guarded native client, atomically committing immutable record and canonical intent.
New writer guards must cover their absence/creation/revocation and authority changes. Explicitly
resolve identity session/grant revocation races; old C3 source guards do not cover them automatically.
No DB guard spans human interaction, content/key/network I/O or an external signing operation.

Memory/native shared cases must retain original idempotent receipts, reject substituted bodies,
keep normalized/projected graphs equal and rollback intent conflicts wholly. Three-tenant colliding
IDs, pool cleanup, concurrent approval/revocation/expiry/publication and restoration are mandatory.
Recovery restores immutable decisions/approvals, current lifecycle/selection and role provisioning
without reviving source leases or altering old evaluation receipts. Forward-only migrations begin
after the actual latest ledger (currently 0061); never modify an applied migration.

## Required public/contributor and exit evidence

Authorization-first exact-scope API/OpenAPI and bounded authenticated workspace SDK; browser CSRF,
no caller result/receipt, exact immutable pagination, just-below/exact/over UTF-8 limits, non-cacheable
errors, deadline/abort/redirect/truncation cleanup and no automatic mutation retries. Read/cancel/
supersession semantics must be explicit; a later revocation does not rewrite historical records.

The real-service contributor must retain the existing candidate/withdrawn policy/evaluation graph,
use actual user-session approval authentication and separately authorized publication, exercise all
four dispositions, normal approval and scoped exception, non-waivable and invalid-authority cases,
restart/readback and real DB races/recovery. Synthetic OIDC/reviewer fixtures remain synthetic;
no real person or production exception is approved by development authorization. No new website.

Each slice needs meaningful focused checks, unchanged coverage, full uncached local verification,
English commit/push, all thirteen independent CI jobs and CodeQL before dependent work. EN/KO
documentation, usability/security/public-claim review and a distinct requirement-by-requirement
completion audit precede acceptance. Signing/trust/revocation attestations (checkpoint 5), CI
adapters (6), rollback/break-glass/operations/stage audit (7), earlier-stage re-audits and measured
Scale work remain later. Do not stop the whole user objective at this entry or one green slice.

## Frozen authorization and implementation order

Introduce separately grantable, non-workload-delegable `release:selection:manage`,
`approval:authority:manage` and `release:decision:publish` capabilities, never default grants.
Existing `approval:decide` is necessary but insufficient for actual OIDC-user approval. Dedicated
selection/authority, approval and decision DB roles/pools expose only fixed scoped functions;
reviewer authority administration cannot approve on a reviewer's behalf. Public mutation requires
actual OIDC user authentication and CSRF; a private service-token decision publisher must have its
own installation binding and cannot issue approval records. Development authentication is excluded.

Implement in this order: strict contract bounds/canonical vectors and independent decision/quorum
oracles; memory/shared conformance and current-authority ports; forward-only native guarded
transactions/role readiness/recovery; authorization-first API and SDK; real-service contributor
flows and adversarial exit audit. Existing authenticators and authorities remain owning boundaries.
A pure computed report alone cannot publish a decision or claim this checkpoint complete.

The [installation-owned selection contract prerequisite](workflow-2-policy-selection-contracts.md)
freezes the first bounded selection/reference/lifecycle and canonical-vector slice. It does not
close current authority, persistence, approval or decision publication requirements below.
The [bounded authority snapshot contracts and historical transport](workflow-2-decision-authority-snapshot.md)
retain original public observations; they do not establish current authority or guarded publication.
The [owning source inspection prerequisite](workflow-2-decision-source-validation.md) validates
original records, complete captured selection data and credential preimages. Actual owning ports,
current reviewer quorums, private authentication and guarded publication remain open.
The [captured reviewer/normal-quorum prerequisite](workflow-2-current-release-reviews.md) retains
current observations and every normal action. Actual owning source ports and guarded publication
remain open; a matched captured report cannot authorize release.
The [reviewer/approval contracts and internal assignment prerequisite](workflow-2-release-approval-contracts.md)
retain original authenticated receipts and bounded group witnesses. They do not authenticate an
actor, close current authority or accept checkpoint 4.

## Adversarial acceptance matrix

The [original input repository](workflow-2-decision-input-repository.md) retains complete original
candidate/selection/policy witnesses, plans and first receipts through private guarded storage.
Its local plan ownership does not reserve external jobs or establish current publication authority.

The [native request reservations](workflow-2-decision-request-reservations.md) coordinate new plans
with every C3 request INSERT, preserving explicit unreserved legacy records. Actual authoritative
planning and final atomic decision publication remain open. The supplied-client observation verifies
complete original graphs/reservations under the original aggregate meter and retains caller guards;
its detached report is no current authority or publication seal.

The [native private service identity](workflow-2-native-service-publisher.md) verifies actual
service secrets and holds current credential/expiry/revocation observations on the same client.
It supplies no human approval, installation binding or complete atomic decision authority.

The [native original approval store](workflow-2-native-approval-repository.md) preserves complete
kind/subject inventories, first authentication/authority receipts and revocation through guarded
normalized storage. Trusted storage alone supplies no current authentication or decision authority.

The [native reviewer declaration store](workflow-2-native-reviewer-repository.md) retains complete
original reviewer inventories, normalized roles/groups/basis/conflicts and terminal history.
Storage alone supplies no actual issuer authentication, expertise or current approval authority.

The [native target-owned selection store](workflow-2-native-selection-repository.md) preserves
the original owner, complete guarded history, normalized integrity and atomic canonical outbox
through the unchanged shared port. Actual installer authority, separate roles and complete
decision publication remain open.

The [same-client guarded OIDC component](workflow-2-guarded-release-oidc.md) joins actual private
authentication to current owning session/grant reads and retained OIDC guards. Complete installation,
reviewer/source closure, roles, recovery and atomic decision/outbox publication remain open.

The [owning mutation authentication composition](workflow-2-release-mutation-authentication.md)
requires actual OIDC/CSRF or a separate private service publisher and exact capability/scope.
Its process-local proof is completed authentication, not current native installation/reviewer authority.

The [captured rule-exception quorum composition](workflow-2-captured-rule-exceptions.md) retains
complete actions/current reviewer observations and every compensating-control occurrence.
It grants no default exception authority, actual authentication or native publication authority.

The [captured exception-control inspector](workflow-2-captured-exception-controls.md) preserves
all original evidence occurrences and their later unavailable/changed/expired observations.
It grants no control-effectiveness proof, exception quorum or native publication authority.

The [original policy supplied-client readers](workflow-2-policy-original-client-readers.md) retain
header/job/history/outbox/page and deterministic-result checks on one caller-owned connection.
They add no authentication, current-source completeness or decision publication authority.

The [native OIDC source observations](workflow-2-release-oidc-sources.md) add non-mutating
provided-client reads and mandatory binding/session row-write guards. They grant no runtime access
or authentication/publication authority; complete native decision acceptance remains open.

| Boundary | Required counterexamples |
| --- | --- |
| Selection and applicability | omitted mandatory policy; duplicate/ambiguous target; absence-to-creation; withdrawal; expired or superseded selection; advisory-only and explicit no-policy selection |
| Original evaluation | substituted candidate, policy, snapshot, request or digest; all seven predicates; all four outcomes; unfinished/failed job; stale recovery epoch |
| Decision precedence | advisory failures; non-waivable violations; waivable exception; unrelated indeterminate evidence; unresolved applicability; missing approvals; multiple contradictory mandatory policies |
| Human authority | workload/service/development impersonation; substituted session; revoked credential or grant; duplicate principal/groups; exact author exclusions; declared conflict; insufficient independent high-impact reviewers |
| Approval/exception scope | wrong rule/candidate/environment/target; expired/over-broad/post-hoc/superseded/revoked records; unverified compensating-control conditions; non-waivable exception |
| Atomic persistence | current migration and epoch; concurrent authority/session/grant/selection revocation; absence creation; native cut expiry; conflicting outbox; exact idempotent receipt; no partial DML |
| Public and recovery | authorization before lookup; CSRF; three-tenant same IDs; strict byte/page bounds; cancellation/abort/pool cleanup; restart; coordinated restore; immutable history |

All rows need observable fixtures or explicit rejected boundaries. Successful authentication is
not expertise; synthetic OIDC/group fixtures prove reference behavior, not real human diligence.
This entry does not create a production approval, signer, external CI status, deployment or website.
