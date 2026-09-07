# Workflow 2 versioned policy definition audit

[English](workflow-2-policy-definition-audit.md) |
[한국어](workflow-2-policy-definition-audit.ko.md)

- Status: second Workflow 2 checkpoint accepted, subject to the publication gate below
- Reviewed: 2026-09-07
- Audited implementation: `62024a09f35f8d7ec208c9d93ae1c12161f3eb59`
- Requirements: [policy-definition entry audit](workflow-2-policy-definition-entry-audit.md)
- Architecture: [ADR-0014](../architecture/0014-contestable-evaluation-assurance.md) and
  [ADR-0021](../architecture/0021-separate-release-policy-authority.md)
- Production readiness: not approved
- Next checkpoint: deterministic policy-evaluation entry review, not release authority

## Decision and publication gate

The bounded versioned policy-definition implementation is accepted. It records an organization's
explicit risk requirements, their exact installation and qualified-source authority, and immutable
publication, withdrawal, and supersession history. Memory, PostgreSQL, API, OpenAPI, the workspace
TypeScript SDK, restart, and coordinated recovery preserve that definition without evaluating it.

The implementation SHA above has passed every required remote job. This audit and its roadmap
update must also pass local repository checks and every required CI and security job at their exact
pushed commit before work advances. The implementation evidence below is not a claim about a
different, untested documentation commit. The GitHub checks attached to the publication commit are
the authoritative record of that final gate.

The review cross-checked schema, core logic, shared repository conformance, real database and
object-storage paths, public transport, restore, and contributor instructions. Adversarial cases
and reproduced failures provide evidence beyond positive fixtures. This is a source-and-execution
cross-check, not certification by an independent human auditor or an external security assessment.

Acceptance does **not** mean that a policy is correct, that it applies to a candidate, that its
predicates passed, or that a release is approved. All five later Workflow 2 checkpoints remain open.

## Accepted boundary

```text
operator-owned installation binding + exact qualified, retained source graph
  -> authorized immutable policy definition and atomic outbox intent
  -> exact-version read and append-only withdrawal or supersession
  -> identical history after retry, restart, and reference recovery
```

The definition records seven finite, non-executable predicate kinds: `comparison_threshold`,
`coverage_floor`, `uncertainty_bound`, `eligibility_required`, `artifact_required`,
`safety_event_ceiling`, and `approval_required`. The last kind declares a future prerequisite; it
does not create or satisfy an approval. Advisory and mandatory are retained modes, not enforcement
implemented by this checkpoint.

Seven explicit flat applicability selectors cover task kind, purpose, risk tier, maximum data
classification, jurisdiction, locale, and population tags. Exact installation, tenant, project, and
environment binding is separate. There is no implicit selector, nested Boolean program, executable
expression, mutable alias, automatic policy selection, or hidden candidate-to-policy decision.

## Requirement-to-evidence matrix

All decisions below apply to the bounded reference implementation, not production deployment.

| Requirement | Inspected evidence | Result |
| --- | --- | --- |
| Strict immutable definition | [Contract tests](../../packages/contracts/src/release-policy.test.ts) cover the seven predicates, total selectors, exact units and decimals, ordered rules, source edges, finite validity, semantic version, predecessor, declarative approvals, and rejection of unknown executable or server-authored fields | Accepted |
| Generated boundary coverage | [Property cases](../../packages/contracts/src/release-policy-properties.test.ts) retain every one of the 3,888 combinations of the declared selector fixtures with a uniqueness/cardinality guard, decimal precision and scale boundaries, every supported comparator, collection limits, nesting rejection, and semantic order | Accepted; these are finite generated cases, not proof over all possible input |
| Canonical integrity | [Encoding tests](../../packages/contracts/src/release-policy-definition-encoding.test.ts), [public vectors](../../packages/contracts/vectors/release-policy-definition-v1.json), and [SDK digest tests](../../sdks/typescript/src/release-policy-definition-digest.test.ts) bind domain, encoding/schema versions, scope, binding, and every semantic field; object insertion order is immaterial, ordered arrays are not | Accepted |
| Installation and retained source authority | [Resolver tests](../../packages/core/src/policy/release-policy-authority-resolver.test.ts) and [authority matrix](../../packages/core/src/policy/release-policy-authority.test.ts) reject wrong scope, issuer or mode, digest substitution, incomplete retained bytes, missing qualification, self-review where prohibited, disputed identity, unusable licensing, unresolved conflict, and inadequate applicability or validity | Accepted for the static operator registry and retained repository authorities |
| Publication and exact retries | [Use-case tests](../../packages/core/src/policy/record-release-policy.test.ts) prove authorization before parsing and dependencies, source resolution before time/write, original-issuer retry without re-resolution or renewal, exact route identity, conflict behavior, and repository-output validation | Accepted |
| Lifecycle integrity and current authority | [Integrity tests](../../packages/core/src/policy/release-policy-lifecycle-integrity.test.ts) and [actor tests](../../packages/core/src/policy/release-policy-lifecycle-authority.test.ts) check exact target and successor, predecessor/time constraints, one terminal history, current scoped non-workload authority, expired-history access, original actor retention, and concurrent conflicts | Accepted |
| Memory/PostgreSQL parity | The unchanged [shared conformance](../../packages/core/src/testing/release-policy-repository-conformance.ts) is exercised by memory and [PostgreSQL integration](../../packages/postgres/src/postgres-release-policy-repository.integration.test.ts), including retry, conflict, defensive copies, lineage, Unicode reason bounds, and colliding tenant identities | Accepted |
| Durable authority and atomicity | [Migration 0047](../../packages/postgres/migrations/0047_release_policy_graph.sql) and PostgreSQL tests cover eight normalized tables, complete projections, immutable triggers, fixed-search-path functions, private DML, forced RLS, exact transaction-local scope, canonical records, and one atomic outbox intent | Accepted |
| Capability and runtime-role separation | [Migration 0046](../../packages/postgres/migrations/0046_policy_author_capabilities.sql), [runtime-role tests](../../packages/postgres/src/runtime-roles.integration.test.ts), policy integration, and restored-role assertions separate non-delegable `policy:author` from `policy:read`; reserved `policy:evaluate` grants no author operation, and removal of `policy:manage` does not grant replacement authority | Accepted |
| Isolation and connection reuse | PostgreSQL tests use three tenants with colliding IDs, different canonical histories, all eight tables, wrong tenant/project/environment scopes, and one pooled connection; transaction context is cleared after commit and rollback, while out-of-scope writes fail | Accepted |
| Forward migration | [Withdrawal migration test](../../packages/postgres/src/release-policy-withdrawal-migration.integration.test.ts) checks nullable successor handling; [reason-bound migration test](../../packages/postgres/src/policy-lifecycle-reason-migration.integration.test.ts) upgrades old bounds, preserves previous checksums and history, rejects invalid direct SQL, and proves retry is a no-op | Accepted |
| HTTP and OpenAPI | [API tests](../../apps/api/src/release-policy-api.test.ts) and [route tests](../../apps/api/src/release-policy-routes.test.ts) cover four exact operations, authorization before malformed bodies or routes, create/retry semantics, stable bounded non-cacheable errors, output validation, and generated OpenAPI descriptions | Accepted |
| TypeScript SDK and transport | [Client tests](../../sdks/typescript/src/release-policy-client.test.ts) and [cross-boundary size tests](../../examples/workflow-2-release-policy/src/transport-boundary.test.ts) cover identity/digest substitution, browser CSRF, workload read-only behavior, no automatic mutation retries, redirects, media/cache policy, timeout cleanup, declared/streamed size limits, Unicode, and serialized-number expansion | Accepted for the workspace SDK |
| Coordinated recovery | [Recovery integration](../../services/recovery/src/postgres-recovery.integration.test.ts) restores the policy graph into an empty target, reprovisions roles, checks exact historical reads/retries and no extra intent, denies role substitution, hides cross-scope reads, and permits a new version and withdrawal only through the policy-author connection | Accepted for the documented pinned reference procedure |
| Retained end-to-end flow | [Acceptance test](../../examples/workflow-1-acceptance/src/workflow.integration.test.ts) builds real Workflow 1 PostgreSQL/S3 records and a candidate, publishes distinct synthetic source/reviewer authority, restarts before policy publication, uses the public SDK to publish/retry/read/withdraw, restarts again, and compares full retained records | Accepted |
| Contributor usability and claims | The [policy guide](../guides/workflow-2-release-policy.md), linked secondary guide, root acceptance command, frozen install, random loopback ports, owned-service cleanup, failure instructions, registry/credential recovery responsibility, and non-enforcement limits are documented and link-checked | Accepted |

## Verified execution

The exact implementation SHA passed all nine jobs in
[CI run 34112960408](https://github.com/Kwondh0321/proofstack/actions/runs/34112960408):

1. Quality gates: frozen dependency installation, production dependency audit, formatting,
   architecture boundaries, documentation links, public-claim guard, lint, strict types, unit
   coverage, and production builds.
2. PostgreSQL integration.
3. Recovery integration.
4. Workflow 2 policy clean-checkout acceptance.
5. Workflow 2 candidate clean-checkout acceptance.
6. Workflow 1 clean-checkout acceptance.
7. Artifact lifecycle integration.
8. Secret scanning.
9. S3-compatible integration.

The same SHA passed CodeQL in
[Security run 34112960415](https://github.com/Kwondh0321/proofstack/actions/runs/34112960415).
Dependency review was skipped because it is pull-request scoped; the push quality job separately
ran the production dependency audit. A skipped check is not reported as an executed security test.

The final implementation also passed local `CI=true pnpm check`. Its focused PostgreSQL policy
suite passed all 58 cases against native PostgreSQL 16.15 through a task-owned private Unix socket
with TCP disabled. This is real database evidence, but not password-authentication or cloud
deployment evidence. The test cluster was stopped afterward.

Docker was unavailable on this host. Container-backed PostgreSQL/S3 composition, full coordinated
recovery, and the disposable clean-checkout command were therefore verified by the exact remote
jobs above, not claimed as a local container run or replaced with memory storage. No user-facing
application listener was required or started for acceptance.

## Findings closed before acceptance

1. **Optional source expiry was treated as mandatory.** Publication now accepts a source with no
   declared expiry only when the current review, required qualification, installation binding,
   retained bytes, and freshness still cover the entire finite policy interval. A declared expiry
   remains an additional bound, including microsecond-edge cases.
2. **Valid withdrawal was blocked by a nullable successor foreign key.** Forward migration `0048`
   permits absent successor fields for withdrawal while preserving foreign keys for supersession.
   Earlier migration files were not rewritten.
3. **PostgreSQL rejected reasons allowed by the public contract.** Forward migration `0049` aligns
   the bound to 1–4,096 Unicode scalar values. Shared ASCII, Korean BMP, and supplementary-character
   cases cover both lifecycle kinds at 0, 1, 2,048, 2,049, 4,096, and 4,097; SQL bypass checks retain
   the outer bounds, and upgrade checks preserve the prior ledger and authoritative graph.
4. **A maximum-size request could produce an unreadable receipt.** Requests remain capped at
   1,048,576 UTF-8 bytes; responses reserve a bounded 4 KiB for receipt metadata and integer
   expansion. The API and SDK enforce both limits, and exact-boundary round trips no longer reject
   valid records solely because the server adds receipt fields.
5. **Concurrent lifecycle actors were misclassified as storage corruption.** Tests reproduced
   `201`/`503` for two actors submitting the same event identity. The first immutable receipt now
   wins and the other actor receives `409 release_policy_lifecycle_event_conflict`. Same-actor
   retries retain the original receipt. Real PostgreSQL concurrency proves one event and one intent;
   substituted new receipts, wrong digests, and impossible times still fail as contract violations.
6. **Historical receipts could be confused with current permission or renewed validity.** Exact
   original-issuer retries preserve old publication time and expiry without re-resolving authority.
   Every call still needs current capability and scope. A current authorized replacement author may
   terminate expired history, but cannot adopt an event recorded by someone else.
7. **Restored rows alone did not prove restored authority.** Recovery now checks the full runtime
   role/function privilege matrix and restrictive author-role attributes, executes exact historical
   operations through the reprovisioned role, rejects general-API mutation, and verifies new
   post-restore writes without altering old history.
8. **Parallel queries shared one PostgreSQL transaction client.** Regression graph reads used by
   the retained upstream flow now serialize queries. A rejecting fake client, original-error and
   rollback probes, and native PostgreSQL integration cover the change without changing SQL or
   scope semantics.
9. **Nested test pools caused CI timeout failures.** Workspace test tasks now run with bounded
   concurrency. All 3,888 applicability fixture combinations remain individually registered with a
   completeness guard; coverage, assertions, and per-test timeouts were not weakened. The complete
   repository and remote jobs pass with the revised scheduling.
10. **Public wording could blur requirements and decisions.** API and guide wording explicitly
    describes policy requirements, not approved criteria or a passed release. The guide distinguishes
    synthetic identities, current author authority, retained receipts, and operator-owned registry
    recovery from guarantees that the platform cannot make.

No unresolved finding identified by this audit invalidates the policy-definition checkpoint.
That conclusion is bounded by the evidence and limitations here, not a promise of zero defects.

## Retained limitations

- Integrity, provenance, declared qualification, review independence, and finite validity do not
  prove source truth, real expertise, representative evidence, appropriate risk tolerance,
  completeness, lawfulness, or safety. Search rank, snippets, generated answers, signatures, and
  majority vote cannot substitute for authority or resolve this epistemic limit.
- The static installation registry is operator-owned configuration loaded at composition. It is
  not a public authority service or backup-derived registry. Operators must restore reviewed
  configuration separately and supply new runtime credentials. Configuration distribution,
  real-world credential verification, key management, and change governance remain deployment work.
- Strict schemas exclude dedicated credential, executable, completed-approval, decision, and
  deployment fields. Classified content belongs behind artifact references. Bounded free-text
  rationale and labels are not a semantic secret detector; authors and operators remain responsible
  for suitable metadata and content controls. Arbitrary text is not proved secret-free.
- The clean-checkout flow uses real retained storage and synthetic authority data. It does not
  establish real human independence or expertise. Coordinated recovery uses its own representative
  graph; it is not a restore of the acceptance runner's ephemeral database or a measured RPO/RTO.
- Transport-size tests use synthetic authority and memory storage to isolate byte behavior. The
  separate real-service acceptance and PostgreSQL tests supply persistence and authority evidence.
  One narrow suite is not used as proof of all these boundaries.
- The SDK remains workspace-consumed, not published or validated as an independently installed
  package. No browser policy editor, new website, fixed application port, or release control is
  required by this checkpoint.
- `policy:evaluate` remains reserved. Policy selection, predicate evaluation, accountable approval,
  exception handling, decisions, signatures, CI delivery, deployment, rollback, break-glass,
  continuous operations, high availability, and production readiness are not accepted here.

## Next dependency-ordered entry review

The next checkpoint must define deterministic policy evaluation against exact retained candidate,
policy, comparison, assessment, artifact, and lifecycle records. Its entry audit must fix explicit
evaluation time, current execution authority, canonical operands and units, exact decimal and
integer arithmetic, eligibility, coverage denominators, declared uncertainty methods, missingness,
and the distinction between `satisfied`, `violated`, `indeterminate`, and `not_applicable`.

It must define how unmet future approval requirements remain unresolved, preserve policy and input
lineage, reject changed or unavailable evidence without a false pass, and keep a policy-evaluation
result separate from installation-owned policy selection and an accountable release decision.
No mutable source lookup, model vote, or inferred unit conversion may create an implicit verdict.
Contracts, persistence, authorization, recovery, and a real contributor flow must receive their own
entry and exit gates before that third checkpoint is accepted.
