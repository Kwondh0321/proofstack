# Run the complete Workflow 1 acceptance locally

[English](workflow-1-acceptance.md) |
[한국어](workflow-1-acceptance.ko.md)

This is the single bounded contributor path for ProofStack's retained Workflow 1 graph. It creates
an isolated PostgreSQL database and S3-compatible object store, runs the authenticated
failure-to-comparison acceptance flow, and deletes that disposable infrastructure afterward. It
does not start a long-lived API or browser console.

## What the run proves

The test drives one stable lineage through the normal API, TypeScript SDK, repositories, worker
processes, least-privilege database roles, and encrypted artifact adapter:

```text
authenticated failed trace
  -> immutable evidence-only fixture and dataset
  -> classified interaction capture
  -> exact recorded-boundary replay
  -> durable replay jobs and observations
  -> non-model, model-assisted, and synthetic human-review evidence
  -> exact baseline/candidate snapshots
  -> conservative comparison result
```

The run applies the real migration ledger, provisions randomized runtime roles, uses
digest-pinned PostgreSQL and SeaweedFS images, restarts the in-process API at the tested
boundaries, and reads the complete retained graph back. It also proves that classified content is
excluded from ordinary comparison snapshots and that retained critical counterevidence makes the
otherwise exactly paired comparison `incomparable`.

## Requirements

- A clean checkout of this repository.
- Git, because the target release binds the exact checked-out commit.
- Node.js 24 or newer and pnpm 11.24.0.
- A running Docker daemon with Docker Compose v2.
- Network access during the first dependency install and container-image pull.

The runner uses only random loopback ports. It does not need ports 3000, 3010, 3011, 4318, 5432,
or 8333 to be free, and it does not read `.env` or accept an external database or bucket target.

## Exact clean-checkout procedure

Run these commands from a terminal:

```bash
git clone https://github.com/Kwondh0321/proofstack.git
cd proofstack
pnpm install --frozen-lockfile
pnpm test:acceptance:workflow-1
```

Do not start `pnpm dev`, copy an environment file, run migrations, or create a bucket separately.
The acceptance runner owns those steps within its disposable scope.

## Expected success

Exact role, scope, bucket, port, and Compose project identifiers are random. A successful run
contains the following stable signals, with normal build and container output between them:

```text
Docker Compose version ...
Starting isolated Workflow 1 services as proofstack-workflow-1-...
PostgreSQL uses loopback port ...; object storage uses ....
...
Test Files  1 passed (1)
Tests  1 passed (1)
...
Workflow 1 acceptance passed. Removing the isolated services and volumes.
```

The command exits with status zero only when both the acceptance test and infrastructure cleanup
succeed. The matching `Workflow 1 clean-checkout acceptance` GitHub Actions job runs this same
root command after a frozen install rather than maintaining a separate CI-only recipe.

## Conservative failure behavior

Any failed prerequisite, image startup, migration, role grant, API or worker transition, exact
read-back, assertion, or cleanup produces a nonzero exit. The runner never falls back to in-memory
storage or silently keeps a partial result.

| Terminal signal | Meaning | Next action |
| --- | --- | --- |
| `spawn docker ENOENT` | Docker is not installed or not on `PATH` | Install Docker with Compose v2, then retry |
| Cannot connect to the Docker daemon | Docker is installed but its daemon is unavailable | Start Docker, verify `docker compose version`, then retry |
| Compose health or image-pull failure | A pinned service did not become healthy | Read the preceding Docker error; repair disk, network, or daemon health before retrying |
| Vitest or Turbo reports a failed task | A Workflow 1 invariant or build failed | Treat the run as failed and investigate the first test error; do not use later output as acceptance |
| `Workflow 1 cleanup failed` | Containers or volumes could not be removed | Use the printed project name with the manual cleanup command below |

An interrupt is forwarded to the active child process before cleanup. If automatic cleanup fails,
replace `<printed-project-name>` with the exact identifier shown near the start of the run:

```bash
docker compose --project-name <printed-project-name> --profile object-storage down --volumes --remove-orphans
```

That command deletes only the named disposable acceptance project's containers, network, and
volumes. Do not substitute another Compose project name.

## What the result cannot claim

A green run proves the bounded retained graph and its declared failure boundaries on one local
runtime. It does not prove that an agent's instruction or answer is true, that a model judge is
objective, that one candidate should be released, or that a business policy is correct. The
fixtures, model provider, and reviewers are deterministic and synthetic; no live provider or
external tool is contacted.

It also does not prove production identity deployment, arbitrary provider compatibility,
production key management, browser behavior, coordinated empty-target recovery, RPO/RTO,
high availability, causal improvement, legal compliance, or release authorization. Those remain
separate roadmap and audit gates. Search or retrieval may help discover criteria, but neither this
test nor ProofStack treats search rank or generated text as decision authority.
