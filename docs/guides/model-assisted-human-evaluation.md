# Model-assisted and human evaluation control flow

[English](model-assisted-human-evaluation.md) |
[한국어](model-assisted-human-evaluation.ko.md)

- Status: experimental Workflow 1 reference flow
- Production readiness: not approved
- Live model provider: not included
- Baseline/candidate product comparison, policy, approval, and release: not included

This reference exercises ProofStack's model-assisted and accountable-human-review boundary without
trusting a model response, a reviewer account, or a requester-authored standard as truth. It
materializes an intentionally adversarial assurance graph through the exact API, TypeScript SDK,
dedicated workers, least-privilege PostgreSQL roles, RLS, append-only lineage, outbox, recovery, and
API-restart boundaries.

The final assessment is deliberately `ineligible`. The flow preserves incompatible calibration,
prompt-injection and forged-citation qualification failures, a blinded order reversal, a critic
that shares material provider lineage, applicable critical non-model counterevidence, and
supporting, opposing, and recused human reviews. No majority vote can erase those facts.

## What the flow proves

The executable graph covers all 13 model-assurance record kinds:

1. exact model-evaluator profile and qualification suite;
2. model-assisted evaluator definition and qualification reports;
3. calibration report and blinded evaluation plan/results;
4. independence declarations and an independent-critique record;
5. human-review protocol, reviewer-independence declarations, and review records; and
6. a model-assurance assessment bound to the existing non-model assessment.

Every reference carries an immutable identifier and semantic digest. Server-authored receipts are
removed from definitions and recreated by the responsible use case. The SDK strictly parses every
response and recomputes every digest. After the API is stopped and restarted, the integration test
reads every evaluation and model-assurance record again and requires identical digests.

The local provider harness records one bounded request and response without network access. A
model-returned tool request remains inert data and is never executed. A second attempt records the
typed `provider_unavailable` failure. This verifies the adapter contract and failure semantics; it
does not claim compatibility with a paid or live model provider.

## Independent authority backstops

Authorization and database authority are separate controls:

```text
management principal -> API -> proofstack_api
  profiles, suites, plans, calibration, independence, protocols, final assessment

restricted service principal -> model worker -> proofstack_model_evaluation_worker
  qualification reports, blinded results, independent critique

authenticated reviewer -> API -> proofstack_human_reviewer
  human-review records only
```

`AuthoritySplitModelAssuranceRepository` routes each write kind to the matching repository while
using one least-privilege read path. HTTP capabilities still decide whether the authenticated
principal may call an operation. PostgreSQL independently prevents the control role from forging
model or human evidence, the model worker from publishing control or review records, and the human
reviewer from publishing assessments. None of these authorities can write policy, approval, or
release records because those records do not exist in this checkpoint.

## Run the service-backed test locally

Requirements are Node.js 24 or newer, pnpm 11 or newer, Docker with Compose, and an isolated local
PostgreSQL database. The test applies all current migrations, creates temporary randomized runtime
roles, and drops those roles afterward. Never point it at a shared or production database.

```bash
set -a
source config/postgres.env.example
set +a

pnpm install --frozen-lockfile
pnpm dev:db:up
export PROOFSTACK_TEST_DATABASE_URL="$PROOFSTACK_MIGRATION_DATABASE_URL"
pnpm --filter @proofstack/example-model-assurance-control-flow test:integration
pnpm dev:db:down
```

The harness starts its own ephemeral loopback API listeners and dedicated evaluation workers. It
does not leave an HTTP server or worker loop running after the test. The repository-wide
PostgreSQL gate runs the same test with all existing persistence suites:

```bash
pnpm test:integration:postgres
```

Unit-level scenario and contract checks remain available without PostgreSQL:

```bash
pnpm --filter @proofstack/example-model-assurance-control-flow test
```

## Expected fail-closed conclusion

The exact IDs and digests vary with the random test namespace. These conclusions are stable:

```json
{
  "assessment": {
    "eligibility": "ineligible",
    "reasons": [
      "base_assessment_ineligible",
      "calibration_unavailable",
      "critical_counterevidence",
      "human_review_conflicted",
      "independence_correlated",
      "injection_qualification_failed",
      "model_qualification_unqualified",
      "order_sensitive_result"
    ]
  },
  "localProvider": {
    "status": "completed",
    "failureCode": "provider_unavailable",
    "recordedToolRequestCount": 1
  },
  "safeguards": {
    "calibrationStatus": "unavailable",
    "criticIndependence": "correlated",
    "humanActions": ["oppose", "recuse", "support", "support"],
    "qualificationStatus": "unqualified",
    "reversalStatus": "disagreement"
  }
}
```

An `eligible` result would mean only that the recorded evidence met the declared assessment
usability conditions. It would not establish source truth, reviewer expertise, production model
fitness, policy compliance, approval, or release authorization.

## Failure behavior

The flow stops rather than weakening evidence when:

- an exact dependency is absent, out of scope, stale, or bound to a different digest;
- a record contains unknown fields, caller-authored receipts, invalid time ordering, or an
  incompatible scope;
- the authenticated principal lacks the required capability or the selected DB authority cannot
  execute the matching stored function;
- model qualification, calibration compatibility, independence, blinding, critique, or review
  requirements are missing;
- critical non-model counterevidence or dissent would be lost;
- a provider request, response, tool request, failure, or budget violates the bounded contract;
- an immutable ID is reused for different semantics; or
- API restart read-back changes any record identity or digest.

Mutations are never retried speculatively. Identical retries are safe because PostgreSQL binds each
kind and ID to one immutable definition and atomic outbox intent.

## Honest limits and next checkpoint

The scenario, provider output, reviewers, credentials, artifacts, and evidence are synthetic. The
local provider is deterministic test infrastructure, not an isolated live inference service. The
model worker has a separate process and DB role but no OS/container sandbox. ProofStack validates
declared reviewer identity, scope, protocol, relationships, and record structure; it cannot infer
expertise, honesty, organizational independence, or the correct business objective.

The platform still does not discover authoritative criteria automatically. Search or retrieval
may propose sources and counterevidence, but a result becomes usable only after retained bytes,
exact provenance, freshness, scope, conflicts, and accountable review are recorded. Inadequate
criteria remain `unverifiable` or require approval; they are not silently accepted.

The next Workflow 1 checkpoint is an exact baseline/candidate comparison API and operator view.
Only after that checkpoint may the independent end-to-end Workflow 1 audit begin. Workflow 2
policy and release authority remain blocked until Workflow 1 exits.
