# Workflow 1 baseline and candidate comparison entry audit

[English](workflow-1-baseline-candidate-comparison-entry-audit.md) |
[한국어](workflow-1-baseline-candidate-comparison-entry-audit.ko.md)

- Status: accepted for implementation entry; checkpoint remains open
- Reviewed: 2026-09-02
- Dependency: accepted model-assisted and human-evaluation checkpoint at `14d938b`
- Production readiness: not approved
- Policy, approval, deployment, or release authority: not included
- Workflow 1 exit: not approved

## Decision

The exact baseline/candidate comparison checkpoint may begin. Its dependency is satisfied:
ProofStack can retain exact regression datasets, bounded replay results, usage observations,
non-model assessments, model-assurance assessments, artifacts, counterevidence, disagreement, and
human reviews through authenticated, tenant-isolated, append-only, recoverable service boundaries.
It still cannot freeze those sources into one comparison, align cases safely, expose complete
missingness, or show a reproducible operator diff.

This checkpoint adds a descriptive, policy-independent comparison layer:

```text
exact baseline sources + exact candidate sources
  -> immutable comparison definition
  -> server-derived evidence snapshots
  -> fixture pairing and comparability analysis
  -> exact descriptive result
  -> source-backed operator view
```

Every arrow binds immutable identifiers and semantic digests. The result describes differences; it
does not decide whether a candidate improved, passed a threshold, is safe, or may be released.
Those decisions remain blocked until Workflow 2.

The governing decision is [ADR-0020](../architecture/0020-exact-evidence-comparison.md).

## Verified dependency boundary

The accepted Workflow 1 checkpoints currently provide:

- immutable trace snapshots and ordered exact dataset membership;
- retained classified interactions and exact artifact ownership;
- recorded-boundary replay and durable replay jobs with attempts, fencing, cancellation, usage,
  side-effect evidence, terminal outcomes, and restart persistence;
- exact criteria, applicability, qualification, observations, five-state evaluator outcomes,
  aggregates, intervals, coverage, counterevidence, and assessments;
- exact model, prompt, tool, qualification, calibration, blinding, independence, critique, and
  accountable human-review lineage;
- separate control, worker, model-worker, and human-review authorities enforced by HTTP
  capabilities, PostgreSQL grants, and forced row-level security;
- fixed canonical encodings, digest recomputation, conflict rejection, outbox intents, and
  coordinated empty-target recovery; and
- exact-version API, TypeScript SDK, OpenAPI, and service-backed restart read-back examples.

The existing `BlindedEvaluationPlan` compares presentation orders for evaluator-assurance
purposes. It is not the product comparison requested by this checkpoint. It does not freeze the
full trace, replay, cost, latency, artifact, safety, uncertainty, or coverage state and cannot be
repurposed as a release diff.

## Exact record boundary

### Comparison definition

An immutable `ComparisonDefinition` will bind:

- one exact baseline subject and one exact candidate subject;
- exact dataset identities, version identifiers, and definition digests;
- ordered mappings from logical fixture identity to exact fixture version, terminal replay job,
  terminal attempt, result digest, and applicable assessment references;
- exact criterion, aggregate, non-model assessment, and model-assurance assessment references;
- a finite ordered metric specification for trace structure, outcomes, numeric measurements,
  replay usage, safety events, artifacts, uncertainty, and coverage;
- explicit units, aggregation methods, quantile method, interval method, and method versions;
- fixture pairing, strata, missingness, invalid-case, and denominator rules;
- a source cut-off, bounded record limits, and classified-content projection rules; and
- exact predecessor, creator, server time, schema version, and definition digest.

The request supplies exact references and calculation intent only. The server owns scope,
timestamps, resolved records, extracted values, pairing state, summaries, deltas, and
comparability. Unknown fields, caller-supplied derived values, mutable aliases, arbitrary SQL,
executable expressions, policy thresholds, and release language are rejected.

### Evidence snapshots

The server creates one immutable `ComparisonEvidenceSnapshot` for each role. It re-resolves every
reference in the authenticated scope and validates its schema and digest before publication. Each
snapshot records:

- exact ordered dataset and fixture membership;
- trace event-kind and status counts derived from exact fixture event identifiers;
- terminal replay job and attempt state plus exact result or error evidence;
- replay usage by dimension with `measured`, `estimated`, `provider_reported`, or `unavailable`
  provenance preserved;
- evaluator verdicts, numeric and categorical measurements, exact counts, intervals, coverage,
  abstentions, errors, qualifications, and assessment eligibility;
- model-assurance eligibility, calibration compatibility, blinded disagreement, critique,
  counterevidence, human-review state, and limitations;
- artifact identity, digest, size, classification, and availability without plaintext; and
- every omitted, unavailable, invalid, or over-limit source with a machine-readable reason.

Only terminal replay jobs can enter an accepted snapshot. Source records that are unavailable,
out of scope, digest-invalid, duplicated, nonterminal, or causally inconsistent fail publication.
Missing optional evidence remains visible as missing; it is never converted to zero.

### Pairing and comparability

Cases are paired by exact logical fixture identity. The comparison retains the exact fixture
version used on each side so a changed fixture remains visible. Before aggregation, every requested
case is classified as:

- `paired`: both roles provide valid exact evidence;
- `baseline_only`: candidate evidence is absent;
- `candidate_only`: baseline evidence is absent; or
- `invalid`: one or both sides failed exact source validation.

Duplicate keys, cross-scope identities, or ambiguous many-to-one mappings are rejected. Pairing is
calculated before aggregate statistics. The result records complete role-specific and paired
denominators, preventing missing candidate cases from making the candidate appear better.

`coverage_count` is an exact-criterion logical-fixture metric: `observed` requires a retained
matching outcome, `abstention` and `error` require a nonzero corresponding count, and `decided`
requires at least one pass, fail, or not-applicable outcome. Missing outcomes remain missing.
Paired fixture coverage is recorded once by the pairing summary and every metric's paired sample
counts rather than being reinterpreted as another coverage metric.

Overall comparability is `comparable`, `partially_comparable`, or `incomparable` with an exact,
ordered reason set. Reasons cover at least dataset mismatch, fixture mismatch, criterion mismatch,
unit mismatch, method mismatch, population mismatch, calibration mismatch, insufficient paired
coverage, missing source evidence, invalid source integrity, unsupported statistical assumptions,
and unresolved critical counterevidence.

### Descriptive result

An immutable `ComparisonResult` binds the definition and both snapshots and derives:

- trace structure counts and exact deltas;
- complete marginal evaluator verdict counts and paired transitions only when the retained
  evidence reconstructs one exact transition matrix; otherwise explicit unavailability reasons;
- numeric distributions using finite declared methods and exact sample counts;
- latency, provider cost, token, byte, model-request, tool-call, and artifact-emission usage;
- policy-independent safety-event counts and exact source references;
- artifact additions, removals, same-content entries, metadata changes, and unavailable content;
- assessment and model-assurance eligibility changes without reinterpreting eligibility as truth;
- coverage, missingness, abstention, error, uncertainty, counterevidence, disagreement, and known
  limitations; and
- overall comparability and reasons.

Numeric differences preserve exact integers or canonical decimals. Ratios preserve numerators and
denominators. Distributions preserve method versions, finite source samples or exact source
references, and unavailable reasons. Incompatible values are `incomparable`; absent values are
`unavailable`; neither becomes zero.

The result cannot contain a policy threshold, weighted overall score, pass/fail, improvement,
regression, approval, rejection, deployment, or release decision.

## API and operator boundary

The exact-version API will provide create/read operations for definitions, snapshots, and results.
Creation is idempotent for identical semantics and conflicts for the same ID with different
semantics. Reads require the same exact tenant, project, and environment scope and never reveal
whether an inaccessible identifier exists. Stable problems distinguish invalid input, unavailable
source lineage, nonterminal source, digest conflict, unsupported comparison, and bounded-size
failure without embedding classified content.

The TypeScript SDK strict-parses every success and problem response, recomputes public definition
digests, applies finite response limits, and never silently accepts an unknown newer schema.
OpenAPI examples use synthetic content and match runtime schemas.

The operator view will:

- require an exact comparison result ID rather than a mutable latest alias;
- show baseline and candidate source identity, timestamps, and digests;
- render fixture pairing and missing cases before aggregate deltas;
- place units, numerator/denominator, sample count, missingness, provenance, interval, and
  comparability next to each value;
- expose exact source links only when the authenticated reader may access them;
- distinguish measured, estimated, provider-reported, and unavailable cost or usage;
- show counterevidence, disagreement, and limitations without collapsing them into one badge;
- remain usable without color and include table semantics, keyboard navigation, focus visibility,
  and screen-reader labels; and
- contain no release button, approval control, hidden policy threshold, or client-authoritative
  recomputation.

The browser must render a safe bounded projection. Artifact plaintext, model prompt content,
credentials, reviewer-private rationale, and raw classified evidence are not embedded in the page.

## Security and persistence boundary

Comparison uses a dedicated management capability and read capability. Neither can write model
observations, human reviews, policies, approvals, or releases. Authorization occurs before any
repository access. PostgreSQL owns the independent backstop through least-privilege functions,
forced RLS, no public DML, append-only triggers, immutable ID bindings, and exact-scope foreign
keys or transactional lineage checks.

Definition, snapshot, and result publication each commits one atomic outbox intent. Identical
retries return original server provenance; conflicting retries write nothing. Every comparison
table joins migration checksum, clean-install, upgrade, rollback-barrier, forced-RLS, representative
tenant-state, and coordinated empty-target recovery matrices before the public durable route is
accepted.

Bounded cardinality applies independently to fixtures, metrics, samples, source references,
artifacts, counterevidence, and rendered rows. Parsing and derivation use explicit work limits.
Adversarial tests cover oversized definitions, duplicate pair keys, digest substitution, unit
confusion, denominator manipulation, malformed decimals, non-finite values, integer overflow,
cross-tenant references, source races, artifact revocation, unknown schemas, and hostile display
text.

## Acceptance matrix

The roadmap checkbox remains open until every gate below is executable and accepted.

| Boundary | Required evidence |
| --- | --- |
| Contract | Strict schemas, bounded collections, exact references, canonical decimals, explicit units, complete missingness, no caller-owned derived fields, and no policy or release semantics |
| Integrity | Domain-separated canonical encoders and fixed vectors cover every semantic field, role, order, optional marker, exact source digest, method version, and predecessor |
| Pairing | Duplicate and ambiguous mappings fail; paired, baseline-only, candidate-only, and invalid cases reconstruct exactly before aggregation |
| Derivation | Exact deltas, ratios, distributions, transitions, artifacts, safety events, uncertainty, and comparability reconstruct deterministically from the two snapshots |
| Missingness | Missing, unavailable, invalid, abstained, errored, estimated, and incompatible inputs remain distinct and cannot become zero or leave denominators silently |
| Statistics | Sample counts, assumptions, interval and quantile methods, strata, multiplicity limits, and unsupported inference are explicit; no significance or causality claim is invented |
| Authorization | Comparison manage/read capabilities are distinct; checks precede storage; control authority cannot manufacture worker or human evidence and comparison cannot authorize release |
| Persistence | Append-only PostgreSQL records, exact-scope lineage, kind-safe identifiers, conflict rejection, forced RLS, no public DML, atomic outbox, and three-tenant adversarial coverage pass |
| Recovery | Representative definitions, both snapshots, results, source references, methods, reasons, digests, and outbox state survive coordinated empty-target restore |
| API and SDK | Exact-version operations, stable bounded problems, strict parsing, digest verification, restart persistence, unknown-schema rejection, and OpenAPI parity pass |
| Operator view | Real API-backed exact result, source identity, pairing, units, denominators, missingness, uncertainty, accessibility, responsive layout, hostile-text safety, and no release control are browser-verified |
| Service flow | One adversarial baseline/candidate example crosses API, SDK, PostgreSQL, restart, UI projection, unavailable usage, mismatched fixture, artifact change, disagreement, and full digest replay |
| Repository | Frozen install, format, boundaries, documentation links, lint, strict types, unit coverage, builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact, and recovery gates remain green |

Schema-only records, client-computed summaries, memory-only behavior, a static mockup, or a green
unit suite without PostgreSQL, recovery, service, and browser evidence cannot complete this
checkpoint.

## Cross-check findings fixed by design

| Risk found at entry | Required resolution |
| --- | --- |
| A candidate can look better by omitting hard cases | Pair before aggregating and preserve every baseline-only, candidate-only, invalid, abstained, and errored case |
| Different dataset versions can be treated as identical | Bind exact dataset and fixture version digests and expose changed membership and versions |
| Averages can hide distribution and subgroup movement | Preserve finite distributions, strata, sample counts, uncertainty, and complete marginal values |
| Cost or latency units can be mixed | Require exact units and method versions; mismatch is incomparable rather than converted implicitly |
| Missing usage can become zero cost | Preserve unavailable reason and measurement provenance independently for every usage dimension |
| Model confidence can be presented as probability | Expose calibrated values only with exact compatible calibration lineage; otherwise unavailable |
| Revoked artifacts can disappear from the diff | Preserve exact artifact identity and availability state; never fetch plaintext into the comparison JSON |
| A mutable replay job can change after comparison | Accept terminal jobs only and freeze a source-backed snapshot at one server boundary |
| The UI can invent authoritative calculations | Render server-derived exact records and verify digests; browser calculations are display-only and non-authoritative |
| A descriptive delta can become a release verdict | Forbid policy thresholds, pass/fail, approval, safety, or release fields and keep Workflow 2 authority separate |
| Large comparison input can exhaust the service | Bound every collection and derivation step and reject over-limit work before publication |

## Accepted entry limitations

- The reference comparison will use synthetic fixtures and bounded local services; it will not
  prove representative production behavior or causal improvement.
- The first implementation will support finite declared metric and distribution methods, not
  arbitrary SQL, notebooks, plugins, or user-supplied code.
- Exact pairing depends on stable logical fixture identity. Unrelated datasets may be partially
  comparable or incomparable.
- Trace structure reflects retained telemetry, not global execution completeness.
- Provider cost may be estimated, measured, provider-reported, disputed, or unavailable. The UI
  must retain that distinction.
- Statistical intervals depend on declared assumptions and cannot prove independence, absence of
  bias, or future behavior.
- Artifact metadata and availability can be compared without exposing artifact plaintext.
- Comparison evidence remains contestable. It cannot choose the correct business objective,
  establish policy, grant capabilities, approve deployment, or authorize release.
- Workflow 1 exit remains blocked until this checkpoint passes and the independent end-to-end
  Workflow 1 audit closes all findings.

## Immediate implementation order

1. Publish strict comparison contracts, canonical encoders, fixed vectors, and reconstructive unit
   tests for definitions, subject snapshots, and results.
2. Implement exact source resolvers, terminal-state checks, pairing, missingness, distribution,
   artifact, usage, safety-event, and comparability derivation in core.
3. Add memory conformance and adversarial race, overflow, unit, digest, scope, and corruption tests.
4. Persist comparison records with append-only PostgreSQL authority, outbox, RLS, tenant matrices,
   migration barriers, and recovery before exposing public durable routes.
5. Add exact-version API, strict TypeScript SDK, OpenAPI, and a service-backed restart flow.
6. Build and browser-verify a real API-backed accessible operator view.
7. Run the entire repository and remote CI/security matrix, independently audit the checkpoint,
   close every finding, and only then mark the roadmap item complete.

Each coherent implementation change receives its own English commit. GitHub `main` and its
completed Actions runs remain the external acceptance evidence.
