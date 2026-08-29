# Workflow 1 regression catalog audit

[English](workflow-1-regression-catalog-audit.md) |
[한국어](workflow-1-regression-catalog-audit.ko.md)

Status: first Workflow 1 checkpoint accepted  
Reviewed: 2026-08-29  
Implementation scope: `a900fe9` through `bb82311`  
Production readiness: not approved  
Workflow 1 exit: not approved

## Decision

The first Workflow 1 roadmap item is accepted. ProofStack now implements one end-to-end catalog of
immutable, evidence-only trace snapshots and ordered regression dataset versions through strict
contracts, memory and PostgreSQL repositories, authenticated use cases, exact-version API and SDK
operations, OpenAPI, atomic outbox publication, tenant isolation, coordinated recovery, and an
executable reference flow.

This decision accepts a versioned evidence catalog, not executable replay. Every current fixture
remains `sourceCompleteness: "observed_snapshot"` and `replayability: "evidence_only"`. No model
request, tool call, provider response, artifact payload, evaluator result, comparison, or release
decision can be executed or inferred from this checkpoint.

## Acceptance evidence

| Boundary | Executable evidence | Result |
| --- | --- | --- |
| Contract | Strict [dataset schemas](../../packages/contracts/src/dataset.ts) and contract tests reject unknown fields, duplicate or empty membership, invalid server-owned fields, and bounds violations | Accepted |
| Integrity | [Fixed public digest vectors](../../packages/datasets/src/regression-definition-digest.test.ts) cover domain separation, exact fields, predecessor lineage, Unicode, option markers, event order, dataset order, and size boundaries | Accepted |
| Authorization | [Publication use cases](../../packages/datasets/src/publish-regression-fixture-version.test.ts), [exact reads](../../packages/datasets/src/read-regression-fixture-version.test.ts), route tests, workload delegation schemas, and OpenAPI keep `dataset:manage`, `dataset:read`, and `evidence:read` distinct | Accepted |
| Snapshot | The [memory publication flow](../../packages/datasets/src/regression-publication-flow.test.ts) proves one bounded canonical observation, immutable event order, later-event non-mutation, and explicit successor versions | Accepted |
| Idempotency and lineage | Fixture and dataset use-case suites prove original-provenance retry, conflicting target refusal, exact predecessor binding, and scope-safe missing lineage | Accepted |
| Domain adapters | One [repository conformance suite](../../packages/datasets/src/testing/regression-version-repository-conformance.ts) runs against both memory and PostgreSQL adapters | Accepted |
| Transaction | PostgreSQL repository tests and the [regression catalog migration](../../packages/postgres/src/regression-catalog-migration.integration.test.ts) prove atomic roots, versions, ordered membership, one canonical outbox intent, rollback, forced RLS, and append-only enforcement | Accepted |
| API and SDK | [Route tests](../../apps/api/src/regression-routes.test.ts), [PostgreSQL API restart integration](../../apps/api/src/postgres.integration.test.ts), OpenAPI tests, and the [fail-closed SDK suite](../../sdks/typescript/src/regression-client.test.ts) prove create/read parity, stable problems, request IDs, bounded failure, explicit authentication modes, and restart persistence | Accepted |
| Recovery | The [coordinated recovery rehearsal](../../services/recovery/src/postgres-recovery.integration.test.ts) restores fixture roots and descendants, ordered event and dataset membership, digests, provenance, outbox state, fresh roles, and post-restore tenant isolation | Accepted |
| Evolution | Migration runner, clean-install, upgrade, checksum, unknown-ledger, rollback-barrier, and older-prefix tests include the regression catalog migration | Accepted |
| Usability | The [executable reference](../../examples/incident-to-regression/src/run.ts) and [operator guide](../guides/incident-to-regression.md) run failure ingestion through exact fixture and dataset readback without claiming replay | Accepted |
| Repository gates | Frozen install, formatting, dependency boundaries, documentation links, lint, strict types, unit coverage, production builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, and recovery jobs remained green | Accepted |

The cumulative code and example commit `2f20274` passed every job in
[CI run 33228500186](https://github.com/Kwondh0321/proofstack/actions/runs/33228500186):
quality gates, PostgreSQL integration, recovery integration, S3-compatible integration, artifact
lifecycle integration, and secret scanning. It also passed
[Security run 33228500173](https://github.com/Kwondh0321/proofstack/actions/runs/33228500173),
including CodeQL. Later documentation-only and install-metadata commits preserved the same source
behavior and were rechecked before this acceptance.

## Cross-check findings closed

1. **Exact reads were absent.** Added domain-owned, authorized exact fixture and dataset read use
   cases, strict response schemas, API routes, OpenAPI operations, and SDK methods.
2. **API storage initially composed only evidence.** Memory and PostgreSQL regression repositories
   now share the API-owned backend lifecycle, readiness, and shutdown path.
3. **The durable public path lacked restart proof.** Added a PostgreSQL-backed API test covering
   failed evidence ingestion, new fixture publication, identical retry, dataset publication, pool
   shutdown, API restart, and exact readback.
4. **Management authentication was described too broadly.** OpenAPI now exposes fixture and
   dataset publication plus workload credential administration as browser-session management
   surfaces. Non-delegable `dataset:manage` and `identity:manage` remain unavailable to workload
   keys.
5. **The SDK authentication shape contradicted that authority.** The regression client now
   requires an explicit browser, workload, or loopback-development mode. Browser publication sends
   cookies and CSRF; workload keys are rejected locally for publication and remain usable for
   exact reads.
6. **Unit tests did not demonstrate contributor usability.** Added and directly executed the
   incident-to-regression example against the real local API, verifying HTTP create/read behavior,
   exact definition digests, observed snapshot semantics, and the evidence-only warning.
7. **A clean install emitted an avoidable workspace-bin warning.** Removed an unused private bin
   declaration whose generated target did not exist until build; documented package scripts remain
   the supported database CLI entry points.

No unresolved finding in this audit invalidates the first checkpoint. The local host did not have
Docker or PostgreSQL available, so service-backed acceptance was not guessed from local unit tests:
the pinned GitHub PostgreSQL and recovery jobs were inspected individually and used as the
authoritative service evidence.

## Remaining limits and next checkpoints

The following remain open and are not implied by this acceptance:

1. retention-safe classified model and tool interaction capture with immutable artifact ownership;
2. exact recorded-boundary replay with network-denied fallback and reproducibility reasons;
3. durable bounded replay jobs, leases, fencing, cancellation, retries, side-effect controls, and
   usage reconciliation;
4. versioned criteria, deterministic and statistical evaluators, raw observations, intervals,
   abstention, coverage, and assessments;
5. qualified model-assisted evaluation with calibration, independence, injection resistance,
   counterevidence, disagreement, and human review;
6. exact baseline/candidate comparison without an invented release decision; and
7. the independent final Workflow 1 acceptance.

Business purpose, prohibitions, acceptable risk, and release authority still require accountable
human ownership. Later retrieval can discover candidate rules, but search ranking cannot become
authority; source provenance, version, freshness, applicability, conflicts, uncertainty, and
abstention must remain explicit. Workflow 2 release policy stays blocked until every Workflow 1
checkpoint and its independent final audit are accepted.
