# Workflow 1 criteria and non-model evaluation entry audit

[English](workflow-1-criteria-evaluation-entry-audit.md) |
[한국어](workflow-1-criteria-evaluation-entry-audit.ko.md)

- Status: accepted for implementation entry; checkpoint remains open
- Reviewed: 2026-09-01
- Dependency: accepted durable replay checkpoint at `1635e5d`
- Production readiness: not approved
- Model-assisted evaluation: not included
- Release authority: not included
- Workflow 1 exit: not approved

## Decision

The criteria and non-model evaluation checkpoint may begin. Its dependency is real: ProofStack can
now freeze exact evidence and interaction lineage, execute one exact replay plan as a durable
bounded job, and preserve attempts, budgets, uncertainty, side effects, cancellation, recovery,
and result artifacts. It still cannot determine whether any observed behavior is correct,
representative, authorized, or safe.

This checkpoint adds a contestable assurance graph:

```text
source snapshot + authority review -> criterion -> oracle/evaluator -> raw observations
raw observations + aggregation rule + counterevidence -> assessment eligibility
```

Every arrow names exact immutable versions and digests. No source, criterion author, search rank,
oracle, evaluator, or aggregate score is treated as ground truth. Evaluation produces evidence and
an eligibility statement only. It cannot approve a release, rewrite a replay result, widen an
agent's authority, or silently repair an inadequate task instruction.

The first vertical slice is deliberately non-model: an operator publishes one exact primary-source
snapshot, an independently reviewable applicability record, one immutable criterion set, a
deterministic oracle specification, and a qualified evaluator. An evaluation run reads an exact
terminal replay result, appends raw observations, and creates an assessment with explicit
coverage, uncertainty, conflicts, and eligibility reasons.

## Current dependency evidence

The accepted durable replay checkpoint supplies:

- immutable fixture, dataset, interaction, target-release, replay-plan, job, attempt, and result
  lineage;
- authenticated tenant, project, and environment scope;
- strict artifact references with content digests, authorization, retention, purge, and recovery;
- a separately launched worker with bounded modes, budgets, cancellation, fencing, and immutable
  observations;
- exact success, failure, timeout, cancellation, budget, usage, and effect-uncertainty evidence;
- memory and PostgreSQL repository conventions, forced RLS, atomic outbox publication, migration
  checksums, and coordinated recovery; and
- exact-version API, SDK, OpenAPI, and service-backed example patterns.

Evaluation must reference those authoritative records. It cannot accept a caller-authored replay
status, target output, trace digest, or artifact digest as a substitute.

## Accepted authority and source direction

### Separate discovery, integrity, identity, authority, and applicability

A `DiscoveryRecord` is immutable provenance for finding candidate material. It records the
provider and tool version, exact query, locale, time, filters, complete bounded result list and
rank, and inclusion or exclusion reasons. A search result, snippet, cached answer, generated
summary, or ranking remains an untrusted candidate.

A candidate becomes a `SourceSnapshot` only after ProofStack retrieves the underlying document and
binds exact retained bytes to a SHA-256 digest and classified artifact reference. The snapshot also
records canonical URI, publisher claim, document version, publication, effective, retrieval, and
expiry times, media and source kinds, licensing and retention terms, identity-verification method,
jurisdiction and population scope, supersession links, conflict links, and known limitations.

These are distinct claims:

- byte integrity proves that retained bytes match a digest;
- publisher identity records who issued the bytes and how that identity was checked;
- authority records why that publisher may define evidence for this purpose;
- freshness records whether the exact version remains usable at the evaluation time; and
- applicability records whether an accountable reviewer accepted it for the exact task,
  environment, locale, population, jurisdiction, exclusions, and risk tier.

No one claim implies another. An immutable `SourceReviewRecord` references the exact source digest,
reviewer principal, role, declared relationship or conflict, review basis, authority conclusion,
scope, validity window, conflicts considered, rationale, timestamp, and supersession record. It
cannot edit the source. Missing identity, expired review, unresolved critical conflict, unknown
license, unavailable retained bytes, or scope mismatch yields `unverifiable` or
`require_approval`; it never falls back to a model guess or requester assertion.

The initial implementation does not autonomously browse the web. It accepts exact retained primary
sources and optional discovery provenance. A later connector may broaden discovery, but it cannot
publish, approve, supersede, or select authority without the same review boundary.

### Version criteria as bounded claims

A `CriterionSet` is an immutable tenant-scoped version, informally called a Criteria Pack. It binds
an exact logical set ID and version ID to purpose, intended use, risk tier, task and environment
scope, locale, population, jurisdiction, exclusions, issuer, source snapshots, source reviews,
assumptions, known limitations, change rationale, predecessor or supersession lineage, publisher,
server time, schema version, and semantic definition digest.

Each criterion contains exactly one bounded claim plus:

- severity, metric, direction, unit, threshold, and threshold rationale;
- required evidence classes and independent quorum;
- exact oracle and evaluator references;
- positive, negative, boundary, and not-applicable qualification fixtures; and
- ambiguities, counterexamples, assumptions, counterevidence, and disqualifying conditions.

Semantic changes always create a new version. A mutable `latest`, a URL-only source, executable
criterion text, hidden defaults, prompt instructions, tool commands, or caller-owned approval
fields are rejected. Criterion data can select only prepublished evaluator and oracle versions; it
cannot select a credential, network destination, executable path, platform capability, retry, or
release policy.

Lifecycle is append-only. Separate status records move an exact set through `draft`, `qualified`,
`approved`, `contested`, `superseded`, or `withdrawn` under explicit authority. Status never changes
the set digest. Evaluation may use only a status and validity window declared by the run profile;
high-impact eligibility requires `approved`.

### Evaluate applicability in a safe total language

Applicability is a versioned, non-executable JSON expression. The first language contains only
bounded `allOf`, `anyOf`, `not`, and allowlisted leaf comparisons over typed fields supplied by an
authenticated evaluation context. It has fixed depth, member, string, and collection limits; no
regex, code, templates, arbitrary property paths, I/O, clocks, randomness, or network access.

Evaluation is pure and total and returns exactly `applicable`, `not_applicable`, or
`undetermined`. Missing or unknown context is `undetermined`, not false. A criterion with
`undetermined` applicability cannot run and resolves to `unverifiable` or `require_approval`
according to its predeclared risk profile. The expression and exact context are retained as run
lineage.

## Accepted oracle and evaluator direction

### Prefer inspectable deterministic oracles without calling them truth

An `OracleSpec` is immutable and versioned. This checkpoint supports non-model kinds such as
`exact`, `schema`, `property`, `metamorphic`, `reference_interpreter`, and `reference_label`. It
binds input and output schemas, implementation and runtime digests, source revision, dependencies,
configuration, seed, clock and locale policy, network and side-effect denial, budgets, result
semantics, supported criteria, qualification fixtures, and a separate qualification report.

An oracle cannot execute arbitrary code supplied by criterion data, qualify itself, change the
criterion, or create cyclic support. The first executable reference adapter is a preinstalled,
digest-registered implementation with no network, credentials, shell interpolation, or external
writes. A perfect execution of the wrong requirement remains contestable evidence.

An `EvaluatorSpec` in this checkpoint is `deterministic`, `statistical`, or a non-model
`composite`. It binds exact criteria, oracle versions, implementation and runtime digests,
configuration, output schema, supported scope, budgets, reproducibility class, qualification
report, known limits, and independence group. Model, prompt, provider-judge, free-form rubric, and
human-review execution are rejected until the next checkpoint.

### Qualify before use and keep qualification independent

A `QualificationReport` references one exact oracle or evaluator digest, criterion family,
fixture-set version, executor identity, environment, method, expected labels, raw runs,
measurements, slice results, limitations, validity window, and report digest. It covers positive,
negative, boundary, malformed, not-applicable, timeout, budget, abstention, and error fixtures.

The implementation under test cannot publish its own qualifying status. Qualification fixtures
must be immutable and separate from evaluation inputs, and every failed or excluded fixture
remains visible. A mismatched digest, expired window, unsupported slice, missing required case, or
failed mandatory threshold makes the evaluator unqualified for that run.

This checkpoint does not label raw confidence as probability of correctness. A calibrated
probability remains unavailable unless a later exact calibration report satisfies ADR-0014. The
initial statistical evaluator reports descriptive proportions and a named, versioned interval
method only.

### Preserve attempts and five-state outcomes

An `EvaluationRun` binds exact criterion, source review, applicability result, oracle, evaluator,
qualification report, dataset case, replay job and result, target, environment, executor, and
input-evidence digests. It predeclares finite attempts, seeds, budgets, timeouts, and aggregation.

Every attempt appends a `RawObservation` containing exact input and output digests, structured
measurement, evidence and counterevidence references, started and completed server times, runtime
metadata, budget use, and typed failure reason. Observations never overwrite replay state or one
another. Retry-until-pass is forbidden.

Each run verdict is exactly one of:

- `pass`: the predeclared measurement supports the bounded criterion;
- `fail`: it contradicts the bounded criterion;
- `abstain`: the qualified evaluator intentionally declined within its contract;
- `not_applicable`: the criterion deterministically does not apply; or
- `error`: the evaluation could not produce a valid result.

The latter three are never converted to pass, fail, or zero. An applicability result of
`undetermined` prevents execution rather than becoming `not_applicable`.

### Make statistical denominators explicit

For a bounded collection, ProofStack records all five verdict counts and these separate values:

- `attemptedCount`: every selected case;
- `applicableCount`: pass, fail, abstain, and error cases;
- `decidedCount`: pass and fail cases;
- `coverage`: `decidedCount / applicableCount`, absent when no case is applicable;
- `abstentionRate` and `errorRate`: each over applicable cases; and
- `passProportion`: pass over decided cases, absent when no case is decided.

When configured, the first reference aggregate reports a two-sided Wilson score interval for the
pass proportion with exact integer counts and a predeclared confidence level. It never applies the
interval to abstentions, errors, weighted dependence, or an unrepresentative sample as though they
were independent Bernoulli trials. Unsupported dependence or sampling assumptions are explicit
limitations and can make an assessment inconclusive or ineligible.

## Assessment boundary

An `Assessment` references every relevant run and raw observation, the exact aggregation-policy
digest, evidence classes, independence groups, quorum, counts, distributions, intervals, coverage,
disagreement, minority findings, critical conflicts, assumptions, counterevidence, and exclusions.
Its support status is exactly `supported`, `contradicted`, `inconclusive`, or `invalid`.

Eligibility is separately `eligible` or `ineligible` with machine-readable reasons. Invalid
provenance, unapproved or inapplicable criteria, stale source or qualification review, insufficient
quorum, missing evidence classes, unresolved critical conflicts, unsupported statistical
assumptions, low coverage, excessive abstention or error, or digest mismatch makes the assessment
ineligible. `Eligible` means only that Workflow 2 may later consider it; it is not approval.

High-impact eligibility requires an applicable approved criterion, verified source identity,
current qualification, required independent evidence, at least one non-model evidence path, and an
independent human review. Because human-review records enter in the next checkpoint, every
high-impact assessment created here is explicitly `ineligible` with
`human_review_required`. The platform does not weaken the rule to make the first demo green.

## Authority, persistence, and recovery boundary

Evaluation receives dedicated authority:

- `evaluation:read` reads published definitions, runs, observations, and assessments without
  independently granting classified artifact plaintext;
- `evaluation:run` creates runs only from already published exact versions in the authenticated
  scope; and
- `evaluation:manage` publishes sources, reviews, criteria, oracle and evaluator specs,
  qualification reports, and lifecycle records.

`evaluation:manage` is user-only and not workload-delegable. Existing release, policy, approval,
artifact-plaintext, identity, dataset, and replay management capabilities remain separate. The
evaluation executor uses a service identity and worker-only ports; it cannot publish or approve
its own definitions, manage source authority, create arbitrary replay results, or apply policy.

PostgreSQL adds normalized tenant-bearing tables for discovery records, source snapshots and
reviews, criterion sets and members, status records, oracle and evaluator specs, qualification
reports and fixtures, evaluation runs and attempts, raw observations, aggregate measurements, and
assessments. Required controls include:

- exact tenant, project, and environment keys with enabled and forced RLS;
- immutable definitions and append-only review, status, attempt, observation, and assessment
  records;
- typed columns and constraints for lifecycle, verdicts, counts, times, validity, and lineage;
- independently reparsed strict semantic JSON where normalized columns would lose meaning;
- acyclic source, supersession, criterion, oracle, evaluator, and assessment edges;
- API and executor roles with no public table or function grants;
- atomic outbox intents for publication, status, run creation, terminal result, and assessment;
- database-time authority and canonical lock ordering; and
- shared memory/PostgreSQL conformance plus PostgreSQL-specific concurrency and least-privilege
  tests.

Coordinated recovery must restore representative definitions, reviews, conflicts, qualification
reports, queued and terminal runs, every verdict, observations, aggregates, assessments, and outbox
state. Missing source or result artifacts, mismatched digests, expired authority, or broken lineage
fails verification. Recovery cannot turn an ineligible assessment into an eligible one or reuse a
source/evaluator version that was invalid at its recorded evaluation time.

## Acceptance matrix

The roadmap checkbox stays open until all gates below are executable:

| Boundary | Required evidence |
| --- | --- |
| Contracts | Strict bounded schemas reject unknown fields, unsafe executable text, mutable aliases, caller-owned identity or status, duplicate members, invalid times, non-finite numbers, and over-limit graphs |
| Integrity | Published fixed vectors prove domain separation and digest sensitivity for sources, criteria, applicability, oracle/evaluator specs, qualification reports, runs, observations, aggregation, and assessments |
| Authority | Discovery, byte integrity, publisher identity, authority, freshness, applicability, evaluator qualification, assessment eligibility, and release authority remain distinct in types, capabilities, storage, and UI language |
| Sources | Exact retained bytes, publisher verification, version and time metadata, licensing, scope, supersession, conflicts, and reviewer records survive read, restart, export, and recovery; search rank never becomes authority |
| Criteria | Immutable exact versions bind one bounded claim, rationale, scope, sources, assumptions, evidence classes, quorum, fixtures, counterevidence, lineage, and append-only lifecycle |
| Applicability | A bounded safe-language conformance suite proves total tri-state evaluation, unknown propagation, limits, typed fields, deterministic behavior, and no I/O or executable interpretation |
| Oracles | Digest-registered deterministic implementations run only predeclared schemas and budgets, deny ambient network and side effects, preserve raw results, reject self-qualification, and detect cyclic lineage |
| Qualification | Positive, negative, boundary, malformed, not-applicable, timeout, budget, abstention, and error fixtures bind exact versions and cannot be hidden, rewritten, or evaluated by mismatched implementations |
| Runs | Exact replay/result lineage, predeclared attempts, immutable raw observations, five-state verdicts, typed failure reasons, cancellation, budgets, and no retry-until-pass pass shared conformance |
| Statistics | Exact counts and denominators, absent undefined ratios, Wilson interval vectors, confidence bounds, numerical stability, unsupported-assumption limits, abstention, error, and coverage property tests pass |
| Assessments | Exact aggregation lineage preserves all runs, counterevidence, conflicts, minority findings, quorum, intervals, coverage, support status, eligibility, and reasons without emitting a release decision |
| Persistence | Memory and PostgreSQL adapters pass one suite; every new table has forced RLS, scope-preserving keys, append-only enforcement, least privilege, atomic outbox, deterministic reconstruction, and concurrent idempotency |
| Recovery | Representative authority, conflict, qualification, five-state, observation, aggregate, eligibility, and outbox rows survive the coordinated empty-target restore with exact digests and ordering |
| API and SDK | Exact-version publish, lifecycle, run, read, and assessment operations have stable problems, authorization-before-storage, OpenAPI parity, response parsing, request IDs, restart persistence, and no execute-from-text route |
| Usability | A provider-neutral guide and service-backed example show source review through assessment, including stale, conflicting, not-applicable, abstaining, error, low-coverage, and high-impact-ineligible paths |
| Repository | Frozen install, formatting, boundaries, docs, lint, strict types, full applicable coverage, builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact, recovery, and new evaluation integration jobs stay green |

Schema-only placeholders, an in-memory demo, an unexplained score, a model judge, or a green happy
path without tenant, conflict, failure, and recovery evidence does not complete this checkpoint.

## Initial implementation order

1. Add non-delegable `evaluation:manage` authority and migration-safe capability validation.
2. Publish strict source, review, criterion, applicability, oracle, evaluator, qualification, run,
   observation, aggregate, and assessment contracts with fixed digest vectors.
3. Implement the safe applicability interpreter, deterministic exact/schema oracle adapter, and
   reference statistical aggregate with property and adversarial tests.
4. Add domain repositories and use cases with one shared memory conformance suite.
5. Persist the graph with forced RLS, least-privilege executor functions, atomic outbox, migration
   evolution, concurrency tests, and coordinated recovery.
6. Add exact-version API, SDK, OpenAPI, operator documentation, and a service-backed reference flow.
7. Run an independent acceptance audit and close findings before checking the roadmap item.

Progress as of 2026-09-02:

- Steps 1 through 5 are implemented and verified locally and in GitHub CI at `98d1849`.
- Step 4 includes all 16 immutable record kinds, exact-scope repository ports, a memory adapter,
  one shared conformance suite, and authorization-first server-authored application use cases.
- Step 5 adds migrations `0037` through `0039`, normalized append-only PostgreSQL storage, forced tenant RLS,
  database-derived lineage and outbox intents, separated API/evaluation-worker authority, shared
  conformance, real concurrency and restart tests, and coordinated empty-target recovery.
- Step 6 is implemented and verified: exact-version API and SDK surfaces, a dedicated
  evaluation-worker storage boundary, operator documentation, and a service-backed reference flow
  now cover 30 durable records, all five verdicts, conservative aggregation, exact read-back, and
  API restart persistence.
- Step 7 is complete. The independent
  [acceptance audit](workflow-1-criteria-evaluation-audit.md) closes the service-backed checkpoint
  against authoritative local and remote gates. Workflow 1 exit remains unapproved because
  model-assisted evaluation, exact comparison, and the final end-to-end audit remain open.

Each coherent change receives its own English commit and must leave its applicable local gates
green before push. GitHub CI and Security remain authoritative for the external runner and service
matrix.

## Entry limitations

- No source is automatically correct, authoritative, current, or applicable because ProofStack
  retained or hashed it.
- The first implementation does not crawl, search, license, or legally interpret external
  material. Discovery connectors remain optional untrusted inputs.
- The applicability language handles explicit deployment facts; it cannot infer business purpose,
  legal jurisdiction, population impact, or risk tolerance.
- Deterministic oracles can implement a wrong criterion perfectly. They remain contestable and
  independently qualified.
- The first statistical aggregate does not prove representative sampling, causal effect,
  independence, or probability of correctness.
- Model-assisted evaluators, calibration, blinded comparison, counteranalysis, and human-review
  records remain the next checkpoint.
- High-impact assessments remain ineligible until required independent human review exists.
- No comparison UI, policy decision, approval, release gate, or production-readiness claim is
  included.
