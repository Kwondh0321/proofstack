# Captured evaluation run-definition bindings

[English](workflow-2-policy-evaluation-run-bindings.md) | [한국어](workflow-2-policy-evaluation-run-bindings.ko.md)

Status: the internal acquired-graph inspection now checks retained run definitions before their
result histories, aggregates and assessments. Workflow 2 checkpoint 3 remains open. These are
recorded relationships, not installed execution authority, source trust, policy satisfaction or
permission to release.

## Why history integrity is insufficient

A consistent observation history can still describe the wrong evaluator, oracle, criterion or
qualification. The [snapshot inspection](workflow-2-policy-evaluation-snapshot-bindings.md) now
includes `evaluation_run` parents with `run_*` checks, and every result receives a separate
`run_definition` prerequisite. A local history match cannot erase a contradicted or unavailable run
definition. The existing aggregate and assessment prerequisites propagate that distinction.

The implementation consumes only the fixed readers' already verified records and parent-bound
edges from the same capture. It is not a public arbitrary-graph inspector and makes no additional
repository calls, executes no evaluator or oracle, and fetches no replacement evidence.

## Fixed checks and their limits

| Relationship | Inspection |
| --- | --- |
| Criterion | The exact criterion set contains the requested criterion, and its evaluator/oracle references equal the run's declarations. |
| Applicability | Recompute canonical context SHA-256, reject an explicit environment different from the run scope, and use the existing bounded `evaluateApplicability` interpreter to compare the retained result with the selected criterion expression. An undetermined derivation cannot corroborate an applicable/not-applicable claim. |
| Criterion receipt | The set was published no later than the recorded applicability evaluation. |
| Recorded criterion status | The exact referenced status names this criterion version, declares approval, and has been recorded and become effective by run creation; optional expiry is exclusive. This is not a search for newer status events or a current authority decision. |
| Aggregation and sources | The exact aggregation policy names the run's dataset and predates the run. The run retains the exact set of source-review references declared by the criterion set; matching references do not establish those reviews' authority. |
| Evaluator/oracle specifications | Each supports the selected criterion version, was published by run creation, and the evaluator names the exact oracle used by the run. |
| Attempt ceilings | Every declared attempt's elapsed-time, input, output and memory ceilings fit both specifications. Runtime enforcement, actual usage and installed implementations remain separate boundaries. |
| Qualification subject/corpus | The referenced report names the exact evaluator or oracle; its fixture-set reference equals that specification's declaration. |
| Qualification cases | The report covers every declared corpus case with matching case identity, kind and expected outcome. Every criterion qualification fixture has an exact corpus fixture, criterion selector, case kind and expected verdict; neither a same-name fixture nor a smaller favorable case set suffices. |
| Qualification declarations/time | The report declares qualified, was recorded/completed by run creation, and is valid at creation under a half-open interval. The subject and fixture corpus were published by the report's start. This does not prove actual execution, empirical competence or independence. |

All temporal comparisons use `policyEvaluationTimestampOrderKey`, preserving every supported
fractional digit and offset. Database cursor rounding, `Date.parse` of fractional timestamps and
worker wall-clock substitution are not used. Qualification corpus membership is indexed by its
schema-unique fixture version, avoiding a criterion-by-corpus quadratic search.

## Missingness, provenance and bounded work

Each independently decidable check survives other missing dependencies. Missing specifications,
criterion sets, statuses, reports or corpora remain `unavailable`; a known contradiction remains
`mismatch` even alongside unavailable evidence. A missing criterion in a verified set is a mismatch,
not a successful empty match. Invalid/future source records keep their original graph observations.
Repository failures and broken internal provenance still abort acquisition.

Run reports preserve the original full record hash and graph edge indexes, including qualification
corpus edges whose real parent is the qualification report. Shared records do not invent edges from
the run itself. The single snapshot-inspection meter charges each repeated dependency before use,
including the same report/corpus inspected for another run. Result prerequisites refer to the exact
run report without re-running it or resetting the meter. Assessment nested validation remains charged
as documented by the snapshot inspector. No new source/body-size or transport limit is substituted.

## Verification and remaining work

Actual memory-repository graph tests cover coherent definitions, propagated contradictions, all
four budget dimensions for both specification kinds, missing dependencies, known mismatch plus
missing evidence, original hashes/edges, read counts, cumulative inspection ceilings and exact
sub-microsecond expiry boundaries. Same-version identity forks are rejected by acquisition itself;
separate domain-rule unit cases test unequal reference comparisons without confusing those layers.
Test vectors are joined before hashing/publication; production readers are not relaxed for them.

Local matches do not establish current criterion/source/reviewer authority, qualification-policy
registration, implementation installation, retained artifact availability, fixture/replay meaning,
independence, numerical interval correctness or the truth of recorded measurements. Existing
dataset/replay/artifact/comparison reports must still be combined with these observations. The
subsequent [model and human assurance inspection](workflow-2-policy-model-assurance-bindings.md)
adds retained prerequisite checks, not full closure. Mutable authority/revision guards, sealed inputs,
deterministic policy results, durable jobs, API/SDK, recovery and end-to-end checkpoint acceptance
remain open. The accepted Workflow 2 checkpoint count remains **2/7**.
