# Captured candidate assessment lineage

[English](workflow-2-candidate-assessment-lineage.md) |
[한국어](workflow-2-candidate-assessment-lineage.ko.md)

Status: request-owned retained lineage inspection; Workflow 2 checkpoint 3 remains open.

`capturePolicyRecordGraph` includes `candidateAssessmentLineage`. An assessment can be declared by
a candidate and still describe another dataset or target release. This report follows every
candidate evaluation/model-assurance declaration, including unused and unreadable members, through
the exact base assessment, aggregate, aggregation policy and aggregate runs. It performs no new I/O.

## Exact retained relationships

The report binds the original request's candidate reference and full captured record hash. An
unreadable candidate produces `candidate_unavailable` with its original observation, not an empty
successful member inventory. Each member retains its declaration edge, record observation,
ordered repeated dependency edge indexes and individual checks. The policy need not be readable
to inspect the candidate's declarations; rule-to-candidate membership remains a separate report.

For each available assessment, `assessment_history` consumes the owning evaluation-snapshot
report at the same exact source and full record hash. It propagates recorded run-definition,
criterion, result, aggregate and assessment consistency. Model-assurance declarations first
consume their owning model/human report as `model_assurance_history`, then traverse the original
`baseAssessment`. A shared base is inspected for every declaration; no convenient alternative
assessment or aggregate is selected. Known contradictions and unavailable histories remain distinct.

The aggregation policy's dataset and every available aggregate run's dataset must exactly match a
candidate dataset declaration, including its definition digest. Each run's retained replay target
must exactly match the candidate target, including adapter and worker protocol. Original candidate
and upstream edges are retained for these joins. Each run fixture must occur exactly in its retained
dataset's complete fixture list. Record availability is reported separately: matching a declaration
does not make a missing dataset, fixture or target available. Empty aggregates retain their observed
empty frontier and an unavailable target-lineage check; they do not invent a run or target.

## Admission and limits

Each traversed record occurrence consumes an additional reference and its canonical UTF-8 bytes,
including repeated candidate dataset/target joins and shared base assessments. `inspectionUsage`
is added to the graph's shared request reference and byte budget before return. Provenance errors
and exhausted limits fail wholly. The internal inspector accepts only the fixed composition's
captured graph and owning reports; it is not a public caller-supplied snapshot endpoint.

These observations do not establish complete semantic/source-authority closure, retained artifact
availability, current lifecycle/qualification authority, replay execution, a policy outcome or
snapshot sealing. In particular, assessment histories describe recorded relationships and times;
they do not grant current trust or publication authority. Dataset/predecessor, fixture ownership,
replay-plan/result, artifact and policy-authority reports remain required dependencies. Future
closure must join all of them and close mutable logical roots, absences and selectors before
freezing rule operands. The [source recheck](workflow-2-policy-source-recheck.md) still ends its
read-only transaction before returning and cannot authorize publication after releasing guards.

Regression tests use actual memory evaluation, dataset and replay repositories. They cover matching
histories, foreign candidate datasets/targets, readable non-member fixtures, empty aggregates,
missing/invalid/future references, unavailable roots, model/base sharing, owning-history failures,
graph/report provenance corruption, defensive output and exact/one-below count and byte admission.
No new public route, role, job, release approval or checkpoint acceptance is introduced.
