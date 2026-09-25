# Captured comparison evidence

[English](workflow-2-policy-comparison-capture.md) |
[한국어](workflow-2-policy-comparison-capture.ko.md)

Status: comparison acquisition and direct-lineage integration implemented; Workflow 2 checkpoint 3
remains open. This is not policy evaluation or release authority.

## One acquisition, complete selection

`capturePolicyComparisonEvidence(request, repositories)` in `@proofstack/policy-evaluation` owns a
validated request before asynchronous I/O and calls the bounded
[record graph collector](workflow-2-policy-evaluation-record-graph.md). It accepts authorized
read-only repository ports, not an arbitrary prebuilt graph, caller-selected roots, comparison
result, or plug-in validator. Authorization must be supplied by the future trusted worker composer;
the function does not authenticate callers or acquire policy authority.

The collector preserves the graph and its acquisition usage even when the returned comparison
evidence is incomplete. A thrown storage, acquisition-budget, or graph-integrity error aborts the
operation; it is not represented as ordinary missing evidence or a successful partial inventory.
Missing or unavailable roots return `roots_unavailable` with exact observations and no inventory.

With verified candidate and policy roots, every candidate-declared result is selected from the
captured nodes, in candidate order. `resolveCapturedPolicyEvaluationComparisons` in
`@proofstack/core` verifies that complete list, exact source identities, and strict observations.
It reinspects verified bodies with the fixed control-record validator and checks their original
full-record hashes, including receipts. Missing and unavailable bodies must be null, but their
observations remain distinct: `record_invalid`, `reference_mismatch`, and `not_yet_available` are
never silently changed to `missing`. This pure integrity check cannot prove acquisition provenance;
the higher-level operation supplies records from its own acquisition.

Selection retains the existing `latestSourceCutoff` historical check. The owning result contract
already requires the source cutoff to precede or equal its receipt, so a future cutoff with an
earlier receipt is `record_invalid`, even if its semantic hash was recomputed. A valid record whose
receipt is after the evaluation time remains `not_yet_available`. Neither becomes ordinary absence.

## Explicit outcomes, no fallback result

`inventory_captured` means that a complete inventory was classified, not that every comparison
passed. Its `comparisons` array has one entry per distinct exact policy comparison, in inventory
order. Multiple policy rules referring to the same exact comparison share this entry.

| Comparison status | Evidence retained |
| --- | --- |
| `selection_unresolved` | Original `missing`, `ambiguous`, or `unresolved` selection, including known matches and unreadable members where applicable |
| `records_unavailable` | Unique selection plus exact missing/unavailable definition and baseline/candidate snapshot observations |
| `lineage_invalid` | Unique selection plus the fixed direct-lineage validator's typed failure reason |
| `lineage_verified` | Unique selection and exact re-derived result, definition, two snapshots, inventory, and direct source references |

A unique result is possible only after every candidate comparison member is verified. Only then
does the operation pass captured raw bodies to the existing
[lineage validator](workflow-2-policy-evaluation-comparison-lineage.md), without another repository
read. That validator checks exact identities, scope, receipt chronology, snapshot subjects,
candidate-owned datasets, targets and assessments, and derives the complete result again from its
retained definition and snapshots. A schema-valid result with a freshly recomputed definition hash
can still fail this derivation. The second inventory must equal the original captured inventory.
Only typed lineage failures become `lineage_invalid`; unexpected implementation errors propagate.

## Verification and limits

Focused tests cover exact memory-repository acquisition, no rereads, request mutation during I/O,
zero/one/multiple matches, unreadable members, absent and corrupt roots, missing/corrupt/future
prerequisites, semantic cutoffs, wrong scopes, full-record hash substitution, validly rehashed false
results, impossible chronology, storage failure propagation, and acquisition-budget exhaustion.
The synthetic fixture joins exact comparison subjects and re-derives its result before publication;
unimplemented descendant acquisition is explicitly represented by missing repository records.
These are not live-provider, PostgreSQL policy-worker, or end-to-end release tests.

`lineage_verified` validates only the direct comparison boundary. The retained graph may still have
unresolved downstream records, declarations, trace selectors, and artifact references. No aggregate
pass verdict or sealed snapshot is emitted. The higher-level
[exact trace capture](workflow-2-policy-trace-capture.md) adds parent-bound event acquisition and
content-reference occurrences under the same budget; this comparison-only entry point stays
metadata-only. Complete cross-record semantic closure, artifact bytes, mutable authority/lifecycle
acquisition and race guards, snapshot sealing,
deterministic policy predicates, job-wide durable accounting, authorized worker persistence,
API/SDK, recovery and end-to-end acceptance remain open. Acquisition budgets remain invocation-local
metadata limits, not a semantic CPU deadline, wire-memory limit, or persistent retry ledger.

The roadmap remains two accepted Workflow 2 checkpoints out of seven.
