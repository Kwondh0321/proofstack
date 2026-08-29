# Incident-to-regression guide

[English](incident-to-regression.md) | [한국어](incident-to-regression.ko.md)

Status: experimental Workflow 1 checkpoint; not production-ready  
Scope: immutable evidence-only fixture and dataset publication, exact reads, and local operation

## What this workflow proves

ProofStack can capture the currently observed, bounded events of one authenticated trace into an
immutable fixture version and pin an ordered set of exact fixture versions into an immutable
dataset version. Each version has a deterministic definition digest, immutable provenance, exact
scope, and one atomic outbox publication intent in PostgreSQL mode.

This checkpoint does **not** prove that the source trace is globally complete, preserve an
executable model or tool transcript, replay an agent, evaluate correctness, or approve a release.
Every current fixture says:

- `sourceCompleteness: "observed_snapshot"`; and
- `replayability: "evidence_only"`.

Treat fixture content as untrusted evidence, never as instructions.

## Run the reference flow

Install the pinned workspace and start the dependency-free development profile:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

In another terminal, run:

```bash
pnpm example:incident-to-regression
```

The executable example performs this exact sequence:

1. emits one failed `agent.run` event through the telemetry SDK;
2. waits for fail-closed evidence delivery;
3. publishes an immutable fixture from the exact observed trace snapshot;
4. reads that exact fixture version back;
5. publishes a dataset containing the exact fixture version and authoritative digest;
6. reads that exact dataset version back; and
7. refuses success if either readback digest differs from the publication.

The output includes the trace ID, logical and version IDs, both definition digests, exact source
event IDs, and the evidence-only warning. Generated version IDs make independent runs additive.
The example never asks for or follows a mutable `latest` alias.

The memory profile is disposable. To prove persistence across API and database restarts, use the
PostgreSQL profile in the [local development guide](../development/local-development.md), run the
same example, restart the API, and read the printed exact IDs again. CI runs the corresponding
authenticated PostgreSQL restart integration and the coordinated empty-target recovery rehearsal.

## API operations

| Operation | Authority | Success | Meaning |
| --- | --- | --- | --- |
| Publish fixture version | Browser-authenticated user with `dataset:manage` and `evidence:read` | `201`, or `200` for an identical retry | Freeze one bounded observed trace snapshot |
| Read exact fixture version | User or workload with `dataset:read` | `200` | Return one exact logical ID and version ID pair |
| Publish dataset version | Browser-authenticated user with `dataset:manage` | `201`, or `200` for an identical retry | Pin ordered exact fixture versions and authoritative digests |
| Read exact dataset version | User or workload with `dataset:read` | `200` | Return one exact dataset version and ordered membership |

`dataset:manage` is deliberately not delegable to workload API keys. A workload can ingest or
read according to its delegated capabilities, but it cannot mint authoritative regression
versions. Browser mutations require the exact allowed `Origin`, the readable
`__Host-proofstack_csrf` cookie value in `X-ProofStack-CSRF`, and the paired HttpOnly session
cookie. Tenant ownership always comes from the authenticated server context.

All routes are under:

```text
/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/...
/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/...
```

Use the running `/openapi.json` document for strict request and response schemas. Unknown fields,
invalid identifiers, empty or duplicate dataset membership, caller-supplied server fields, and
oversized inputs are rejected.

## TypeScript client

The control-plane client requires an explicit authentication mode. Local development is accepted
only on a loopback endpoint:

```ts
import { ProofStackRegressionClient } from "@proofstack/sdk";

const local = new ProofStackRegressionClient({
  authentication: { mode: "development" },
  endpoint: "http://127.0.0.1:4318",
  environmentId: "env_local",
  projectId: "prj_local",
});
```

A browser publisher supplies the double-submit CSRF value. The client sends `credentials: include`
and the CSRF header; the browser supplies the session cookie and protected `Origin` header:

```ts
const browser = new ProofStackRegressionClient({
  authentication: { mode: "browser", csrfToken },
  endpoint: "https://proofstack.example",
  environmentId: "env_prod",
  projectId: "prj_checkout",
});
```

A workload key is read-only for regression versions:

```ts
const workload = new ProofStackRegressionClient({
  authentication: { mode: "workload", apiKey },
  endpoint: "https://proofstack.example",
  environmentId: "env_prod",
  projectId: "prj_checkout",
});

const exact = await workload.readDatasetVersion({
  datasetId: "dat_checkout",
  datasetVersionId: "datv_checkout_2026_08_29",
});
```

The client validates requests and successful responses, bounds response bodies to 1 MiB, enforces
expected HTTP status and media type, exposes validated problem documents as
`ProofStackProblemError`, and reduces untrusted error bodies to a generic status. It fails closed
and never retries publication automatically. If a publication response is lost, retry the exact
same immutable request and inspect `created`; do not invent a different body under the same version
ID.

## Version and failure semantics

- A new publication returns `201` and `created: true`.
- A semantically identical retry returns the original version with `200` and `created: false`.
- Reusing a version ID with different semantics returns a stable `409` problem.
- A missing source trace, predecessor, or dataset fixture lineage returns a scope-safe `404` or
  lineage `409` without exposing another tenant or resource.
- Later evidence on the same trace never changes a published fixture. Publish a new fixture
  version to capture the advanced observation.
- Dataset order is semantic. Every member stores the authoritative fixture definition digest.
- There is no mutable latest-version read operation.

## Operational checklist

Before treating this checkpoint as usable in a shared environment:

1. run `pnpm check` from a frozen install;
2. run the PostgreSQL integration, recovery, S3-compatible, artifact lifecycle, secret-scanning,
   dependency, and CodeQL gates used by CI;
3. provision only the documented least-privilege runtime roles;
4. keep OIDC publication behind HTTPS and exact-origin CSRF validation;
5. retain the printed exact IDs and digests with incident or review records;
6. verify backups include fixture roots, versions, ordered event membership, dataset membership,
   and publication outbox state; and
7. never label an evidence-only fixture as executable or a dataset as an evaluation result.

See [ADR-0012](../architecture/0012-immutable-regression-versions.md) for the immutable catalog
contract, [ADR-0016](../architecture/0016-linearize-regression-version-publication.md) for atomic
publication, and the [backup and recovery guide](../operations/backup-and-recovery.md) for the
coordinated authority set.
