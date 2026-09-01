# Workflow 1 model-assisted and human evaluation entry audit

[English](workflow-1-model-human-evaluation-entry-audit.md) |
[한국어](workflow-1-model-human-evaluation-entry-audit.ko.md)

- Status: accepted for implementation entry; checkpoint remains open
- Reviewed: 2026-09-02
- Dependency: accepted criteria and non-model evaluation checkpoint at `06034d0`
- Production readiness: not approved
- Baseline/candidate comparison: not included
- Policy, approval, deployment, or release authority: not included
- Workflow 1 exit: not approved

## Decision

The qualified model-assisted and human-evaluation checkpoint may begin. Its dependency is real:
ProofStack can retain exact sources and authority reviews, publish contestable criteria and
non-model evaluator definitions, qualify bounded evaluators, preserve all five verdicts, calculate
explicit coverage and intervals, and produce an assessment whose support and eligibility remain
separate. It still cannot safely use a model judgment as calibrated, independent, injection-safe,
or sufficient human-reviewed evidence.

This checkpoint adds bounded model and human evidence to the existing assurance graph:

```text
exact criterion + qualified non-model evidence
  -> exact model-evaluator profile + qualification + calibration
  -> blinded attempts + independent counteranalysis + raw observations
  -> disagreement-preserving assessment
  -> accountable human review
```

Every arrow binds immutable IDs and semantic digests. A model response is an untrusted
observation, not a fact. A rationale is not evidence unless it links to retained trace, artifact,
oracle, or verified source records. A human review is accountable evidence, not an overwrite and
not a release decision. A model or reviewer can never widen the evaluated agent's authority.

The first vertical slice will be provider-neutral. A narrow provider port will execute an exact
request profile through a controlled test adapter and an explicitly configured live-provider
adapter boundary. Acceptance proves protocol, provenance, failure, isolation, and conservative
decision behavior; it does not claim that every provider or model is compatible, unbiased, or fit
for production.

## Current dependency evidence

The accepted non-model checkpoint supplies:

- immutable source, review, criterion, fixture, oracle, evaluator, qualification, run,
  observation, aggregate, and assessment records;
- domain-separated canonical encoders, fixed public vectors, and strict digest recomputation;
- a bounded total applicability language and registered non-model oracle adapters;
- five-state verdicts, explicit denominators, Wilson intervals, disagreement, counterevidence, and
  separate assessment eligibility;
- separate management and evaluation-worker authorities, forced tenant RLS, append-only tables,
  exact lineage, atomic outbox intents, and coordinated recovery;
- exact-version API, SDK, OpenAPI, and a service-backed restart-persistent reference flow; and
- a fail-closed high-impact rule that remains ineligible while independent human review is absent.

New model and human records must reference those authoritative records. They cannot accept
caller-authored criteria, replay outputs, artifact digests, qualification state, assessment state,
or server times as substitutes.

## Record and authority boundary

### Publish an exact model evaluator profile

A `ModelEvaluatorProfile` is an immutable exact version. It binds:

- one existing evaluator definition and its semantic digest;
- provider and adapter identifiers and versions;
- provider model identifier, resolved model version when the provider exposes one, base-model
  family, fine-tune or derivative lineage, and declared training-data relationship;
- system, rubric, task, counteranalysis, and output-repair prompt-template digests;
- exact tool-contract and structured-output-schema digests;
- locale, clock, seed, sampling parameters, stop conditions, maximum input and output sizes,
  timeout, request, token, and cost budgets, and finite attempt policy;
- network, data-egress, artifact-plaintext, retention, logging, and geographic policies;
- supported criterion families, scopes, risk tiers, languages, and out-of-distribution rules;
- known limitations, provider safety-filter behavior, reproducibility class, and validity window;
  and
- publisher principal, server receipt time, schema version, predecessor, and definition digest.

Prompt bytes and tool schemas are retained as classified artifacts. A profile cannot contain a
credential, arbitrary destination selected by criterion data, executable code, release policy,
agent capability, or mutable model alias without a separately retained resolution record. Changing
any semantic field creates a new profile version and digest.

The platform never interprets a provider product name as a stable model version. When a provider
cannot disclose an immutable model revision, ProofStack records that limitation and cannot claim
bit-for-bit reproducibility.

### Make material independence reviewable

An `IndependenceDeclaration` is an immutable declaration and review outcome for one evidence path.
It records provider, base-model and fine-tune lineage, evaluator implementation, prompt author,
evaluator developer, label or fixture source, criterion author, operating organization, funding or
commercial relationship, shared infrastructure, declared conflicts, unknown dimensions, reviewer,
review basis, validity, and exact subject digests.

An independence group ID alone proves nothing. Two names, prompts, temperatures, endpoints,
accounts, or repeated samples are not independent when material lineage is shared or unknown. The
reference grouping algorithm is conservative: a shared or unknown required dimension prevents the
paths from satisfying an independent quorum. Operators may declare additional correlation; they
may not waive a known correlation through a label.

### Separate qualification from calibration

Model-evaluator qualification extends the existing immutable qualification report and must include
held-out, versioned cases for:

- positive, negative, boundary, malformed, and not-applicable behavior;
- direct, indirect, encoded, multilingual, and retrieved-content prompt injection;
- forged citations and unsupported evidence references;
- baseline/candidate position swaps and neutral identifier substitutions;
- length, verbosity, style, authority, sentiment, and bandwagon perturbations;
- self-provider and self-family preference;
- repeated-sample variance under the declared sampling policy;
- out-of-distribution detection and abstention;
- structured-output failure, provider refusal, timeout, rate limit, network loss, partial stream,
  budget exhaustion, and late response; and
- preserved disagreement with human labels, non-model oracles, minority findings, and
  counterevidence.

The evaluated implementation cannot publish its own qualifying state. Qualification records every
included, excluded, failed, and abstained case and reports exact slice denominators. A passing
overall average cannot hide a mandatory-slice failure.

A `CalibrationReport` is a separate immutable record bound to one exact model-evaluator profile,
criterion family, label-source version, dataset version, population, language, risk slice, scoring
method, and validity window. It retains raw bounded predictions and labels or exact artifact
references, binning or calibration method, sample and exclusion counts, Brier score, log loss when
defined, calibration error with its exact variant, reliability-bin measurements, selective risk
and coverage points, uncertainty, limitations, and distribution-shift checks.

Raw model confidence is never renamed as probability of correctness. A calibrated probability is
available only for the exact compatible slice and only while the report is current. Missing,
expired, scope-mismatched, underpowered, label-conflicted, or distribution-shifted calibration
produces `unavailable`; it never falls back to raw confidence.

### Preserve blinded order swaps

A `BlindedEvaluationPlan` freezes the presentation before execution. It binds exact baseline and
candidate subjects to opaque labels generated independently of the evaluator, the masking method,
redaction report, leakage checks, both presentation orders, finite repetitions, seeds, budgets,
provider profile, criterion, fixtures, and adjudication rule. The blind map is separately
classified and is not available to the evaluator or critic during execution.

Both declared orders run. Each attempt and response is immutable. A label leak, missing order,
order-sensitive verdict, materially different rationale, or incomplete blind is an explicit
disagreement or invalidity reason. The runner cannot silently retry, drop the unfavorable order,
unblind early, or average away reversal.

The first checkpoint proves pairwise protocol integrity but does not expose the product's final
baseline/candidate diff API or operator view; those remain the next roadmap checkpoint.

### Isolate critique and counteranalysis

An `IndependentCritique` binds one exact observation but is created without access to its rationale
or verdict until the critique is fixed. It receives the criterion, allowed evidence, and a bounded
question asking for missing evidence, counterexamples, scope errors, injection indicators, and
alternative interpretations. Its provider profile and independence declaration are exact.

Original judgment, critique, response to critique, and adjudication are separate immutable
records. Agreement after critique is still evidence, not proof. A correlated critic cannot satisfy
an independent quorum. Critical counterevidence or conflict with an applicable non-model oracle
cannot be erased by a model majority.

### Append accountable human review

A `HumanReviewProtocol` is an immutable definition of who may review a bounded claim. It declares
required roles and expertise, training or credential evidence, independence rules, conflict
disclosures, minimum reviewers, evidence bundle, allowed actions, rationale requirements,
accessibility and locale needs, time budget, expiry, escalation, dissent, recusal, supersession, and
adjudication rules.

A `HumanReviewRecord` references the exact protocol, reviewer principal, authenticated session,
role, expertise evidence, declared relationships and conflicts, independence declaration, exact
criterion, observations, counterevidence, assessment and artifact digests reviewed, action,
structured reasons, free-text rationale artifact, started and completed server times, expiry, and
supersession link.

Allowed actions are bounded to `support`, `oppose`, `abstain`, `request_changes`,
`require_escalation`, and `recuse`. A review cannot mutate evidence, reclassify an observation,
change a criterion, satisfy a model qualification report, grant a capability, approve a release,
or conceal dissent. A later correction appends a superseding record and keeps the original visible.

The platform verifies authentication, declared protocol eligibility, exact evidence access, scope,
time ordering, conflicts, and independence claims it can prove. It does not infer expertise,
honesty, organizational independence, or the one correct business value from a user account.

## Execution and security boundary

Model execution receives a separate `evaluation:model:run` workload capability. It is
project-and-environment restricted, finite-lived, non-delegable by the workload, and narrower than
`evaluation:manage`. It can read only the exact approved execution bundle and append provider
attempts and raw model observations through narrow worker functions. It cannot publish profiles,
prompts, criteria, qualification, calibration, independence, human reviews, assessments, policy,
approval, or release records.

Human review receives `evaluation:human:review`. It is user-only, subject to the exact protocol and
scope, and cannot be exchanged for management or release authority. Protocol publication and
reviewer-eligibility administration remain separate management operations. A reviewer cannot
review evidence they cannot independently read.

Provider adapters receive credentials only at the last responsible boundary. Credentials are
never written to records, logs, prompts, artifacts, outbox payloads, or errors. Redirects are
disabled unless an exact allowlist policy permits them. DNS, scheme, host, port, TLS, proxy, size,
stream, time, token, cost, and retry limits are validated before and during I/O. Model-returned tool
requests are data and are never executed by the evaluation runner.

Prompt templates treat every task input, retrieved passage, trace, artifact excerpt, tool output,
model rationale, and counteranalysis as untrusted delimited data. Input text cannot change the
system rubric, provider destination, tools, budgets, output schema, criterion, or platform
authority. Unknown output fields, malformed structured output, missing citations, unsafe links,
and over-limit content fail as typed observations rather than triggering hidden repair loops.

Provider calls never occur while holding a database transaction or lease lock. Every request gets
a precommitted attempt identity and budget reservation. Cancellation, timeout, lease loss, late
response, partial stream, retry, and usage reconciliation preserve all evidence and cannot produce
two terminal results.

## Assessment boundary

The existing assessment remains the support and eligibility projection. This checkpoint may add
exact model, calibration, independence, blind, critique, and human-review references, but it does
not create a release decision.

High-impact eligibility requires all of the following:

1. an approved and applicable criterion with current verified source review;
2. current qualification for every evaluator and mandatory slice;
3. compatible current calibration for every probability claim;
4. the declared evidence classes and materially independent quorum;
5. at least one applicable non-model evidence path;
6. complete blinded orders where comparison influenced the judgment;
7. no unresolved critical injection, provenance, oracle, counterevidence, or scope conflict;
8. coverage, abstention, error, disagreement, and selective-risk bounds within the predeclared
   limits; and
9. every required independent human review under the exact current protocol.

Any missing or unverifiable requirement makes the assessment `ineligible` with machine-readable
reasons. A model majority cannot override a deterministic contradiction. A human majority cannot
repair missing provenance, invalid calibration, or an unauthorized criterion. Eligibility means
only that a later Workflow 2 policy may consider the evidence.

## Persistence and recovery boundary

Every new public record receives a strict contract, domain-separated canonical encoder, fixed
public vector, immutable repository operation, shared memory/PostgreSQL conformance, typed
PostgreSQL table, common registry row, exact lineage edges, canonical outbox intent, forced tenant
RLS, append-only enforcement, and read-time digest verification.

Control-plane, model-worker, non-model worker, reviewer, and read-only authorities remain distinct.
No runtime role receives direct table DML. Security-definer functions fix `search_path`, derive
server time, enforce transaction scope, validate exact dependencies, lock canonical uniqueness
slots, and revoke `PUBLIC`.

Coordinated backup and empty-target restore include representative qualified, unqualified,
calibrated, uncalibrated, correlated, blinded, order-sensitive, injected, abstaining, provider-error,
human-supported, human-opposed, recused, superseded, and ineligible records. Restore recomputes
digests and verifies lineage, outbox identity, RLS, roles, and eligibility without renewing expired
authority or calibration.

## API, SDK, and usability boundary

Exact-version management and read routes expose profiles, independence declarations,
qualification, calibration, blind plans, critiques, protocols, reviews, and extended assessments.
Worker-only routes accept exact preauthorized attempt commands and never arbitrary prompts or
destinations. OpenAPI and the TypeScript SDK use the same strict contracts and reject semantic
digest mismatches.

The service-backed example must:

1. publish one exact model profile without embedding credentials;
2. publish qualification evidence containing passing and failing mandatory slices;
3. publish compatible and incompatible calibration reports;
4. declare two apparently different but materially correlated judges and one independent path;
5. execute both blinded presentation orders and retain an order reversal;
6. preserve a prompt-injection signal, forged citation, abstention, provider error, and critical
   non-model counterevidence;
7. create independent critique before revealing the original rationale;
8. append supporting, opposing, and recused human reviews without deleting dissent;
9. create a conservative ineligible assessment with exact reasons;
10. read every record through the SDK, restart the API, and reproduce the same digests; and
11. prove that model-worker and reviewer credentials cannot publish policy, approval, or release
    state.

The example cannot require a paid external account for contributors. A bounded local provider
harness proves the protocol; an optional live-provider smoke path must be separately configured,
marked non-deterministic, redactable, cost-bounded, and excluded from the default test gate.

## Acceptance matrix

| Boundary | Required executable evidence |
| --- | --- |
| Contracts | Strict schemas reject unknown fields, mutable aliases, credentials, arbitrary destinations, executable prompt content, unbounded arrays, non-finite values, invalid time relations, duplicate members, caller-owned server fields, and unsupported lifecycle transitions |
| Integrity | Domain-separated canonical encoders and fixed vectors cover every semantic field, optional marker, ordered member, blind mapping, predecessor, and lineage edge; SDK and storage independently recompute digests |
| Model lineage | Exact provider, adapter, model-resolution, prompt, tool, schema, sampling, budget, egress, retention, and limitation lineage survives API restart and recovery |
| Qualification | Every required normal, adversarial, injection, perturbation, abstention, malformed, provider-failure, budget, and disagreement slice has explicit denominators and cannot be hidden by an average |
| Calibration | Raw confidence remains distinct; exact-slice reports retain measurements, uncertainty, exclusions, selective risk, coverage, validity, and shift checks; incompatible reports fail closed |
| Independence | Material lineage dimensions and unknowns are reviewable; correlated paths cannot satisfy independent quorum under aliases or repeated samples |
| Blinding | Blind maps are separately classified, both orders execute, leaks and reversals remain visible, and retries cannot discard an unfavorable order |
| Injection | Direct, indirect, encoded, multilingual, retrieved, citation, tool-request, and rationale injection cases remain untrusted data and produce typed evidence without changing authority |
| Critique | The critic is fixed before rationale disclosure, exact evidence access is bounded, correlation is visible, and critique cannot overwrite the original observation |
| Human review | Authenticated protocol eligibility, expertise evidence, relationships, conflicts, evidence digests, dissent, abstention, recusal, expiry, and supersession are append-only and cannot grant release authority |
| Runtime | Provider credentials and plaintext never enter durable metadata; destination, TLS, redirect, proxy, size, time, token, cost, stream, retry, cancellation, lease, late-response, and tool-call behavior fail within declared bounds |
| Persistence | Shared memory/PostgreSQL conformance, typed tables, registry, lineage, canonical locks, forced RLS, no public DML, narrow role grants, outbox atomicity, concurrency, corruption, and restart tests pass |
| API and SDK | Authorization precedes storage, exact-version HTTP and worker routes use stable problems, OpenAPI parity and strict SDK parsing hold, and no arbitrary-prompt or mutable-latest route exists |
| Recovery | Representative valid, invalid, conflicted, expired, dissenting, and ineligible records restore into an empty target with exact digests, lineage, roles, and outbox state |
| Assessment | High-impact evidence requires current source, qualification, compatible calibration, independent quorum, non-model evidence, complete blind protocol, no critical conflict, declared bounds, and current independent human review |
| Repository | Frozen install, formatting, boundaries, docs, lint, strict types, unit tests, full coverage, builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, and recovery gates remain green |

Schema-only placeholders, a prompt wrapper, one judge score, agreement from correlated models, a
human approval checkbox, memory-only storage, or green unit tests without the service, tenant,
authority, recovery, and adversarial matrices do not complete this checkpoint.

## Cross-check risks fixed by design

| Entry risk | Required resolution |
| --- | --- |
| A provider model alias changes silently | Retain exact resolution metadata and downgrade reproducibility when the immutable revision is unavailable |
| A prompt or tool schema changes outside lineage | Bind exact classified artifacts and semantic digests into the profile and every run |
| Model confidence is presented as correctness probability | Require a compatible immutable calibration report or report probability as unavailable |
| Different names imitate independent judges | Evaluate material lineage dimensions and treat shared or unknown required dimensions as correlated |
| Position bias disappears into an average | Freeze both blind orders and preserve every reversal and rationale difference as disagreement |
| Prompt injection changes the rubric or calls a tool | Treat all model inputs and outputs as delimited data; evaluator tool requests are never executed |
| A critic follows the first judge's rationale | Fix independent counteranalysis before rationale disclosure and retain both records |
| Retry-until-pass hides model variance | Predeclare finite attempts and preserve every sample, refusal, timeout, cost, and error |
| Human review becomes an unaccountable checkbox | Bind authenticated reviewer, expertise, conflicts, exact evidence, action, rationale, expiry, dissent, and supersession |
| A reviewer or model grants release authority | Keep evaluation evidence, eligibility, policy, approval, and release in separate contracts and capabilities |
| Restore silently renews stale evidence | Preserve original validity and re-evaluate eligibility without changing restored records |

## Accepted implementation order

1. Publish strict model profile, independence, calibration, blind-plan, critique, human-protocol,
   and human-review contracts with fixed canonical vectors.
2. Extend qualification and assessment contracts with exact model/human lineage and conservative
   compatibility checks.
3. Add pure independence grouping, calibration compatibility, blind-order, injection,
   disagreement, and human-protocol evaluators.
4. Add immutable repository ports, memory conformance, and authorization-first use cases.
5. Persist every record with typed PostgreSQL invariants, forced RLS, narrow model-worker and
   reviewer authority, outbox atomicity, concurrency, and corruption tests.
6. Extend coordinated recovery and role reprovisioning before public API exposure.
7. Add exact-version API, worker boundary, SDK, OpenAPI, operator documentation, and a bounded
   provider harness.
8. Run the service-backed reference flow and an independent acceptance audit before checking the
   roadmap item.

Each coherent change receives its own English commit and must leave its applicable local gates
green before push. GitHub CI and Security remain authoritative for the external runner and service
matrix.

## Entry limits

- This audit authorizes implementation; it does not make model-assisted or human evaluation
  available.
- The default acceptance harness is synthetic and local. It does not prove the quality, stability,
  privacy, geographic behavior, pricing, or compatibility of a commercial model provider.
- Model-generated rationales and citations remain untrusted until linked to authoritative retained
  evidence.
- Calibration is empirical and slice-specific; it does not transfer automatically across models,
  prompts, languages, criteria, populations, or time.
- Software cannot prove a person's expertise, honesty, independence, or organizational authority;
  it can retain accountable declarations and enforce configured protocol constraints.
- Business purpose and risk tolerance remain accountable human choices. Search or models may
  discover candidates and counterevidence but cannot derive the one correct policy.
- Exact baseline/candidate comparison APIs and operator views remain the next checkpoint.
- Workflow 2 policy, approval, deployment, rollback, break-glass, and release decisions remain
  unavailable.
- Production readiness and Workflow 1 exit remain unapproved.
