# Candidate-owned assessment rule inputs

[English](workflow-2-assessment-rule-inputs.md) |
[한국어](workflow-2-assessment-rule-inputs.ko.md)

Status: retained assessment inputs implemented; Workflow 2 checkpoint 3 remains
open with 2/7 checkpoints accepted. These inputs are not evaluation results.

`capturePolicyArtifactEvidence` returns `assessmentRules` from the fixed internal
[`inspectCapturedAssessmentRules`](../../packages/policy-evaluation/src/capture-assessment-rules.ts).
It owns a captured copy, checks exact request identity/scope/time/ordered roots and
revalidates every original record, receipt hash, complete parent reference and edge
through fixed domain inspectors. Missing bodies/references stay null, observations
must satisfy the strict manifest contract and missing parents have no outgoing edges.

The existing policy assessment inventory, evaluation snapshots, model-assurance
checks and candidate assessment lineage are independently reproduced without I/O.
Complete reports must agree with the original capture. Every candidate declaration
remains present, including unused/unreadable members. Every assessment-bearing rule
retains its original predicate, policy position/edge and exact candidate membership.
A readable policy-only assessment has `not_declared`, not candidate-owned operands.

## Three descriptive input families

- Assessment coverage maps `observed` only to original aggregate `attemptedCount`
  and `decided` only to `decidedCount` (pass plus fail). All nine counters and complete
  original members remain in the exact hashed aggregate. Abstain/error/not-applicable
  members are not dropped or renamed as decisions. Missing aggregate counts are null,
  distinct from a genuinely reported zero.
- Uncertainty retains the owning aggregate, aggregation policy, sampling assumption
  and original `passInterval`. It selects the requested original lower/upper bound
  and describes method/version/confidence/assumption compatibility. Not-reported
  interval reasons and incompatible reported bounds remain visible. It never derives
  a different interval to satisfy a requested threshold.
- Eligibility retains the evaluation assessment's structured eligibility and all
  original dimensions, or the distinct model-assurance eligibility enum, original
  reasons and exact base assessment. Missing assessment evidence remains explicit.

Every retained input binds its original full assessment hash and prerequisite indexes
into this invocation's reproduced candidate/snapshot/model reports. These indexes
must not be applied to a different capture. Reported counts, intervals and eligibility
can coexist with mismatched or unavailable prerequisite checks. `inputs_retained`
describes retained evidence; it does not certify usable or currently qualified inputs.

## Admission and remaining boundary

Full original reference reinspection, all four owning report reproductions, complete
inventory/context and every repeated rule frame share finite canonical UTF-8 count/
byte admission with earlier capture and record bytes. Exact limits pass and one below
fails. Reports own their nested copies. No additional repository/object/key I/O,
dependency, role, grant, migration, route, worker or publication port is introduced;
only the report type is public.

`authorityBoundary` is `retained_inputs_only`. Complete semantic/current authority
closure, strict sealed snapshot/result contracts, same-open-transaction snapshot/job/
fence publication, all seven deterministic predicates, durable execution, API/SDK,
recovery, contributor acceptance and independent checkpoint exit audit remain.
An ended source-recheck transaction cannot authorize later publication from this report.
