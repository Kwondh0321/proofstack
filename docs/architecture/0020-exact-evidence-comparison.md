# ADR-0020: Compare exact evidence without making release decisions

Status: Accepted
Date: 2026-09-02
Owners: ProofStack maintainers

## Context

Workflow 1 can now retain immutable regression inputs, captured interactions, bounded replay
execution, non-model evaluation, model-assisted evaluation, counterevidence, and accountable human
review. Those records answer what happened and whether one bounded assessment has sufficient
assurance for its declared use. They do not provide an exact comparison between a baseline and a
candidate.

A comparison assembled from mutable aliases or client-supplied summary numbers would sever the
lineage already established by Workflow 1. A comparison based only on averages could hide missing
fixtures, abstentions, errors, order effects, minority findings, different units, different
criteria, changed datasets, or incompatible calibration populations. A candidate with fewer
reported cases could appear better merely because its difficult cases disappeared. A UI could
also turn a descriptive delta into an accidental release decision if it labels a candidate as
approved, safe, or ready.

Trace structure, replay usage, evaluator outcomes, artifacts, and assurance evidence currently
live in different authoritative repositories. Some sources are exact content-addressed records;
others are append-only job histories that become complete only after terminal state. Comparison
therefore needs a server-derived, immutable evidence snapshot rather than a late-bound projection
over whichever state happens to be current.

## Decision

### Publish an exact comparison definition

ProofStack will publish an immutable `ComparisonDefinition` before deriving a result. It binds:

- one exact baseline subject and one exact candidate subject;
- exact dataset version identities and definition digests;
- terminal replay jobs and attempts mapped to exact fixture versions;
- exact non-model and model-assurance assessment references;
- a finite ordered metric specification with units and aggregation methods;
- the fixture-pairing rule, missingness treatment, strata, confidence method, and minimum coverage
  needed to describe comparability;
- the source time boundary and classified-content handling rule; and
- the creator, server time, schema version, predecessor, and canonical definition digest.

The labels `baseline` and `candidate` are roles in one comparison, not mutable aliases. The public
request cannot supply server-derived evidence, deltas, comparability, timestamps, or release
semantics. Changing either subject or any calculation rule creates a new exact definition.

### Freeze source-backed subject snapshots

Comparison creation resolves all referenced state in the authenticated scope and records one
immutable `ComparisonEvidenceSnapshot` for each side. A snapshot preserves enough exact source
references and extracted values to reproduce every displayed field without consulting mutable
latest state. It includes, where requested and available:

- ordered fixture membership and pairing keys;
- trace event and status structure derived from the exact fixture snapshots;
- terminal replay outcomes, usage dimensions, measurement source, and unavailable reasons;
- exact evaluator verdict counts, measurements, intervals, coverage, abstentions, and errors;
- model-assurance eligibility, calibration availability, human-review state, disagreement,
  counterevidence, and known limitations;
- exact artifact references, classifications, sizes, content digests, and availability state; and
- extraction omissions with machine-readable reasons.

The snapshot never copies artifact plaintext into comparison JSON. It does not reinterpret a raw
model confidence as calibrated probability. Estimated, measured, provider-reported, and
unavailable usage remain distinguishable. Nonterminal replay state, unresolved lineage, digest
mismatch, cross-scope input, or an over-limit source fails snapshot publication rather than
silently dropping evidence.

### Pair first, aggregate second

The reference comparison pairs cases by exact logical fixture identity and retains the exact
baseline and candidate fixture-version references. Every requested case is classified as paired,
baseline-only, candidate-only, or invalid before any aggregate is calculated. Duplicate pair keys
are rejected. A changed fixture version is visible and cannot masquerade as the same physical
observation.

Aggregates preserve their numerator, denominator, missing count, abstention count, error count,
unit, method version, and source references. Statistical intervals are reported only when their
declared assumptions are supported. Incompatible units, methods, criteria, populations,
calibration slices, or denominators produce `incomparable` or `unavailable`; they are never coerced
or assigned a zero delta.

### Derive descriptive differences without policy

An immutable `ComparisonResult` binds the exact definition and both evidence snapshots. It may
report:

- signed exact deltas and direction-neutral states such as `increased`, `decreased`, `unchanged`,
  `unavailable`, or `incomparable`;
- paired outcome transitions and complete marginal counts;
- distribution summaries with explicit methods and sample counts;
- latency, token, byte, request, tool-call, and provider-cost usage;
- policy-independent safety-event counts and exact source references;
- artifact additions, removals, unchanged content, and unavailable content;
- coverage, missingness, uncertainty, counterevidence, disagreement, and limitations; and
- overall comparability with exact reasons.

The result cannot contain `pass`, `fail`, `approve`, `reject`, `safe`, `unsafe`, `release`, or a
threshold verdict. Metric direction and risk tolerance belong to later versioned policy. An
increase in a descriptive number is not automatically an improvement or regression.

### Keep comparison authority separate from release authority

Comparison definitions, evidence snapshots, and results use a management capability that cannot
grant workload capabilities, publish human reviews, change source evidence, approve policy, or
authorize deployment. PostgreSQL grants and forced row-level security backstop the HTTP
authorization boundary. All records are append-only, conflict-detecting, tenant-scoped, included
in coordinated recovery, and published with atomic outbox intent.

The operator view reads only the exact comparison result and referenced evidence available to the
authenticated principal. It shows source identity, units, denominators, missingness, uncertainty,
and comparability adjacent to every delta. It does not recompute authoritative values in the
browser, fetch a mutable latest alias, expose classified plaintext, or render a release control.

## Consequences

### Positive

- A displayed delta is reproducible from immutable, exact-version source references.
- Missing candidate evidence cannot improve a score by disappearing from the denominator.
- Pairwise and aggregate views retain abstentions, errors, disagreement, and uncertainty.
- Operators can inspect trace, outcome, cost, latency, artifact, and safety evidence without
  turning the comparison service into a policy engine.
- A later release policy can consume one exact comparison result without changing its meaning.

### Costs and limitations

- Comparison records duplicate bounded extracted values and references to remain stable after
  source state advances.
- Exact paired comparisons require compatible fixture identity; unrelated datasets may be only
  partially comparable or incomparable.
- The first implementation supports declared finite methods rather than arbitrary SQL or user
  code.
- Descriptive evidence does not determine the correct business objective, acceptable risk, or
  causal effect.
- Statistical validity remains conditional on explicit sampling and independence assumptions.

## Rejected alternatives

### Compute the UI directly from current repositories

Rejected because job histories, artifact availability, and source aliases can change after an
operator first views them, making the displayed comparison unreproducible.

### Accept client-computed summaries

Rejected because the client could omit hard cases, change denominators, mix units, or fabricate
source lineage.

### Compare only aggregate model-judge scores

Rejected because one score hides fixture pairing, calibration scope, non-model evidence,
abstention, error, disagreement, and human-review state.

### Label increases as improvements in the comparison layer

Rejected because desired direction and tolerances are policy decisions and may vary by use case,
risk tier, and accountable authority.

### Store only a rendered report

Rejected because a report without machine-readable exact sources, methods, and missingness cannot
be independently verified or safely consumed by later policy.
