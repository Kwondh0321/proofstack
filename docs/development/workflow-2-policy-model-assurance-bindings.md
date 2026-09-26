# Captured model and human assurance bindings

[English](workflow-2-policy-model-assurance-bindings.md) | [한국어](workflow-2-policy-model-assurance-bindings.ko.md)

Status: internal inspection of retained model-assurance assessment prerequisites. Workflow 2
checkpoint 3 remains open, with **2/7** checkpoints accepted. This does not issue eligibility,
approval, a policy result, a sealed snapshot or a release decision.

## Composition boundary

`capturePolicyRecordGraph` now returns a `modelAssurance` report after its retained evaluation
snapshot inspection. The fixed internal inspector consumes only that capture's validated records,
exact parent-bound edges and evaluation reports. It performs no additional repository I/O, model
invocation, search, artifact-content read or publication. Only its report types are exported from
the package root; callers cannot submit an arbitrary graph through a public inspector.

Each verified `model_assurance_assessment` produces checks with `matched`, `mismatch` or
`unavailable` observations. The report preserves its original full-record hash and indexes into the
original graph edges, including nested qualification, observation and reviewer-independence edges.
An unreadable assessment retains its exact original reader observation in `unavailableParents`.
There is no aggregate success/eligibility field.

## Historical time, not current release authority

The inspection asks whether the recorded prerequisites support the assessment **at its stored
`evaluatedAt`**. It does not substitute the current worker time or request `evaluationTime`.
Changing the capture time alone must not rewrite a historically coherent assessment as an invalid
historical record. Current policy-time applicability and authority still need separate checks.

The existing model/human contracts admit UTC millisecond timestamps. Their owning qualification,
calibration, blinding, critique and quorum algorithms are reused with the assessment's validated
millisecond timestamp; a policy timestamp with finer precision is never truncated into those
algorithms. Additional receipt and validity comparisons use `policyEvaluationTimestampOrderKey`.
Dependency receipts must be no later than assessment evaluation, evaluation must be no later than
its receipt, and the declared assessment validity must not extend past its inspected prerequisites.
Qualification and review expiry are exclusive. Acquisition still independently enforces the request
receipt cut and keeps future/unreadable records unavailable.

## Checks

| Area | Retained relationship inspected |
| --- | --- |
| Base assessment | Exact base eligibility, current declared source freshness, risk tier and the existing evaluation-history/run-definition report. Unknown or contradicted base history remains a prerequisite, not a silently accepted base. |
| Non-model evidence | Nonempty selected observations and oracles, exact membership in the base assessment, and each selected oracle witnessed by a selected observation's exact run. |
| Primary and critic qualification | Existing qualification applicability against the exact suite, profile, independence declaration, calibration and blinded plan; qualified and current base qualification; calibration/base-report and suite/corpus references; evaluator/profile identity and supported criteria. |
| Calibration | Existing compatibility against the base aggregation dataset, exact criterion, evaluator, scope, risk tier and recorded locale/task/population context. An unavailable or shifted calibration is not usable merely because its hash matches. |
| Blinding | Existing plan/result integrity, seeds, presentation and attempt coverage, failures and disagreements; completed attempts' exact raw-observation verdicts and receipt ordering. Failed attempts remain in the owning integrity calculation. |
| Assurance lineage | Primary plan/report/suite profile, evaluator, independence and calibration agreement; review protocol risk and criterion coverage. |
| Independent critique | Existing coverage and independence integrity, produced supporting findings, exact selected non-model observation, critic qualification references and calibration compatibility. |
| Human review | Existing active-review quorum, roles, evidence, time, conflicts, independent groups and supersession. Each selected review must reference the base assessment and cover the selected observations and critiques. |
| Declared eligibility and validity | Retain an ineligible declaration as an unmet prerequisite; bound assessment validity by the inspected model, protocol, review and independence records. This does not reconstruct every stored reason or certify a maximal validity interval. |

The inspector evaluates required prerequisites, not whether every ineligible assessment was honestly
constructed. A correctly ineligible assessment can legitimately yield `mismatch` observations. Such
observations mean a prerequisite is unmet; they are not automatically evidence of forged records.

## Missing evidence and supersession

Known contradictions survive unavailable dependencies wherever the inspected inputs suffice.
Unqualified reports and active opposing reviews, for example, are not converted into matches when
another record is missing. An absent dependency is `unavailable`, never a fabricated empty success.
When some human independence declarations are missing, the existing quorum algorithm can still
establish active opposition or another independently decidable failure. Its independence-only
shortfalls do not establish failure of the missing declarations and remain unavailable.

Quorum uses the owning algorithm's exact supersession rules before considering opposition. A valid
replacement review does not inherit its predecessor's opposing action as an active veto. Both
records and dependency occurrences remain in the capture; no historical evidence is deleted. If
selected review records themselves are missing, active membership cannot safely be reconstructed.

Repository exceptions, broken parent hashes, duplicate edges, missing internal target nodes and
other broken capture provenance abort acquisition instead of manufacturing an unavailable record.

## Bounded inspection and verification

One reference-occurrence and canonical-reference-byte meter covers every assessment parent in this
inspection. Each dependency resolution is charged before use, including repeated nested and shared
records. Deduplicating human independence records for the owning quorum algorithm does not erase
their charged occurrences or graph edges. The existing evaluation report is reused rather than
recomputed with a reset budget. Owning schemas bound arrays and strings; this meter is not a CPU
timer or a count of every scalar comparison or schema parse. It is distinct from acquisition and
artifact-transfer accounting.

Tests publish joined, rehashed records to the real memory evaluation, model-assurance and candidate
repositories. They exercise coherent inputs, schema-admitted cross-record contradictions, missing
model and non-model prerequisites, receipt cuts, storage errors, superseded opposition, millisecond
expiry boundaries, shared dependencies across multiple assessments, exact cumulative limits,
original provenance and defensive copies. Separate internal tests corrupt graph structure to ensure
the private composition boundary aborts. Unrelated upstream roots remain explicitly unavailable in
these fixtures; these tests do not claim whole-graph policy acceptance.

## Remaining work

Local matches do not certify provider execution, model capability, reviewer expertise, actual
independence, truthful artifacts or measurements, numerical calibration metrics, current source and
installation authority, or policy-time eligibility. Dataset, replay, comparison, artifact and
assurance observations must still be composed without losing missingness or contradicting recorded
evidence. Mutable-authority/revision guards, sealed inputs, deterministic policy outcomes, durable
jobs, API/SDK, recovery and end-to-end checkpoint acceptance remain open.
