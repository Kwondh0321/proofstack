# Service-backed evaluation control flow

[English](evaluation-control-flow.md) | [한국어](evaluation-control-flow.ko.md)

- Status: experimental reference flow
- Production readiness: not approved
- Automatic source authority: not claimed
- Model judge, policy enforcement, and release approval: not included

This example proves that ProofStack can preserve one contested non-model evaluation through its
real HTTP, SDK, worker, PostgreSQL, RLS, lineage, outbox, and restart boundaries. It is deliberately
not a green happy path. The retained evidence contains one pass, one fail, one abstention, one
error, and one non-applicable case. Only two of four applicable cases are decided, so exact
coverage is 50% against a predeclared 75% minimum. One primary-source review is expired and retains
an unresolved critical conflict. The final assessment must therefore remain `inconclusive` and
`ineligible`.

The example does not execute an arbitrary agent, browse the web, retrieve the illustrative
`example.test` sources, or prove that its synthetic artifacts contain real evidence. It exercises
the control and evidence-recording boundary with strict public definitions. Connecting qualified
evaluators, retained source bytes, replay outputs, and operator review is deployment work.

## Authority split

The flow intentionally uses two write paths:

```text
operator development identity -> HTTP API -> proofstack_api role
  definitions, source reviews, lifecycle status, run decisions, assessment

service-token principal -> evaluation worker port -> proofstack_evaluation_worker role
  qualification reports, raw observations, terminal results, aggregate
```

The API cannot execute the worker-only database function. The evaluation-worker role cannot
execute the control-record function or insert directly into evaluation tables. The runner grants
its service principal `evaluation:run` only and restricts it to the selected project and
environment. Neither path accepts a caller-authored semantic digest or server receipt.

After the assessment is written, the runner reads all 30 records back through the public API. The
TypeScript SDK reparses each strict response and independently recomputes its definition digest.
The command fails if any kind, identifier, scope, media type, cache boundary, status code, body
size, or digest contradicts the request.

## Run locally

Requirements are Node.js 24 or newer, pnpm 11 or newer, Docker with Compose, and two terminals.
These credentials and development authentication are loopback-only examples. Never deploy them.

In both terminals, load the durable local profile and the additive evaluation profile:

```bash
set -a
source config/postgres.env.example
source config/evaluation-control-flow.env.example
set +a
```

Prepare current migrations and least-privilege roles once:

```bash
pnpm install --frozen-lockfile
pnpm dev:db:up
pnpm db:migrate
pnpm db:provision
```

Start the API in the first terminal:

```bash
pnpm dev:api
```

Run the bounded flow in the second terminal:

```bash
pnpm example:evaluation-control-flow
```

The runner exits after emitting a JSON summary; it does not leave a worker loop running. Stop the
development API with `Ctrl-C`. Stop local PostgreSQL when it is no longer needed:

```bash
pnpm dev:db:down
```

The default namespace is `reference`. Reusing it exercises authoritative idempotent retries and
returns the original records. To retain a separate immutable graph, set a new lowercase
alphanumeric namespace of at most 20 characters:

```bash
export PROOFSTACK_EVALUATION_EXAMPLE_NAMESPACE=trial2
pnpm example:evaluation-control-flow
```

Do not change a definition while reusing a namespace. Immutable identifier rebinding is rejected
as a conflict.

## Expected summary

The exact digests and identifiers include the selected namespace, but these conclusions are
stable:

```json
{
  "aggregate": {
    "counts": {
      "selectedCount": 5,
      "applicableCount": 4,
      "decidedCount": 2,
      "passCount": 1,
      "failCount": 1,
      "abstainCount": 1,
      "errorCount": 1,
      "notApplicableCount": 1
    },
    "coverage": { "status": "available", "numerator": 2, "denominator": 4 }
  },
  "assessment": {
    "supportStatus": "inconclusive",
    "eligibility": {
      "status": "ineligible",
      "reasons": [
        "critical_counterevidence",
        "human_review_required",
        "insufficient_coverage",
        "source_review_not_current",
        "unresolved_disagreement"
      ]
    }
  },
  "readBack": { "recordCount": 30 }
}
```

This is not a release decision. `eligible` would mean only that the evidence met a declared
assessment usability policy; it would still not authorize production deployment.

## Automated verification

The unit suite materializes the graph through the public core use cases and memory repository. The
integration suite provisions all seven runtime roles against a real PostgreSQL database, starts an
ephemeral API listener, composes the dedicated evaluation worker, runs the flow, restarts the API,
and verifies the exact assessment again:

```bash
pnpm --filter @proofstack/example-evaluation-control-flow test

export PROOFSTACK_TEST_DATABASE_URL="$PROOFSTACK_MIGRATION_DATABASE_URL"
pnpm --filter @proofstack/example-evaluation-control-flow test:integration
```

The repository-wide PostgreSQL gate includes this example:

```bash
pnpm test:integration:postgres
```

Integration tests create temporary randomized roles and remove them on completion. Use only an
isolated test database; the suite applies all pending ProofStack migrations.

## Fail-closed behavior

The runner refuses to proceed when:

- the evaluation-worker database URL is absent, malformed, uses the wrong role, or violates the
  deployment TLS policy;
- migrations are missing or their ledger checksums disagree with the bundled release;
- the API endpoint is not HTTPS or explicit loopback HTTP;
- a namespace, project, environment, request, response, or record violates its strict contract;
- an exact dependency is missing, out of scope, or bound to a different digest;
- a server response omits `no-store`, exceeds the byte limit, redirects, or changes identity;
- the worker loses an idle database connection; or
- read-back after persistence does not reproduce all authoritative definitions.

The runner never retries mutations automatically. Re-running the same namespace is safe because
the repositories implement exact idempotency, not because the client guesses which failures are
retryable.

## What remains

This reference closes the service-backed entry slice, not the evaluation roadmap. Remaining work
includes independently reviewed real source ingestion, evaluator execution isolation, richer
qualification and calibration, model-assisted and human-review records, blinded comparison,
policy decisions, release approval, console workflows, scheduled deployments, and an independent
checkpoint acceptance audit. See the
[criteria and non-model evaluation entry audit](../development/workflow-1-criteria-evaluation-entry-audit.md).
