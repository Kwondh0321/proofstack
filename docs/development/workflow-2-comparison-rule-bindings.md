# Candidate-owned comparison rule inputs

[English](workflow-2-comparison-rule-bindings.md) |
[한국어](workflow-2-comparison-rule-bindings.ko.md)

Status: retained comparison input bindings implemented; Workflow 2 checkpoint 3
remains open with 2/7 checkpoints accepted. These inputs are not policy results.

`capturePolicyArtifactEvidence` returns `comparisonRules` from the fixed internal
[`inspectCapturedComparisonRules`](../../packages/policy-evaluation/src/capture-comparison-rules.ts).
It revalidates exact request identity, scope, evaluation time and ordered roots,
full candidate/policy/comparison/result/snapshot bodies and receipt hashes, complete
parent references and every original edge. Missing observations require null bodies
and references, valid manifest observations and no invented outgoing edges.

## Complete inventory and original rules

The owning comparison selector and lineage reproducer run over validated retained
copies without additional repository, object or key I/O. Their complete inventory
and comparison reports must agree with this invocation's capture. Every candidate
member remains present, including unused and unreadable results. The implementation
does not select latest results or omit an unreadable member to obtain uniqueness.

Every comparison-bearing rule retains its original predicate, policy position and
edge, and index into this invocation's complete comparison capture. Repeated rules
remain separate. Missing, ambiguous or unresolved selection, unavailable records and
invalid lineage produce explicit unusable bindings. A genuinely absent metric has
`metric_missing`; changed captured evidence fails instead of becoming missingness.

## Exact descriptive operands

A verified metric binding retains definition/result/stratum positions and complete
original objects, including all fifteen role-specific sample counters, exact values,
unavailable/incomparable reasons and retained partial role values. It also retains
the original calculation policy, comparability, pairing, latest source cutoff and
full comparison/result/baseline-snapshot/candidate-snapshot hashes.

Threshold inputs describe exact metric-kind and unit compatibility. Safety inputs
add exact event-kind/event-class compatibility. Comparison sample/ratio coverage
preserves its original role counters and denominator declarations; `cases` and
`basis_points` are coverage units, not substitutions for a metric's measurement unit.
Incompatible inputs preserve their original evidence with explicit reasons. No
numeric predicate, overall safety score, approval or policy outcome is computed.

## Admission and remaining boundary

Complete inspected parent references, one complete inventory/context frame and
every original rule frame consume canonical UTF-8 count/byte admission. Repeated
rules are charged independently. The composer adds this usage to the same finite
invocation budget, shared with record bytes and all earlier inspection. Exact
limits pass; one below fails. Returned nested records belong to the report.

The function is internal; only the report type is exported publicly. No dependency,
role, grant, migration, route, worker or publication port is added. Complete upstream
semantic/current-authority closure, strict sealed snapshot/result contracts,
same-open-transaction snapshot/job/fence publication, all seven deterministic
predicates, durable jobs, API/SDK, recovery and independent checkpoint acceptance
remain required. A transaction that ended before returning a recheck report cannot
authorize later publication from these inputs.
