# Retain an immutable Workflow 2 release candidate

[English](workflow-2-release-candidate.md) |
[한국어](workflow-2-release-candidate.ko.md)

Checkpoint acceptance is recorded in the
[immutable release candidate audit](../development/workflow-2-release-candidate-audit.md).

This guide exercises the first Workflow 2 subject boundary. It starts from the complete retained
Workflow 1 graph, resolves every referenced record through an authoritative repository boundary,
and publishes one append-only release candidate. A candidate is an exact input to later policy
evaluation. It is not a policy result, approval, release decision, signature, CI status, deployment
instruction, or claim that the underlying agent is correct.

## What is bound

The reference flow retains this exact graph:

```text
checked-out Git commit and its exact tree
  + build provenance artifact
  + prompt and tool-contract artifacts
  + model declaration and adapter definition
  + fixture, dataset, and target-release versions
  + evaluation and model-assurance assessments
  + descriptive comparison result
  -> immutable ReleaseCandidate version
```

Every retained record and artifact reference carries an exact identifier and semantic digest. The
candidate itself has a canonical digest, exact tenant/project/environment scope, server-authored
creation fields, explicit limitations, and an optional exact predecessor. Publishing the same
canonical definition again is idempotent; publishing different semantics under the same version is
a conflict.

## Authority boundaries

The reference composition uses three independent sources of authority:

| Subject | Reference authority | Failure behavior |
| --- | --- | --- |
| Git commit and tree | An operator allowlists an absolute local checkout, HTTPS repository URL, and exact scope | Missing repository, wrong object format, abbreviated or nonexistent object, or a commit/tree mismatch is unavailable |
| Model and adapter | An installation-owned runtime registry is copied and validated when the API starts | Any provider, resolution, version, definition digest, or scope mismatch is unavailable |
| Retained artifacts and Workflow 1 records | Existing exact-scope artifact, regression, replay, evaluation, model-assurance, and comparison repositories | Missing, changed, cross-scope, or unresolved references reject publication |

The local Git authority never clones, fetches, follows a branch or tag, or treats a repository URL as
proof. It resolves the full commit and tree object IDs from the already trusted checkout without
network access and verifies the commit-to-tree relationship. Operators remain responsible for
allowlisting the intended checkout and repository identity.

The static runtime registry is a bounded reference implementation for installation-owned
configuration. It does not discover model identity from candidate text. The bundled provider
declares only a model alias because its synthetic provider exposes no immutable served-model ID;
that limitation is retained in the candidate instead of being upgraded to an exact-version claim.

## Requirements

- A clean checkout of this repository.
- Git, Node.js 24 or newer, and pnpm 11.24.0.
- A running Docker daemon with Docker Compose v2.
- Network access for the first frozen dependency install and pinned container-image pull.

No application server or fixed port is required. The runner allocates random loopback ports for a
disposable PostgreSQL database and S3-compatible object store. It does not read `.env` or accept an
external database, bucket, or Git checkout target.

## Exact clean-checkout procedure

Run from a terminal:

```bash
git clone https://github.com/Kwondh0321/proofstack.git
cd proofstack
pnpm install --frozen-lockfile
pnpm test:acceptance:workflow-2-candidate
```

Do not start `pnpm dev`, create a bucket, or run migrations separately. The command builds the
required packages, starts isolated services, applies the real migration ledger, provisions
randomized least-privilege database roles, executes the acceptance flow, and removes its named
containers, network, and volumes.

## Expected success

Identifiers and ports vary on every run. These stable signals identify a successful run:

```text
Docker Compose version ...
Starting isolated Workflow 2 candidate services as proofstack-workflow-2-candidate-...
PostgreSQL uses loopback port ...; object storage uses ....
...
Test Files  1 passed (1)
Tests  1 passed (1)
...
Workflow 2 candidate acceptance passed. Removing the isolated services and volumes.
```

The command exits with status zero only if the test and cleanup both succeed. The matching
`Workflow 2 candidate clean-checkout acceptance` GitHub Actions job runs the same root command after
a frozen install.

## What the acceptance run proves

The run:

1. creates the real Workflow 1 trace, captured interaction, replay, evaluation, assurance, and
   comparison graph in PostgreSQL and S3-compatible storage;
2. restarts the API and workers before completing the upstream graph;
3. resolves the exact checked-out commit and its tree plus installation-registered model and
   adapter declarations;
4. reads the retained fixture and target release through public SDK boundaries;
5. publishes the candidate through the public release-candidate SDK, retries the identical request,
   and verifies that only one immutable version exists; and
6. restarts the API again and proves the same candidate fields and canonical digest read back.

The separate coordinated-recovery integration creates a candidate and exact successor, restores a
logical backup into an empty target, verifies both digests and predecessor lineage, and rechecks
idempotent publication. PostgreSQL integration also exercises forced row-level isolation and
append-only/outbox behavior.

## Conservative failure behavior

Invalid input fails before an authoritative write. Publication rejects client-authored server
fields, missing required component kinds, duplicate component roles, unsorted or duplicate exact
references, malformed or mismatched digests, unavailable sources, cross-scope references, invalid
predecessors, and conflicting retries. Reads require an exact candidate and version under the
authenticated scope; there is no mutable “latest” read.

The runner does not fall back to memory storage when Docker, migration, storage, Git resolution, or
cleanup fails. Common environment errors and cleanup guidance are documented in the
[Workflow 1 acceptance guide](workflow-1-acceptance.md); the printed Compose project name for this
command begins with `proofstack-workflow-2-candidate-`.

## What this cannot claim

A green result proves integrity, exact reference resolution, idempotency, persistence, isolation,
and recovery only within the bounded reference architecture. It does not prove that requester
instructions, criteria, model outputs, retrieved sources, assessments, or business objectives are
correct. Search rank, source branding, majority vote, and a future cryptographic signature cannot
independently establish that correctness.

It also does not provide a release policy, mandatory gate, exception approval, accountable release
decision, signed attestation, GitHub status, generic CI delivery, rollback, break-glass action,
deployment, live-provider compatibility, production identity, high availability, or production
readiness. Those capabilities remain separate ordered Workflow 2 checkpoints.
