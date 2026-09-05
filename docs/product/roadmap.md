# Capability roadmap

Status: working sequence  
Last reviewed: 2026-09-02

This roadmap is ordered by dependency and risk, not calendar promises. A later capability must not
pull an earlier one into production before its acceptance gates pass.

## Foundation 1: trustworthy skeleton

Goal: prove that one provider-neutral evidence contract can cross an SDK, authenticated use case,
repository port, HTTP boundary, and operator surface without pretending future systems exist.

Exit criteria:

- [x] Product constitution and architecture decision process.
- [x] Strict, versioned `EvidenceEnvelope` with bounded metadata and content references.
- [x] Explicit principal context and tenant-scoped authorization in the domain layer.
- [x] Idempotent, atomic in-memory evidence repository.
- [x] Direct JSON ingestion and trace query endpoints with stable problem documents.
- [x] Fail-open, bounded TypeScript SDK with a fail-closed option.
- [x] Operator console that renders only API-backed state.
- [x] Machine-readable OpenAPI contract derived from runtime schemas.
- [x] Reproducible monorepo checks, dependency audit, and secret scanning in CI.
- [x] Threat model, contribution workflow, and runnable end-to-end example.
- [x] Final clean-checkout rehearsal on the CI baseline runtime.
- [x] Independent cross-layer audit with closed findings and explicit next-stage entry rules.

At this checkpoint the foundation was not a production release. The later Foundation 2 work adds
bounded identity, artifact, and reference recovery behavior without changing that production
readiness boundary.

The completed review and accepted limitations are recorded in the
[Foundation 1 audit](../development/foundation-1-audit.md).

## Foundation 2: durable evidence boundary

Goal: replace process-local assumptions without changing the public evidence meaning.

Ordered work:

1. [x] PostgreSQL migrations, tenant-bearing keys, append-only evidence table, and transactional
   idempotency constraints.
2. [x] Repository contract tests that run unchanged against memory and PostgreSQL adapters.
3. [x] Transactional outbox, projection cursor, retry state, and idempotent consumer harness.
4. [x] OIDC browser identity and capability-scoped workload API keys with rotation and revocation.
5. [x] Encrypted artifact interface for opt-in content, redaction metadata, and retention tombstones.
6. [x] OTLP/HTTP adapter and compatibility fixtures mapped into `EvidenceEnvelope`.
7. [x] Backup, restore, migration rollback, and cross-tenant adversarial test suites.

The evidence for items 1–3 and their checkpoint limitations are recorded in the
[durable core audit](../development/foundation-2-durable-core-audit.md).
The identity checkpoint and limitations that prevent a production-readiness claim are recorded in
the [identity audit](../development/foundation-2-identity-audit.md).
The encrypted artifact lifecycle, real-adapter acceptance, and remaining API, key-provider, and
scheduling limits are recorded in the
[artifact audit](../development/foundation-2-artifact-audit.md).
The bounded OTLP/HTTP profile, independent exporter compatibility, durable authenticated path, and
remaining production limits are recorded in the
[OTLP/HTTP audit](../development/foundation-2-otlp-audit.md).
The coordinated authority set, empty-target restore, migration barrier, tenant adversarial matrix,
and stage exit review are recorded in the
[recovery and isolation audit](../development/foundation-2-recovery-audit.md).

Foundation 2 exit is accepted: the reference installation survives restart, proves tenant
isolation at the database boundary, and restores its authoritative state through the documented
coordinated procedure. This is a stage acceptance, not a production disaster-recovery, RPO, RTO,
or provider-compatibility claim.

## Workflow 1: incident-to-regression loop

Goal: turn a failed production trace into repeatable evidence.

- [x] Immutable evidence-only trace snapshots and dataset versions through memory, PostgreSQL,
  API, SDK, tenant-isolation, outbox, and coordinated-recovery boundaries.
- [x] Retention-safe classified model and tool interaction capture with exact prompt, provider,
  tool-contract, request, response, and artifact lineage.
- [x] Exact recorded-boundary replay with request matching, network-denied fallback, controlled
  runtime inputs, and honest reproducibility classification.
- [x] Durable replay jobs with multidimensional budgets, cancellation, fenced leases,
  predeclared retries, side-effect controls, usage reconciliation, and declared simulation or
  live-provider modes.
- [x] Versioned sources, criteria, deterministic oracles, statistical evaluators, raw
  observations, qualification, intervals, abstention, errors, coverage, and assessments.
- [x] Qualified model-assisted evaluators with exact model and prompt lineage, calibration,
  independence groups, blinded order swaps, injection tests, counterevidence, disagreement, and
  human review.
- [x] Exact baseline and candidate diff API and operator view for traces, distributions, cost,
  latency, policy-independent safety events, artifacts, uncertainty, and coverage.
- [ ] Independent end-to-end Workflow 1 audit covering correctness, usability, open-source
  contribution, security, isolation, retention, recovery, failure modes, and public claims.

No single model-judge score is sufficient evidence for a high-impact decision.

The dependency boundary, risks, and executable gates for these checkpoints are recorded in the
[Workflow 1 entry audit](../development/workflow-1-entry-audit.md) and
[ADRs 0012–0014](../architecture/README.md). Workflow 2 remains blocked until the final Workflow 1
audit is accepted.

The evidence and remaining limits for the first completed checkpoint are recorded in the
[regression catalog audit](../development/workflow-1-regression-catalog-audit.md).
The second checkpoint's classified content, ownership, export, revocation, interoperability,
recovery, and explicit non-replay evidence are recorded in the
[interaction-capture audit](../development/workflow-1-interaction-capture-audit.md).
The exact matching, preflight, fallback, runtime-control, and reproducibility gates for the open
third checkpoint are fixed by the
[recorded-boundary replay entry audit](../development/workflow-1-recorded-replay-entry-audit.md).
The third checkpoint's exact boundary evidence, explicit same-process limits, adversarial matrix,
and remaining durable-job boundary are recorded in the
[recorded-boundary replay audit](../development/workflow-1-recorded-replay-audit.md).
The durable-job checkpoint's exact releases, budgets, fencing, cancellation, retry, worker,
authority, persistence, recovery, and acceptance gates are fixed by the
[durable replay-job entry audit](../development/workflow-1-durable-replay-entry-audit.md).
The completed [durable replay-job audit](../development/workflow-1-durable-replay-audit.md) records
the accepted bounded execution boundary, service-backed evidence, restore-epoch fencing, closed
cross-check findings, and the evaluator and production limits that remain open.
The source-authority, criteria, safe-applicability, deterministic-oracle, statistical-evaluation,
qualification, observation, assessment, persistence, and acceptance gates for the fifth
checkpoint are fixed by the
[criteria and non-model evaluation entry audit](../development/workflow-1-criteria-evaluation-entry-audit.md).
The completed
[criteria and non-model evaluation audit](../development/workflow-1-criteria-evaluation-audit.md)
records the accepted immutable evaluation evidence and eligibility boundary, closed cross-check
findings, and the model-assisted, comparison, policy, and release limits that remain open.
The model lineage, qualification, calibration, independence, blinding, injection, critique, human
review, authority, persistence, recovery, and acceptance gates for the sixth checkpoint are fixed
by the
[model-assisted and human evaluation entry audit](../development/workflow-1-model-human-evaluation-entry-audit.md).
The completed
[model-assisted and human evaluation audit](../development/workflow-1-model-human-evaluation-audit.md)
accepts the contestable model-and-human assurance boundary and records the synthetic-provider,
reviewer, isolation, comparison, policy, release, and production limits that remain open.
The exact subjects, pairing, missingness, distributions, usage, artifact, safety-event,
comparability, API, operator-view, authority, persistence, recovery, and acceptance gates for the
seventh checkpoint were fixed by the
[baseline and candidate comparison entry audit](../development/workflow-1-baseline-candidate-comparison-entry-audit.md)
and [ADR-0020](../architecture/0020-exact-evidence-comparison.md).
The completed
[baseline and candidate comparison audit](../development/workflow-1-baseline-candidate-comparison-audit.md)
accepts the immutable policy-independent descriptive comparison boundary and records the synthetic
evidence, criteria-authority, statistical, operator-surface, policy, release, and production limits
that remain open.
The complete-lineage, production-composition, criteria-trust, authority, retention, isolation,
recovery, failure-mode, usability, open-source, and acceptance gates for the final open checkpoint
are fixed by the
[Workflow 1 exit entry audit](../development/workflow-1-exit-entry-audit.md).

## Workflow 2: reliability release gate

Goal: make regression evidence enforceable in delivery pipelines.

- Versioned policy model with advisory and mandatory modes.
- Candidate release entity linking code, prompts, tools, models, datasets, and evaluations.
- Statistical comparison with explicit thresholds and guardrails.
- Human approval records for high-impact exceptions.
- GitHub check and generic CI webhook integrations.
- Signed decision artifact, immutable audit trail, rollback target, and break-glass procedure.

The policy service fails closed only for policies explicitly configured as mandatory. Its
availability and latency targets must be measured before inline runtime enforcement is offered.

## Scale and ecosystem

These capabilities earn implementation only after the reference workflow produces measurements:

- ClickHouse trace projection and query planner.
- Kafka-compatible durable fan-out and replay.
- Distributed quotas and rate limiting.
- Regional ingestion and tenant data residency.
- Python evaluation SDK and framework adapters.
- Go or Rust ingestion components when profiling proves a TypeScript bottleneck.
- Plugin sandbox, integration marketplace, and managed connector lifecycle.
- Enterprise SSO, SCIM, tenant-managed encryption keys, legal hold, and compliance evidence export.

## Product surfaces enabled by the platform

The same evidence foundation can support several businesses without splitting the core product:

- Reliability cloud priced by retained evidence and evaluation compute.
- Self-hosted platform with enterprise identity, governance, and support.
- CI release-gate product for teams that already have tracing.
- Incident replay and regression service for high-value agents.
- Independent reliability benchmark and certification reports backed by exportable evidence.
- Privacy-safe observability gateway that redacts and normalizes before third-party export.

Commercial packaging must not create proprietary telemetry captivity. Raw evidence, normalized
records, evaluation results, and policy decisions remain exportable through documented contracts.

## Sequencing rule

A capability advances only when its prerequisite invariants are executable tests. UI mockups,
schema-only placeholders, and unmeasured service boundaries do not count as completed platform
capabilities.
