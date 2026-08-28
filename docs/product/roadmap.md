# Capability roadmap

Status: working sequence  
Last reviewed: 2026-08-28

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

The foundation is not a production release. Production identity, artifact retention, backup, and
release enforcement remain explicitly unsupported.

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
7. [ ] Backup, restore, migration rollback, and cross-tenant adversarial test suites.

The evidence for items 1–3 and the limitations that keep this foundation active are recorded in the
[durable core audit](../development/foundation-2-durable-core-audit.md).
The identity checkpoint and limitations that prevent a production-readiness claim are recorded in
the [identity audit](../development/foundation-2-identity-audit.md).
The encrypted artifact lifecycle, real-adapter acceptance, and remaining API, key-provider,
scheduling, and recovery limits are recorded in the
[artifact audit](../development/foundation-2-artifact-audit.md).
The bounded OTLP/HTTP profile, independent exporter compatibility, durable authenticated path, and
remaining production limits are recorded in the
[OTLP/HTTP audit](../development/foundation-2-otlp-audit.md).

Exit requires an installation that survives restart, proves tenant isolation at the database
boundary, and can restore its authoritative state from documented backups.

## Workflow 1: incident-to-regression loop

Goal: turn a failed production trace into repeatable evidence.

- Immutable dataset and fixture versions.
- Tool and model interaction capture with classified artifact references.
- Deterministic stubs plus declared live-provider replay modes.
- Replay budgets, cancellation, retry, and provenance.
- Evaluator SDK with deterministic, statistical, and model-assisted evaluators.
- Score confidence, evaluator version, input lineage, and disagreement inspection.
- Diff view for baseline versus candidate traces, costs, latency, policy events, and artifacts.

No single model-judge score is sufficient evidence for a high-impact decision.

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
