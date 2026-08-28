# ADR-0014: Treat criteria and evaluator outputs as contestable claims

Status: Accepted
Date: 2026-08-29
Owners: ProofStack maintainers

## Context

An evaluator cannot determine whether an agent behaved correctly without a criterion, but the
criterion author can be mistaken, incomplete, biased, out of date, or outside their authority.
Official documents can conflict or apply only to a particular jurisdiction, population, language,
deployment, or risk class. A deterministic test can execute the wrong requirement perfectly.

Search engines and language models can discover relevant material and counterexamples, but their
ranking, snippets, generated summaries, and judgments are not ground truth. Model judges also have
position, verbosity, self-preference, prompt-injection, calibration, and distribution-shift risks.
Running the same model repeatedly or asking correlated models to agree does not create independent
evidence.

ProofStack cannot eliminate the human choice of business purpose and risk tolerance. It can make
that choice explicit, versioned, challengeable, empirically qualified, and separate from the
release policy that acts on it.

## Decision

### Represent an assurance case, not a truth score

Workflow 1 will build a bounded acyclic assurance graph:

```text
claim -> evidence + assumptions + counterevidence -> assessment
```

A criterion states a contestable claim and the evidence required to assess it. An evaluator
produces observations about that claim. An assessment reports support, contradiction,
inconclusiveness, or invalidity. It does not rewrite evidence and it is not a release decision.
Workflow 2 applies a separately versioned policy to eligible assessments and records the resulting
decision.

ProofStack will not publish one aggregate `trustScore`. The following dimensions remain separate
and machine-readable:

- integrity: whether fixed bytes match their declared digest;
- source identity: whether publisher and document version were verified;
- applicability: whether an authorized reviewer approved the source and criterion for the exact
  purpose, scope, exclusions, and risk tier;
- qualification: whether the evaluator passed relevant held-out, adversarial, and boundary tests;
- calibration: whether confidence was empirically calibrated for the evaluator, criterion family,
  dataset version, and slice in use;
- independence: whether evidence paths differ in provider, base model lineage, implementation,
  author, labels, and organization; and
- freshness and coverage: whether sources and qualification remain current and whether the
  evaluator produced a result over the relevant population.

A verified signature or digest establishes integrity and possibly source identity, not correctness
or applicability. No dimension can silently substitute for another.

### Snapshot and qualify criterion sources

A criterion source is an immutable `SourceSnapshot`, not a URL or search result. It records the
canonical URI, publisher, document version, published/effective/retrieval/expiry times, content
digest and classified artifact reference, media type, source kind, licensing, supersession and
conflict links, identity-verification method, applicability scope, and approving principals.

When search is used, it creates a discovery record containing provider and tool version, exact
query, locale, time, filters, complete returned candidates and ranks, and selection or exclusion
reasons. A candidate remains `discovered` until ProofStack retrieves the underlying primary
document and verifies its publisher, exact version or snapshot digest, licensing, and
applicability. A ranking, snippet, cached answer, or generated synthesis cannot become a criterion
authority.

Conflicting and superseded primary sources remain counterevidence. A model cannot silently merge
them. If live search is part of an evaluation, it is an explicit `live_provider` boundary under
ADR-0013; default regression execution uses pinned source snapshots with network disabled.

### Version criteria and their applicability

A `CriterionSet` has an immutable identifier, version and digest; purpose and intended use; risk
tier; exact task, environment, locale, population, jurisdiction and exclusion scope; issuer and
approval references; source snapshots; assumptions; known limitations; change rationale; and
supersession lineage. Its status is `draft`, `qualified`, `approved`, `contested`, `superseded`, or
`withdrawn`.

Each criterion records:

- one bounded claim and a non-executable applicability expression in a reviewed safe language;
- severity, metric, direction, unit, threshold, and threshold rationale;
- required evidence classes and independent quorum;
- exact oracle and evaluator references;
- positive, negative, boundary, and not-applicable qualification fixtures; and
- known ambiguities, counterexamples, assumptions, and disqualifying conditions.

Changing any semantic field creates a new version. A criterion definition is data, never an
instruction that may authorize tools or modify platform policy.

### Prefer executable oracles without declaring them truth

An `OracleSpec` is versioned as `exact`, `schema`, `property`, `metamorphic`,
`reference_interpreter`, `reference_label`, or `rubric`. It records input and output schemas,
implementation and runtime digests, source revision, seed, clock, locale, dependencies, network
and side-effect policy, time and cost limits, result semantics, qualification fixtures, and a
qualification report.

Deterministic executable oracles are preferred when the claim permits them. They still derive
their authority from a criterion and source lineage and can be contested. An oracle cannot qualify
itself, and support or derivation edges that create a cycle are rejected.

### Version and qualify every evaluator

An `EvaluatorSpec` is `deterministic`, `statistical`, `model_assisted`, `human_protocol`, or
`composite`. It binds supported criteria and output schema to exact implementation, runtime,
dependency, configuration, prompt, tool-schema, and model-provider versions. It also declares
reproducibility class, sandbox and data-egress policy, budgets, retries, supported scope, known
limits, qualification and calibration reports, and an independence group.

An independence group records at least provider, base-model family, fine-tune lineage, prompt
author, evaluator developer, label or data source, and organization. Different product names,
prompts, or samples do not count as independent when material lineage is shared.

Qualification is empirical and slice-specific. Model-assisted evaluators must be tested on held-out
positive, negative, boundary, and not-applicable cases; prompt injection and forged citations;
position swaps; length, style, authority, and bandwagon perturbations; self-provider preference;
repeated-sample variance; out-of-distribution abstention; malformed output; provider failure;
budget exhaustion; and preserved human-label disagreement.

Where a model compares a baseline and candidate, identifiers are blinded and both presentation
orders are evaluated. An order-sensitive result is disagreement, not a hidden retry. An independent
critic must produce its counteranalysis without seeing the first rationale; critique and original
are fixed before adjudication. Agreement after critique remains evidence, not proof.

### Preserve run outcomes, uncertainty, and disagreement

An `EvaluationRun` binds exact criterion, oracle, evaluator, dataset, case, replay, target,
environment, executor, and input-evidence digests. It records every predeclared attempt, seed,
budget, provider metadata, raw observation, score, evidence and counterevidence references,
out-of-distribution status, interval, sample count, and error reason.

Its verdict is exactly one of `pass`, `fail`, `abstain`, `not_applicable`, or `error`. The latter
three are not converted to zero, pass, or fail. Coverage includes all abstentions and errors.
Retry-until-pass is forbidden; every attempt remains visible.

Raw confidence is never labeled as correctness probability. A calibrated probability requires an
exact calibration-report reference bound to the evaluator digest, criterion family, dataset and
slice versions, sample count, method, measurements, and validity window. Distribution shift or an
expired or mismatched report invalidates that probability. Selective evaluators report risk versus
coverage, not accuracy only.

An explanation from a model is not evidence by itself. It becomes a link only when it points to an
actual trace span, artifact, executable oracle observation, or verified source snapshot.

### Keep assessment eligibility separate from release decisions

An `Assessment` retains every relevant run, the predeclared aggregation-policy digest, evidence
classes and independence groups, quorum, distributions, intervals, coverage, disagreement,
minority findings, critical conflicts, assumptions, and counterevidence. Its status is `supported`,
`contradicted`, `inconclusive`, or `invalid`.

It separately reports whether the evidence is `eligible` or `ineligible` for a downstream policy,
with reasons. Invalid provenance, insufficient independent quorum, expired or out-of-distribution
calibration, high unresolved disagreement, or critical counterevidence makes it ineligible.
Eligibility means only that Workflow 2 may consider the evidence.

For a high-impact claim, eligibility requires an approved applicable criterion, verified source
identity, current qualification, required evidence classes, at least one non-model evidence path,
and an independent human review. One model-judge result can never satisfy quorum. A conflict
between an applicable executable oracle and model judgments cannot be erased by model majority;
the assessment remains contradicted or inconclusive until the conflict is resolved.

A `HumanReviewRecord` contains the authenticated reviewer, role and expertise, declared conflicts
and relationships, exact evidence and assessment digests reviewed, action, rationale, timestamp,
expiry, and supersession link. Human judgment is appended as evidence; it never overwrites a run.
A policy can require multiple independent reviewers without changing the underlying assessment.

## Consequences

### Positive

- Criteria authors, official publishers, search systems, evaluators, models, and humans all remain
  reviewable rather than implicitly infallible.
- Separate trust dimensions expose why evidence is or is not usable.
- Qualification, calibration, abstention, and disagreement make model-assisted evaluation
  measurable instead of rhetorical.
- Search can broaden source and counterexample discovery without becoming a hidden authority.
- Workflow 2 receives structured evidence while retaining explicit responsibility for release
  policy and exceptions.

### Negative

- Creating a qualified criterion requires source, fixture, calibration, and review work.
- Many assessments will correctly remain inconclusive instead of producing a convenient score.
- Independence and applicability require organization-specific declarations that software cannot
  infer completely.
- Source snapshots introduce licensing, retention, freshness, and conflict-management duties.
- Calibration does not automatically transfer across models, tasks, languages, or populations.

### Follow-up

- Define bounded contracts for sources, criterion sets, assurance edges, oracles, evaluator specs,
  qualification and calibration reports, runs, assessments, and human reviews.
- Publish a safe applicability language rather than executing criterion-supplied code.
- Add acyclic-graph, exact-lineage, provenance, independence, abstention, coverage, and
  eligibility property tests.
- Implement deterministic and statistical evaluators before model-assisted evaluators.
- Add a model-judge qualification corpus and publish raw slice and calibration measurements.
- Keep Workflow 2 release policies and decisions in separate types and storage.

## Alternatives considered

### Trust the operator who wrote the criterion

Rejected because authorization to propose a business rule does not prove that the rule is correct,
current, applicable, or empirically measurable.

### Ask a search engine or model to generate the correct standard

Rejected because discovery rank and generated synthesis are unstable secondary evidence without
publisher identity, exact version, scope, or guaranteed completeness.

### Collapse assurance into one trust or quality score

Rejected because integrity, authority, applicability, qualification, calibration, independence,
freshness, and coverage are not interchangeable quantities.

### Use a panel of model judges as ground truth

Rejected because apparently different judges can share provider, model, data, rubric, and bias,
and consensus does not resolve a wrong criterion.

### Let Workflow 1 approve a release

Rejected because evidence generation and policy enforcement have different authority, failure,
availability, and audit requirements.

## Evidence informing this decision

- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) separates entities, activities, agents,
  derivation, attribution, and plans while treating provenance as input to trust judgments rather
  than truth itself.
- [ISO/IEC/IEEE 15026-2:2022](https://www.iso.org/standard/80625.html) and
  [OMG SACM 2.3](https://www.omg.org/spec/SACM/2.3) define assurance cases around claims,
  argumentation, evidence, assumptions, and context.
- [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
  demonstrates immutable subject identity through digests without claiming the statement's
  predicate is automatically correct.
- [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/) and
  [NIST AI 600-1](https://doi.org/10.6028/NIST.AI.600-1) require context-specific measurement,
  documented limitations, multiple evaluation methods, source verification, and independent human
  review.
- [Zheng et al.](https://arxiv.org/abs/2306.05685) document position, verbosity, and
  self-enhancement bias in model judges, while
  [Wang et al.](https://arxiv.org/abs/2305.17926) motivate order balancing, multiple evidence
  paths, and human involvement.
- [Guo et al.](https://proceedings.mlr.press/v70/guo17a.html) distinguish raw confidence from
  empirical calibration, and
  [SelectiveNet](https://proceedings.mlr.press/v97/geifman19a.html) evaluates abstention through
  selective risk and coverage.

## Revisit when

- a regulated domain requires a different formal assurance-case representation;
- cryptographic publisher attestations or transparency logs become a supported source boundary;
- measured evaluator behavior justifies new independence or calibration rules;
- a safe criterion expression language proves too limited for required applicability; or
- Workflow 2 introduces a policy type that needs additional evidence-eligibility fields.
