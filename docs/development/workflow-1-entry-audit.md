# Workflow 1 entry audit

Status: accepted for implementation entry; no Workflow 1 checkpoint is complete
Reviewed: 2026-08-29
Scope: incident-to-regression architecture, dependency order, trust boundary, and first vertical
slice
Production readiness: not approved

## Decision

ProofStack may begin Workflow 1 from the accepted Foundation 2 boundary. The first implementation
checkpoint is an end-to-end catalog of immutable, evidence-only trace snapshots and dataset
versions. Replay workers, evaluator scores, and a comparison UI must not precede that catalog or
represent it as executable.

Three independent read-only reviews examined the existing contracts, evidence semantics, package
boundaries, identity capabilities, PostgreSQL migrations and roles, row-level security, outbox,
recovery rehearsal, API composition, public claims, evaluator trust, and primary standards or
research. Their central conclusions agreed:

1. A live trace identifier is not an immutable fixture because valid events can arrive later.
2. Existing traces do not contain a complete executable model and tool transcript.
3. New tenant state must join isolation, least-privilege, migration, outbox, and recovery gates at
   the same checkpoint.
4. Criteria, search results, evaluator code, model judges, and human reviews are independently
   fallible evidence rather than ground truth.
5. Workflow 1 produces replay and assessment evidence; Workflow 2 alone applies release policy.

The accepted boundaries are recorded in:

- [ADR-0012](../architecture/0012-immutable-regression-versions.md) for exact trace snapshots and
  immutable regression versions;
- [ADR-0013](../architecture/0013-bounded-replay-execution.md) for explicit replay modes, budgets,
  cancellation, leases, retries, side effects, and provenance; and
- [ADR-0014](../architecture/0014-contestable-evaluation-assurance.md) for source qualification,
  criteria, evaluator assurance, calibration, independence, disagreement, and assessment
  eligibility.

These ADRs approve dependency boundaries, not implemented capabilities.

## Verified starting boundary

- Evidence is strict, bounded, tenant-scoped, append-only, conflict-detecting, and available
  through identical memory and PostgreSQL repository behavior.
- Trace reads are bounded live keyset views in canonical order; they are not database snapshots or
  execution-completeness attestations.
- OTLP normalization intentionally does not convert prompt, message, tool-argument, or tool-result
  content into executable commands.
- Classified artifacts have encrypted storage, digest checks, authorization, tombstones, purge
  receipts, and a coordinated recovery path, but no fixture retention pin and no public artifact
  capture or read API.
- PostgreSQL migrations are immutable and checksum-bound. Every new tenant table is discovered by
  the forced-RLS matrix and must have representative state in coordinated recovery.
- The API owns one backend lifecycle. A dataset implementation cannot create a divergent hidden
  connection pool or bypass framework-independent use cases.
- Foundation 2's final baseline passed quality, production dependency audit, PostgreSQL,
  S3-compatible, artifact lifecycle, recovery, secret-scanning, and CodeQL checks.

No fixture, dataset, replay, evaluator, assessment, or baseline/candidate comparison domain exists
at this boundary. Existing evaluation capability names and telemetry kinds do not count as those
implementations.

## Dependency-ordered checkpoints

### 1. Immutable evidence-only regression inputs

Implement strict fixture and dataset contracts, domain-owned repositories and use cases, fixed
integrity encodings and vectors, exact trace snapshot capture, identity capabilities, memory and
PostgreSQL conformance, forced RLS, atomic outbox publication, API and SDK operations, recovery,
and operator documentation.

The initial fixture must report `sourceCompleteness: "observed_snapshot"` and
`replayability: "evidence_only"`. No mutable latest alias is accepted as execution lineage.

### 2. Retention-safe classified interaction capture

Capture exact model requests and responses, prompt and tool-contract versions, tool arguments and
results, provider settings, and classified content references. Prove redaction, authorization,
retention, purge, export, and recovery behavior. An executable fixture requires either a tested
retention pin or a fixture-owned immutable artifact copy.

### 3. Exact recorded-boundary replay

Run a target adapter only with interaction-complete fixtures. Require exact normalized request
matching, disable network fallback, record mismatches, control time and randomness where claimed,
and publish reproducibility reasons. Evidence-only fixtures must fail before execution.

### 4. Durable bounded replay jobs

Add exact plan lineage, multidimensional budgets, leases and fencing, cancellation,
predeclared retries, immutable attempts, side-effect classification, usage reconciliation, and
declared simulation or live-provider modes. Exercise crash, lease-expiry, timeout, late-response,
and cancellation races.

### 5. Deterministic and statistical evaluators

Version sources, criterion sets, applicability, oracles, evaluator implementations, raw
observations, qualification reports, intervals, sample counts, abstentions, errors, coverage, and
assessments. Begin with inspectable executable oracles and statistical aggregation.

### 6. Qualified model-assisted evaluation

Add model and prompt lineage, calibration tied to exact slices, independence groups, blinded and
order-swapped comparisons, prompt-injection and bias fixtures, counteranalysis, disagreement,
out-of-distribution abstention, and human review. A single model judge never qualifies a
high-impact assessment.

### 7. Baseline and candidate comparison

Expose exact-version APIs and an operator view for trace structure, evaluator distributions,
cost, latency, policy-independent safety events, artifacts, uncertainty, coverage,
counterevidence, and disagreement. The UI renders source-backed state and cannot invent a release
decision.

### 8. Independent Workflow 1 acceptance

Run the reference incident-to-regression flow from an authenticated captured failure through a
new candidate assessment. Independently audit correctness, usability, open-source contribution,
security, tenant isolation, retention, recovery, failure modes, and public claims. Workflow 2
remains blocked until findings are closed and this checkpoint is accepted.

## First checkpoint acceptance matrix

The first roadmap checkbox stays open until all of these gates are executable:

| Boundary | Required evidence |
| --- | --- |
| Contract | Strict schemas reject unknown fields, unsafe text, duplicate members, over-limit snapshots, and caller-owned server fields; publish bodies cannot supply route-owned logical identifiers |
| Integrity | Published fixed vectors prove domain separation, exact field and predecessor coverage, Unicode rules, optional markers, event and membership ordering, and digest sensitivity |
| Authorization | Management and read capabilities are distinct; checks occur before storage access; cross-tenant, project, and environment identifiers do not leak |
| Snapshot | One bounded trace read resolves and verifies canonical evidence order before freezing exact observed event IDs; the contract preserves that order; later events do not change the version; a new version captures the advanced view |
| Idempotency | Identical version retry returns original provenance; different semantics under the same version identifier conflict |
| Dataset | Every exact fixture version is resolved in scope and its authoritative digest is stored; duplicate logical fixtures and missing lineage fail |
| Domain | One repository conformance suite runs unchanged against memory and PostgreSQL adapters |
| Transaction | Logical resource, version, ordered membership, and one outbox intent commit atomically |
| Database | Every new tenant table has scope-preserving keys, forced RLS, append-only enforcement, no public DML, and least-privilege grants |
| API and SDK | Exact-version create/read operations, stable problems, OpenAPI parity, request identifiers, failure behavior, and restart persistence pass |
| Recovery | Representative regression catalog rows, membership order, digests, and outbox state survive the coordinated empty-target restore |
| Evolution | Clean install, upgrade, migration checksum, unknown-newer-ledger, and older-binary rollback barriers pass |
| Repository | Formatting, boundaries, docs, lint, strict types, coverage, builds, dependency audit, secret scan, CodeQL, PostgreSQL, artifact, S3, and recovery gates remain green |

Schema-only placeholders, memory-only behavior, a polished UI, or green unit tests without the
tenant and recovery matrices do not complete this checkpoint.

## Cross-check findings closed by design

| Risk found at entry | Required resolution |
| --- | --- |
| A trace alias can advance after review | Store the exact bounded event sequence in a new immutable fixture version |
| Telemetry can be mistaken for executable instructions | Initial fixtures are evidence-only; executable capture has a separate contract and gate |
| A fixture may point at expired or purged content | Do not claim replayability until retention-safe artifact ownership is implemented |
| Ordinary JSON hashes can drift | Use versioned, fixed-order, length-prefixed encodings with public vectors |
| A mutable latest alias can corrupt lineage | Require exact IDs and digests for all replay, evaluation, export, and release inputs |
| A new table can bypass existing security or recovery checks | Add it simultaneously to capabilities, roles, RLS, conformance, migration, outbox, and restore matrices |
| Search ranking can become accidental authority | Preserve search as discovery provenance and qualify the underlying primary source |
| The criterion author can define a wrong success condition | Preserve applicability, assumptions, counterevidence, qualification, independent review, and version history |
| Correlated model judges can imitate consensus | Record independence groups and require non-model evidence for high-impact eligibility |
| A score can hide abstention or failed coverage | Preserve five-state verdicts, all attempts, coverage, intervals, calibration lineage, and disagreement |
| Evaluation can accidentally approve its own release | Keep assessment eligibility and Workflow 2 release decisions in different contracts and authorities |

## Entry limitations

- This audit does not make any Workflow 1 feature available.
- The first checkpoint freezes observed evidence lineage but does not sign event payloads or prove
  global trace completeness.
- No prompt, tool, provider, or model interaction is executable yet.
- No worker sandbox, distributed quota, provider compatibility matrix, evaluator SDK,
  qualification corpus, calibration report, diff view, or release gate exists.
- Business purpose and risk tolerance still require accountable human authority. ProofStack makes
  that authority inspectable; it cannot derive the one correct policy from the internet.
- Production readiness remains blocked by this work and the later Workflow 2 acceptance gates.

## Immediate implementation order

1. Add least-privilege dataset capabilities and migration-safe capability validation.
2. Publish strict fixture and dataset contracts plus fixed digest semantics.
3. Add the exact trace snapshot port and domain package with memory conformance.
4. Persist the catalog atomically with outbox intent and forced RLS.
5. Extend recovery before exposing the durable path publicly.
6. Add exact-version API, SDK, OpenAPI, documentation, and the reference flow.
7. Run independent acceptance and close findings before checking roadmap item 1.

Each coherent change receives its own English commit and must leave its applicable local gates
green before it is pushed. GitHub CI remains authoritative for the external runner and service
matrix.
