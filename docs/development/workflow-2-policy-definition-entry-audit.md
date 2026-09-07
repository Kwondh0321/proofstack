# Workflow 2 versioned policy definition entry audit

[English](workflow-2-policy-definition-entry-audit.md) |
[한국어](workflow-2-policy-definition-entry-audit.ko.md)

- Status: accepted entry baseline; completion decision is recorded in the linked audit
- Reviewed: 2026-09-06
- Dependency: accepted immutable release candidate through `56b56bd`
- Architecture: [ADR-0014](../architecture/0014-contestable-evaluation-assurance.md) and
  [ADR-0021](../architecture/0021-separate-release-policy-authority.md)
- Policy evaluation, approval, decision, attestation, CI enforcement, deployment, rollback,
  break-glass, and production readiness: not included

This document preserves the frozen entry requirements. The later
[policy-definition completion audit](workflow-2-policy-definition-audit.md) records their
implementation evidence, acceptance decision, publication gate, and retained limitations.

## Entry decision

The versioned policy-definition checkpoint may begin. Its accepted dependency gives a policy one
exact, immutable release subject, while Workflow 1 supplies retained, policy-independent evidence.
Neither dependency decides acceptable risk. This checkpoint will record an organization's bounded
and contestable risk choice without relabeling it as platform truth.

The checkpoint adds only the middle definition boundary below:

```text
qualified immutable sources + installation-owned binding
  -> immutable ReleasePolicyDefinition
  -> append-only withdrawal or supersession records
```

It does not select a policy for a candidate, evaluate a rule, collect an approval, decide a
release, sign a statement, publish a CI status, or deploy anything. Those actions remain separate
ordered checkpoints.

## Current findings that implementation must close

1. `policy:manage` and `policy:evaluate` exist as unused future capability names, but there is no
   policy-author capability, route, repository, or database role. Treating the broad placeholder as
   implemented authority would hide the required separation.
2. There is no installation-owned record that limits which exact scope and authority may publish a
   policy. A tenant-scoped author alone must not invent installation authority.
3. Workflow 1 criteria describe how to assess evidence. They are not release policy and cannot be
   copied into a release gate without an explicit business-risk decision, rationale, and source
   review.
4. Existing applicability expressions are suitable for criterion execution context, but policy
   applicability also needs exact project, installation, purpose, classification, and candidate
   target binding. Partial or unknown matching must not silently become applicable.
5. Comparison and assessment records expose typed evidence, but no reviewed finite release-rule
   vocabulary fixes how a future evaluator may select operands, units, coverage, uncertainty,
   eligibility, artifacts, safety events, or approval requirements.
6. No policy-specific immutable lifecycle exists. Editing a threshold, mode, applicability,
   approval requirement, validity window, source, or limitation in place would erase the decision
   context used by later records.
7. Exact source snapshots and reviews exist, but policy publication does not yet prove that each
   required source is retained, approved, current, applicable, conflict-resolved, and valid for the
   policy interval.

These are entry findings, not defects in the accepted candidate or Workflow 1 scopes.

## Frozen policy contract

### Separate the installation binding from author input

An installer supplies a `PolicyInstallationBinding` through an authoritative boundary. The binding
has an installation ID, immutable binding-version ID, canonical digest, exact tenant, project, and
environment scope, authorized issuer identities, allowed policy modes, and validity interval. A
policy definition carries only an exact reference to that binding.

The reference implementation uses an installation-owned static registry with no network access.
The policy-author request cannot create, edit, or select registry contents through arbitrary URLs,
labels, credentials, or provider configuration. Publication resolves the reference before server
time or persistence, checks exact scope and issuer authorization, and rejects unavailable,
expired, cross-tenant, or digest-mismatched bindings.

This binding authorizes publication in a bounded scope. It is not the later installation-owned
selection that decides which policy is required for a particular CI target. That selection remains
part of the accountable-decision checkpoint.

### Define one immutable semantic version

`ReleasePolicyDefinition` binds at least:

- `policyId`, `policyVersionId`, a normalized semantic version, schema version, and canonical
  definition digest;
- exact tenant, project, and environment scope plus the installation-binding reference;
- server-authored publisher principal and publication time;
- issuer identity and exact authority evidence;
- mode `advisory` or `mandatory`;
- one total applicability selector and a non-empty ordered set of finite typed rules;
- approval requirements declared as future decision prerequisites, never as completed approvals;
- a positive effective and expiry interval;
- an optional predecessor or superseded-policy reference within the same policy identity and
  scope;
- qualified supporting sources and separately retained counterevidence;
- rationale, assumptions, known limitations, exclusions, and change rationale; and
- an explicit content projection that permits references and bounded metadata but never classified
  plaintext or credentials.

Semantic version text is data, not identity: exact policy identity always includes the immutable
version ID and digest. Build metadata, aliases such as `latest`, mutable tags, client-authored
timestamps, or a version string without the digest-bearing record cannot select a policy.

Any semantic change creates a new version. This includes changing a threshold, operand, unit,
mode, applicability dimension, validity interval, required source, counterevidence, approval
quorum, independence rule, non-waivable flag, assumption, exclusion, or known limitation.
Identical retries are idempotent; conflicting reuse of any policy or version identity fails.

### Make applicability a flat, total, exact conjunction

Policy applicability is not a free-form Boolean program. The initial contract explicitly covers:

- installation, tenant, project, and environment identity;
- candidate task kind and exact bounded purpose;
- risk tier and maximum data classification;
- jurisdiction and locale, including explicit requirements for absence where appropriate; and
- the candidate's bounded, normalized, sorted population labels.

Every dimension declares one finite selector such as `any`, `equals`, `one_of`, `contains_all`, or
`absent`; selector availability depends on the field type. All dimensions are conjoined. There is
no `not`, regular expression, arbitrary property path, nested Boolean expression, implicit default,
or partial-object match. `any` is an explicit author choice, not an omitted field.

The contract has fixed item, character, and collection limits and canonical sorted uniqueness.
Missing candidate data required by a selector will later be `indeterminate`, not false or zero. A
definition that cannot express its intended scope without an unsafe partial match is rejected; it
is not broadened automatically.

### Use a finite non-executable rule vocabulary

Each rule has a unique ordered rule ID, severity, rationale, qualified source references,
non-waivable flag, and exactly one predicate. The first schema supports only these predicate kinds:

| Predicate | Bounded meaning |
| --- | --- |
| `comparison_threshold` | Select one exact comparison metric and baseline, candidate, or delta operand; compare an exact decimal using an allowlisted comparator and unit |
| `coverage_floor` | Require exact integer sample, paired-sample, decided-sample, or basis-point coverage minima from a retained comparison or assessment |
| `uncertainty_bound` | Require a named retained interval method, confidence level, and exact lower or upper bound without recomputing an undeclared method |
| `eligibility_required` | Require an exact assessment class and its retained eligibility state, including explicit unavailable or contested states |
| `artifact_required` | Require a unique candidate component role, digest-bearing artifact, allowed media type, and maximum classification |
| `safety_event_ceiling` | Require a named policy-independent safety-event class and an exact non-negative count ceiling from retained evidence |
| `approval_required` | Declare bounded reviewer roles, quorum, independence groups, and conflict rules for the later decision checkpoint |

Numeric comparisons use canonical exact decimals or non-negative integers. Ratios use integer
numerator and denominator or integer basis points. The initial unit registry reuses only the
canonical units already emitted by typed comparison metrics, plus `basis_points` for an exact
derived ratio: `artifacts`, `assurance_records`,
`attempts`, `basis_points`, `bytes`, `calls`, `cases`, `evaluation_outcomes`, `events`,
`interactions`, `milliseconds`, `provider_cost_microunits`, `requests`, and `tokens`. Arbitrary
`numeric_measurement` units are not policy operands in the first schema. An evidence unit outside
the registry cannot be converted or guessed; the policy must be rejected or a later evaluator must
produce `indeterminate`, according to which boundary discovers the mismatch.

Rules cannot contain JavaScript, SQL, shell, WebAssembly, templates, regular expressions, model
prompts, arbitrary expressions, executable artifacts, network locations, credentials, dynamic
imports, clocks, randomness, or retry instructions. They cannot request a mutable external lookup.
Adding another predicate or unit requires a schema version, canonical vector, review, and migration;
it cannot be smuggled through a label or metadata field.

An `approval_required` rule only declares a future prerequisite. It never reports approval and
cannot be satisfied in this checkpoint. A policy requiring separation must exclude the policy
author from its eligible reviewer set; high and critical risk policies require at least one
independent human approval group. Actual approval and exception semantics remain closed.

### Reuse qualified sources without trusting them blindly

Each supporting source is an exact `SourceSnapshot` plus its exact approved `SourceReviewRecord`.
Publication independently resolves retained bytes and both digests, verifies matching scope,
accepted authority, approved applicability, current freshness, usable licensing, resolved critical
conflicts, reviewer qualification where required, and a validity interval covering the complete
policy interval. A source snapshot's own expiry, when present, must also cover that interval.

The policy author cannot review their own source authority when independence is required. Sources
with missing retained bytes, disputed identity, rejected or uncertain authority, unknown freshness,
unknown or restricted licensing, unresolved critical conflict, expired review, or mismatched scope
fail publication. Counterevidence is retained and resolved with the same exact-source boundary; it
cannot be deleted merely because it disagrees with the desired threshold.

Search, retrieval rank, snippets, generated summaries, model output, majority vote, publisher
branding, and signatures are discovery or integrity signals only. They do not make a policy
correct. Publication proves that the declared authority chain was satisfied at a bounded time and
scope, not that the organization's risk choice is wise, lawful, complete, or safe.

### Preserve expiry, withdrawal, and supersession as history

The definition's effective and expiry interval is immutable and finite. Effective time cannot
precede the valid authority evidence, publication cannot occur after expiry, and expiry cannot
extend beyond an installation binding or required source review.

Withdrawal and supersession are separate append-only lifecycle records. Each binds the exact
policy version and digest, actor, server time, reason, and optional exact successor. A withdrawal
cannot rewrite or delete the definition. Supersession requires a successor with the same logical
policy ID and exact scope, and predecessor cycles are rejected. Historical reads always return the
original definition and lifecycle history.

The later evaluator receives an explicit evaluation time and derives whether the version was
effective, expired, withdrawn, or superseded then. This checkpoint may expose that history but does
not perform or persist a policy evaluation.

## Authority and persistence boundaries

### HTTP and principal capabilities

- Introduce `policy:read` for exact-version and lifecycle reads.
- Introduce non-delegable `policy:author` for definition, withdrawal, and supersession publication.
- Keep `policy:evaluate` reserved for the later evaluator worker; it grants no publication route.
- Remove the unused `policy:manage` placeholder from the active capability schema and stored
  identity allowlists without silently converting existing credentials into `policy:author`.
- Keep `approval:decide` unused until the accountable-decision entry audit splits its exact powers.

Authentication and capability checks occur before route identity parsing, body parsing, source
resolution, time reads, or repository calls. Restricted resource scope must include the exact
project and environment. A development principal may carry the capabilities for local examples,
but production API-key issuance must not delegate `policy:author` to a workload.

### PostgreSQL role and repository

Add a `policyAuthor` runtime role with distinct credentials, `NOINHERIT`, no memberships, no
superuser or bypass-RLS attributes, and grants only for policy publication, lifecycle append, and
exact policy reads. The API composition uses a dedicated policy-author repository connection for
these mutations; the general API, publisher, identity, candidate, evaluation-worker, and reviewer
roles cannot substitute for it.

The PostgreSQL representation must include normalized scope, resource, version registry,
definition body, exact source and rule projections, lineage, lifecycle, and atomic outbox intent.
Tables use tenant-bearing keys, forced RLS, transaction-local tenant/project/environment context,
private DML, constraint triggers that prove one exact body and complete projections, and immutable
triggers. Security-definer functions use a fixed `pg_catalog` search path and recheck authoritative
scope. Restore reprovisions the role from operator-supplied credentials; credentials never enter a
backup or policy record.

Memory and PostgreSQL adapters run the same repository conformance suite. Reads use exact policy and
version IDs only. There is no authoritative `latest` read. Identical publication and lifecycle
retries return the original record and emit one intent; semantic conflicts fail without partial
writes.

## Public boundary and contributor slice

The public slice must include:

- strict request, record, reference, lifecycle, applicability, rule, and problem schemas;
- a domain-separated canonical encoder and fixed public UTF-8/SHA-256 vectors;
- authorization-first publication, lifecycle, and exact-read use cases;
- memory and PostgreSQL repositories plus unchanged conformance tests;
- exact-version HTTP routes, generated OpenAPI 3.2 operations, and bounded TypeScript SDK methods;
- an installation-binding and source-authority interface with deterministic local references;
- coordinated recovery, role substitution, and three-tenant collision tests; and
- one disposable clean-checkout example that publishes, retries, restarts, reads, withdraws or
  supersedes, and proves immutable history without evaluating the policy.

The example must use a real retained candidate and qualified source records from the accepted
flows. It must state that the static installation registry is operator-owned configuration, that
its evidence is synthetic, and that policy publication is not approval or enforcement.

## Required adversarial evidence

| Threat or ambiguity | Required rejection or proof |
| --- | --- |
| Arbitrary executable policy | Reject code, expressions, regex, prompts, URLs used as execution targets, credentials, unknown predicate kinds, and future schema versions |
| Unit ambiguity | Reject unknown units, implicit conversion, floating values, malformed decimals, zero denominators, and incompatible threshold operands |
| Unsafe applicability | Reject omitted selectors, duplicate or unbounded labels, arbitrary paths, unknown fields, partial scope, and cross-installation or cross-tenant binding |
| Policy overwrite or downgrade | Preserve advisory/mandatory mode and every semantic field in the digest; require a new version and lineage; deny update/delete |
| Weak source authority | Reject missing bytes, bad digests, expired or non-approved reviews, disputed identity, unresolved conflicts, mismatched scope, and author self-review where independence is required |
| Approval smuggling | Reject completed-approval, decision, exception, signer, credential, CI, deployment, or release fields; keep approval rules declarative |
| Time confusion | Reject client receipt time, non-positive validity, publication after expiry, authority intervals that do not cover policy validity, and lifecycle events before publication |
| Identity collision | Reject conflicting policy ID or version reuse, predecessor cycles, wrong logical identity, wrong route identity, and exact IDs colliding across resources |
| Role substitution | Deny policy mutation through API, candidate, publisher, identity, evaluation-worker, model-worker, human-reviewer, or replay-worker database roles |
| Recovery drift | Empty-target restore preserves exact digest, source edges, rule order, lifecycle, predecessor/successor graph, outbox intent, RLS, and idempotency |
| Misleading public claim | Documentation and API descriptions say “policy definition,” never “approved,” “safe,” “released,” “enforced,” or “production ready” |

Property tests must cover comparator boundaries, exact-decimal normalization, rule ordering,
applicability selector totals, size/depth limits, lifecycle order, and canonical insertion-order
independence. API tests must cover authorization before malformed payloads, body and response size,
media type, cache policy, redirect rejection, stable problems, and exact route/record identity.

## Implementation sequence and exit gate

Implementation proceeds in this dependency order, with a green pushed commit before the next
semantic slice:

1. capabilities, strict contracts, canonical encoding, fixed vectors, and adversarial unit tests;
2. installation/source authority ports, pure validation, lifecycle use cases, memory repository,
   and shared conformance;
3. PostgreSQL migration, dedicated role, RLS, append-only projections, outbox, integration,
   isolation, and recovery;
4. API composition, exact routes, OpenAPI, TypeScript SDK, and cross-boundary tests;
5. real-flow example, clean-checkout acceptance, English-primary guidance, completion audit, and
   independent claim review.

Checkpoint acceptance requires all local repository gates that can run on the host, a frozen clean
install, production dependency audit, secret scan, CodeQL, and every remote CI job at the exact
pushed audit commit. The completion audit must name the tested SHA and preserve every unverified
deployment or production boundary.

## Explicit non-goals

This checkpoint does not:

- determine whether a policy is correct, sufficient, representative, lawful, or safe;
- choose the applicable policy for a candidate or mandatory CI target;
- evaluate predicates or emit `satisfied`, `violated`, `indeterminate`, or `not_applicable`;
- approve an exception, make a release decision, sign an attestation, or publish a check;
- fetch, browse, refresh, or rank sources during publication or later evaluation;
- execute arbitrary tenant policy code or add a plugin sandbox;
- provide a browser policy editor or claim that a local form is authoritative; or
- approve inline agent-action control, deployment, high availability, RPO/RTO, or production
  readiness.

Only an accepted completion audit may open deterministic policy-evaluation implementation.
