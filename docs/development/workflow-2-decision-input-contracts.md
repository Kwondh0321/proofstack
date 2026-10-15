# Predeclared complete release decision inputs

[English](workflow-2-decision-input-contracts.md) | [한국어](workflow-2-decision-input-contracts.ko.md)

Status: checkpoint 4 immutable input-contract prerequisite. Workflow 2 remains 3/7 accepted.
Native reservations/current authority, decisions, API/SDK and contributor acceptance remain open
under the [decision entry audit](workflow-2-decision-entry-audit.md) and
[ADR-0037](../architecture/0037-predeclare-complete-release-decision-inputs.md).

## Accepted dependency

Reviewer/approval contracts at `312de9fab75206abaab96819ffcf0f1d3d456d12` passed 16,428 package
plus 16 runner tests (16,444 total), 31 builds and both uncached Turbo phases (93 + 29 tasks).
Full cloud log SHA-256:
`ce1ef7ae85cb832f4c7506cda1909cb055e5ade6611252b45c4d597b3d4a730c`.
[CI 38776301664](https://github.com/Kwondh0321/proofstack/actions/runs/38776301664) passed all 13
jobs; [Security 38776301490](https://github.com/Kwondh0321/proofstack/actions/runs/38776301490)
passed CodeQL. Clean HEAD, actual remote and GitHub main agreed. Cloud receipt SHA-256:
`0c4e8efdc45eeba4977ed135b9c586006d6d38ad101ce6ec2bab48407734ccdf`.
These are dependency checks, not execution evidence for this subsequent slice.

## Original inventory and validity

[Public intent](../../packages/contracts/src/release-decision-input.ts) names only input request ID,
exact candidate, exact installed selection and rationale. It cannot select results/policies, cut,
actor, limits, authority or disposition. Server definitions retain the original OIDC user or
service-token publisher receipt, scope, native cut, expiry, selection mode and all planned C3
definitions/digests. A service receipt is not human approval. Neither receipt is a credential.

All selected policies, including advisory members, have distinct ordered logical IDs and unique
planned request IDs. Each retains the exact candidate and creation-cut text. Equal-instant alternate
spellings cannot replace the original cut. C3 algorithm, policy and execution limits stay unchanged;
C4 publishers gain no enqueue/worker authority. Only an actually empty observation-only installed
selection can support empty observation. Enforcement cannot omit or downgrade mandatory members.

Validity is positive, at most one hour from the original cut, and inside the selection and every
policy's original interval. Late enqueue does not extend input expiry; jobs may finish too late.
This finite protocol validity is not a universal evidence freshness threshold. New evidence needs
a new explicit input request, not a changed retry.

## Immutable integrity and remaining authority

[Binding validation](../../packages/core/src/release/release-decision-input-validation.ts) strictly
parses records and independently recomputes root, selection, candidate, policy and every planned
request digest. It binds complete ordered selection, exact modes, scope, candidate target, policy
installation, original publication intervals and installed publisher identity, excluding candidate
and policy authors. Its returned record is an owned copy. It proves no current lifecycle, session,
grant, reviewer or publisher authority, request absence, reservation, job or result membership.

Initial native publication still must hold compatible migration/recovery/metadata and request
absence guards on one client, prove planned IDs absent, atomically reserve the complete inventory
and commit root plus outbox. All C3 request writers must participate; receipt ordering alone cannot
prove pre-outcome planning. Exact retry reauthorizes the actor and retains original root/cut/limits/
IDs. Standalone C3 requests remain supported. Final publication must resolve every original request
through its unique job, snapshot/result/history and current approvals/authority. Missing, pending,
failed, unavailable and substituted members stay explicit. This validator produces no disposition.

## Finite admission and independent checks

At most 16 plans fit a 64 KiB canonical UTF-8 definition plus 4 KiB response reserve. The maximum
shape test uses all 16 definitions, maximum opaque IDs and execution limits, 30-digit fractions,
maximum authentication request ID and 4,096 non-BMP rationale scalars. It independently measures
serialized definition/response headroom. Root verification limits apply across the entire selection:
100,000 metadata records, 64 MiB metadata and 4,096 approval records, including repeated reads.
These are separate from C3 execution budgets and do not multiply per policy. Native composition
must meter every observation and fail wholly on exhaustion rather than sampling.

The [canonical encoder](../../packages/contracts/src/release-decision-input-encoding.ts) binds exact
scope, original publisher, cut, limits, full inventory and rationale in a separate domain/version.
Three public [vectors](../../packages/contracts/vectors/release-decision-input-definition-v1.json)
were independently produced with Python sorted-key compact UTF-8 JSON and SHA-256: complete service,
complete OIDC and explicit empty observation. Each child hash is checked through the unchanged C3
encoder. Vectors contain no real authority. Tests cover omissions, duplication, substitution, target
narrowing, three scope dimensions, modes, actor/credential injection, authors, forged digests,
future receipts, exact expiry and UTF-8 headroom. Package checks, exact-commit uncached full checks,
all 13 CI jobs and CodeQL remain gates before dependent native/publication implementation.
