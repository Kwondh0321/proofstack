# Captured evaluation-to-replay bindings

[English](workflow-2-evaluation-replay-bindings.md) | [한국어](workflow-2-evaluation-replay-bindings.ko.md)

Status: retained cross-domain relationships; Workflow 2 checkpoint 3 remains open.

`capturePolicyRecordGraph` includes `evaluationReplays` for every acquired evaluation run,
including runs shared by several assessments. Independently valid run and plan records can name
different datasets or targets. The report joins each run's exact replay plan and terminal result
to the existing owning plan/result inspections without additional repository reads.

## Fixed checks

| Check | Meaning |
| --- | --- |
| `plan_dataset` | The retained plan's dataset reference exactly equals the run's dataset, including the definition digest. |
| `plan_target` | The retained plan's target equals the run's replay target, including adapter and worker protocol. |
| `plan_receipt` | The plan was recorded no later than the run's declared replay completion. Full timestamp precision is preserved. The owning result report separately checks plan receipt against job creation. |
| `plan_prerequisites` | The exact source/full-hash plan report has no contradicted checks or unavailable dependencies, including isolation records that are not independently summarized by a scalar plan check. |
| `result_history` | The exact source/full-hash result report agrees with the same retained plan observation and preserves its owning history checks, including earlier attempts and unavailable timing/accounting. |

A known contradiction takes precedence over unavailable prerequisites when summarizing one owning
report. Independent checks remain separate: a missing result cannot erase a known dataset mismatch,
and matching declarations cannot make missing plan dependencies available. Unreadable runs remain
in `unavailableParents` with their original observations. An empty inventory is not inferred from
a missing run. Broken internal edges, hashes, references or missing owning reports abort capture.

There is no one-plan-per-fixture requirement. A plan names a dataset and multiple boundary
declarations; several evaluation fixtures can share it. Dataset fixture membership and each
recorded boundary's own invocation/fixture checks remain in their existing owning reports.

## Provenance and admission

Each parent retains its exact source, full record hash and original dependency edge indexes.
Plan dataset/target edges keep the plan as their owner. Shared plans/results are read once by
graph acquisition, but each run's semantic reference occurrences and canonical bytes are charged
again. `inspectionUsage` is admitted against the same cumulative request count/byte limits before
the graph returns. Exact ceilings pass; overflow produces no partial successful report.

Owning plan/result summaries are indexed once; they are consumed rather than re-executed for each
run. Results are detached from inputs and deterministic under node insertion order. These counters
are not CPU, wire, process-memory or durable retry accounting.

Tests publish actual memory evaluation, dataset, replay definition and job records and use a
validated static runtime catalogue. The shared-plan fixture uses a declared simulation boundary;
recording its successful job history does not claim that a simulator actually executed. Tests
cover matching shared plans, foreign datasets/targets, missing parents/dependencies, contradictions
alongside missingness, exact sub-millisecond receipt boundaries, original edges/hashes, corrupted
provenance, detached results and repeated count/byte admission.

This report does not modify `evaluationSnapshots`, `candidateAssessmentLineage` or their earlier
scope. Complete closure must combine these reports with comparison, dataset/fixture, authority,
artifact and selector observations before sealing rule inputs. A matched retained relationship
does not prove execution, measured usage, installation authority, current source trust or a policy
outcome. No route, role, job scheduler, snapshot publication or release approval is introduced.
