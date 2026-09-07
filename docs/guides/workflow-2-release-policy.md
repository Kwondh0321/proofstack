# Publish and retain an immutable Workflow 2 release policy

[English](workflow-2-release-policy.md) |
[한국어](workflow-2-release-policy.ko.md)

The frozen contract and exit gates for this checkpoint are recorded in the
[versioned policy-definition entry audit](../development/workflow-2-policy-definition-entry-audit.md).

This guide exercises ProofStack's bounded policy-definition boundary. It builds the complete
retained Workflow 1 graph and an immutable release candidate, publishes independently authored and
reviewed source records, resolves an operator-owned installation binding, and publishes one
append-only release policy through the public API and TypeScript SDK. It then retries, reads,
withdraws, restarts, and reads the exact history again.

This flow does not select the policy for the candidate or evaluate a rule. It does not approve,
decide, sign, report a CI result, deploy, or block a release.

## Exact retained graph

```text
retained Workflow 1 comparison + model-assurance assessment
  + retained Workflow 2 release candidate
  + operator-owned installation binding and retained authority evidence
  + retained source snapshot and identity-verification evidence
  + retained reviewer qualification and credential evidence
  + independent source review and review-basis evidence
  -> immutable ReleasePolicy version
  -> append-only withdrawal event
```

The candidate is created in the same acceptance run to prove the upstream subject remains
available. The policy definition binds exact comparison and assessment records, qualified source
records, and the installation binding. A later checkpoint must explicitly select an applicable
policy and evaluate it against a candidate; this checkpoint deliberately creates no hidden
candidate-to-policy decision.

Every definition, source, review, qualification, binding, and lifecycle reference uses an exact ID
and canonical digest. Repeating the same publication returns the original immutable record;
reusing an identity for different semantics is a conflict.

## Authority and trust boundaries

The clean-checkout reference keeps these responsibilities separate:

| Responsibility | Reference authority | What it establishes |
| --- | --- | --- |
| Installation authorization | Operator-owned static registry loaded when the API is composed | Exact installation, scope, permitted issuer, policy mode, validity interval, and retained authority-evidence digest |
| Source publication | Distinct source-publisher principal | The exact source definition and retained content reference that was published |
| Source identity verification | A separately named identity verifier in the source record | The claimed verification method, time, verifier, and retained evidence; not real-world truth by itself |
| Reviewer qualification | Distinct credential-authority principal | The exact qualification, competence declaration, limits, validity, and retained credential evidence |
| Source review | Distinct reviewer principal bound to the qualification | Approved scope, licensing, freshness, conflicts, relationships, rationale, and retained review basis |
| Policy publication and withdrawal | Installation-authorized, non-workload policy issuer | The exact finite policy vocabulary, source lineage, applicability, assumptions, limitations, and lifecycle history |
| Durable records | Forced-RLS PostgreSQL plus S3-compatible immutable content | Exact-scope persistence and read-back across API restarts |

The static installation registry is configuration owned by an operator, not a policy-author input or
a public discovery mechanism. It cannot be created or changed through the policy publication
request. Production installations need their own reviewed configuration distribution and change
control.

The example uses separate synthetic principal IDs so the reference architecture can prove that one
actor did not silently perform every authority role. Those IDs do not prove that a human exists,
that the reviewer has real expertise, or that the source is correct. Cryptographic digests prove
integrity and exact identity, not semantic truth.

The source snapshot may omit its own `expiresAt` when the source declares no expiry. Publication
does not invent one or treat that absence as unlimited freshness: an approved, current source
review, the required reviewer qualification, and the installation binding must still cover the
policy's entire finite validity interval. A declared source expiry is an additional upper bound;
it may equal the policy expiry but must not precede it, including by one microsecond. Missing
retained content or an unknown freshness conclusion still prevents publication.

## Transport size boundary

Policy and lifecycle mutation requests permit at most 1,048,576 bytes (1 MiB) of UTF-8 JSON.
The TypeScript SDK checks its serialized request before sending; the HTTP API independently
enforces the same byte limit after authentication and authorization, before source resolution or
storage. Character count is not byte count: a supplementary Unicode character uses four UTF-8
bytes, while an escaped JSON representation may use more.

The shared default response limit is 1,052,672 bytes (1 MiB + 4 KiB). This reserves bounded space for
server-added identifiers, scope, timestamps, digests, exact lineage, and JSON integer expansion.
A request at the supported limit can therefore be published, read, and retried without its valid
receipt being rejected solely because the server added metadata. The API rejects an oversized
internal response with a bounded, non-cacheable error; the SDK checks both declared and actual
streamed response bytes and cancels an oversized stream. A caller may deliberately set a smaller
SDK `maxResponseBytes`, but not exceed the shared response ceiling.

These are transport budgets, not changes to the policy's semantic limits or an authorization to
embed classified content. The focused local transport tests use synthetic authority fixtures and
memory storage; the clean-checkout acceptance below separately exercises the retained database and
object-storage flow.

## Requirements

- A clean checkout of this repository.
- Git, Node.js 24 or newer, and pnpm 11.24.0.
- A running Docker daemon with Docker Compose v2.
- Network access for the first frozen dependency install and pinned container-image pull.

No application server or fixed port is required. The runner allocates random loopback ports for a
disposable PostgreSQL database and S3-compatible object store. It ignores `.env` and does not accept
an external database, bucket, checkout, source URL, or credential.

## Exact clean-checkout procedure

Run from a terminal:

```bash
git clone https://github.com/Kwondh0321/proofstack.git
cd proofstack
pnpm install --frozen-lockfile
pnpm test:acceptance:workflow-2-policy
```

Do not start `pnpm dev`, create a bucket, or run migrations separately. The command builds the
required packages, starts isolated services, applies the checksum-verified migration ledger,
provisions randomized least-privilege roles, executes the complete acceptance flow, and removes its
named containers, network, and volumes.

## Expected success

Identifiers and ports vary on every run. These stable signals identify a successful run:

```text
Docker Compose version ...
Starting isolated Workflow 2 policy services as proofstack-workflow-2-policy-...
PostgreSQL uses loopback port ...; object storage uses ....
...
Test Files  1 passed (1)
Tests  1 passed (1)
...
Workflow 2 policy acceptance passed. Removing the isolated services and volumes.
```

The command exits with status zero only when both the test and cleanup succeed. The matching
`Workflow 2 policy clean-checkout acceptance` GitHub Actions job performs a frozen install and runs
the same root command.

## What the acceptance run proves

The run:

1. creates the real retained Workflow 1 trace, regression, replay, evaluation, assurance, and
   comparison graph in PostgreSQL and S3-compatible storage;
2. publishes and verifies an exact release candidate for the checked-out commit and tree;
3. reserves and uploads every source, identity, credential, review, and installation-authority
   artifact through the public SDK;
4. publishes the source snapshot, reviewer qualification, and source review under distinct scoped
   principals;
5. restarts the API and resolves those PostgreSQL records plus the operator-owned installation
   binding instead of trusting in-process publication objects;
6. publishes the policy under the authorized issuer, retries the identical request, and reads the
   exact immutable version;
7. appends a withdrawal event, retries it, and reads its exact binding to the policy digest;
8. restarts the API again and proves that all authority records, the candidate, policy rules,
   sources, installation binding, and lifecycle event read back unchanged; and
9. retains real Workflow 1 comparison and model-assurance references in the policy predicates
   without evaluating those predicates.

Memory and PostgreSQL adapters also share repository conformance tests. PostgreSQL integration
separately proves forced row-level isolation, append-only projections and lifecycle records,
dedicated policy-author role limits, atomic outbox intent, and exact idempotency. Coordinated
recovery preserves definitions, predecessor lineage, lifecycle history, source edges, rule order,
and digests in an empty target.

## Conservative failure behavior

Publication fails before an authoritative write when authentication, capability, scope, route
identity, installation binding, issuer, mode, validity, source, review, qualification, retained
artifact, digest, applicability, finite rule vocabulary, ordering, predecessor, or lifecycle
semantics are invalid. Reads require exact policy, version, and event IDs; there is no mutable
`latest` alias. Workload credentials cannot author or withdraw policies.

The runner does not fall back to memory storage when Docker, migration, PostgreSQL, object storage,
Git resolution, or cleanup fails. General environment errors and cleanup guidance are in the
[Workflow 1 acceptance guide](workflow-1-acceptance.md); the Compose project name for this command
begins with `proofstack-workflow-2-policy-`.

## What a green result cannot establish

All authority data in this example are synthetic. A green result proves exact provenance,
separation of declared roles, bounded validation, integrity, idempotency, persistence, isolation,
and recovery within the reference architecture. It does not prove that:

- the source content is true, complete, current in the real world, or representative;
- the declared publisher, verifier, credential authority, or reviewer is a legitimate expert;
- the organization's threshold, applicability, risk tolerance, or exception rule is wise, lawful,
  sufficient, or safe;
- the retained comparison or assessment is causally valid or predicts production behavior; or
- the policy applies to a particular candidate or has been satisfied.

Search engines and retrieval can help discover candidate standards and counterevidence, but ranking
is not authority. A future criteria-retrieval layer must retain exact versions, provenance,
freshness, conflicts, and uncertainty and must stop as unverifiable or require approval when the
authority chain is inadequate. It cannot silently turn search results into mandatory policy.

Policy evaluation, installation-owned selection, accountable human approval, exception handling,
release decisions, signed attestations, generic CI status delivery and verification, rollback,
break-glass controls, deployment, live-provider validation, high availability, and production
readiness remain separate dependency-ordered checkpoints.
