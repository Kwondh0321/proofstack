# Captured evaluation snapshot bindings

[English](workflow-2-policy-evaluation-snapshot-bindings.md) | [한국어](workflow-2-policy-evaluation-snapshot-bindings.ko.md)

Status: retained run-result, aggregate and assessment relationships are checked during record graph
acquisition. Complete semantic closure, source authority, guarded sealing and Workflow 2 checkpoint
3 remain open. No evaluator, oracle or replay target is executed by this inspection.

## Record integrity is not relationship integrity

The fixed readers validate each exact record and its full canonical hash. Individually valid
records can still disagree: an observation can name an undeclared attempt, a result can omit an
observation, two aggregate members can count the same fixture, or an assessment can report coverage
that its actual aggregation policy does not support.

The graph now retains `evaluationSnapshots`. Its internal composer uses the current invocation's
already acquired nodes and parent-bound edges. It is not exported as a public arbitrary-graph
validation API. It performs no extra repository reads and does not trust a caller-selected result,
latest alias, replacement observation, statistical method or reduced denominator.

## Fixed domain rules

The composer uses the existing owning contracts, rather than a second implementation of their rules:

| Check | Fixed contract and scope |
| --- | --- |
| `run_history` | `EvaluationRunSnapshotSchema`: exact run and observation history, contiguous predeclared attempts, budgets, chronology, declared error retries, terminal reason and preserved final verdict |
| `aggregate_snapshot` | `EvaluationAggregateSnapshotSchema`: exact policy/run/result/criterion/dataset references, member verdicts, distinct fixture versions, chronology, method and retained interval metadata |
| `assessment_snapshot` | `AssessmentSnapshotSchema`: exact aggregate, policy, complete run/observation lists, qualification/review references, risk tier, independence-group declarations, coverage and statistical-assumption dimensions |
| `aggregate_history` | The aggregate snapshot check together with all its member run-history checks; an established mismatch is retained even when another member is unavailable |

Every available run result receives a history check. An aggregate retains both its local snapshot
check and a separate history check for each result member. An assessment retains its local snapshot
check and the aggregate-history prerequisite. A favorable local snapshot cannot erase an earlier
failed history. Known mismatches and unavailable child reports remain separately inspectable even
when a prerequisite summary is already a mismatch.

A complete retained snapshot is required for its corresponding domain check. Missing inputs yield
`unavailable`, not a smaller successful snapshot. A record-level invalid or future observation keeps
its original graph reason; it is not rewritten as missing. An unreadable parent is listed under
`unavailableParents`, not a successful empty check list. Repository failures abort acquisition.

## Provenance, ordering and bounded work

Each parent report preserves its exact source, full original `recordSha256`, ordered checks and
`dependencyEdgeIndexes` into the enclosing graph. Those edges retain the original parent hash,
JSON pointer, exact child source and any selector failure. Assessment dependencies also include
the original aggregate edges used by its nested snapshot, without pretending they originated in
the assessment. An ID-only run selector with no resolved child retains its explicit unresolved
edge; no digest or missing node is invented. Broken internal edges fail acquisition.

The three passes are run results, aggregates, then assessments; parents within a pass are ordered
by their unique source key. Reports are detached from graph inputs. Inspection is repeatable for
the same captured graph regardless of node insertion order.

`inspectionUsage` counts dependency occurrences and their canonical reference bytes across the
entire inspection. The request's acquisition reference/byte ceilings also bound this separate
in-memory inspection meter. Each assessment revalidates its nested aggregate through the fixed
schema, so the repeated aggregate frontier is charged again **before parsing**, even if storage
acquisition was shared. Exact ceilings are accepted; overflow throws without a partial report.
This does not reset the shared acquisition meter, account for external transfers or replace future
durable job-wide retry/work accounting.

## Verification and limits

Tests publish actual memory-repository records with coherent chronology and distinct fixtures,
then preserve valid individual digests while substituting cross-record relationships. They cover
attempt identity, usage limits, receipt order, verdict disagreement, omitted observations, terminal
reasons, duplicate fixtures, dataset/interval metadata mismatches, missing assessment members and
coverage conflicts. They also check missing/invalid/future inputs, mixed unavailable and invalid
histories, exact read counts, original hashes, detached output, ordering, repeated-work ceilings,
internal provenance failures and storage-error propagation.

These are retained snapshot relationships, not a claim that evaluator/oracle implementations were
executed correctly, an observed value is true, statistical assumptions are justified, interval
bounds were independently recomputed, or reviewers/independence/source declarations are authoritative.
Run-to-criterion/evaluator/qualification bindings, model/human assurance relationships, artifact
ownership/content, mutable authority and revision guards still need their own checks. The existing
dataset, replay, comparison, trace and artifact reports must be combined, not replaced by one
snapshot match. Sealing, deterministic policy results, durable jobs, API/SDK and end-to-end acceptance
remain open. Workflow 2 remains **2/7 accepted checkpoints**.
