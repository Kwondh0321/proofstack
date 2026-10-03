# Retained policy record closure

[English](workflow-2-policy-record-closure.md) |
[한국어](workflow-2-policy-record-closure.ko.md)

Status: separate retained-metadata derivation implemented; Workflow 2 checkpoint 3 remains open.

`capturePolicyRecordGraph` now derives `entries` in a second pass from the immutable request's
candidate and policy roots. The internal
[`deriveCapturedRecordClosure`](../../packages/policy-evaluation/src/derive-record-closure.ts)
does not accept the previously assembled manifest entries as its expected inventory. It reuses the
fixed owning validators and enumerators for all 44 source kinds, then reconstructs breadth-first
reachability and every original reference occurrence. This is a separate derivation pass, not an
independent implementation of those owning schemas or a third-party audit.

## Inventory and provenance

Each verified body is rechecked for scope, definition digest, receipt cut and complete original
record hash before its direct references are used. The derived references must equal the retained
parent inventory and original ordered edges. Missing, extra, duplicated, reordered, orphaned or
substituted records and edges fail. Shared records and ordinary backreference cycles remain valid;
each unique record expands once, while all repeated edge occurrences remain present.

The fixed pure `inspectPolicyEvaluationSelector` reuses the owning selector algorithm on retained
children. It checks criterion membership, reciprocal model-profile references, run identities and
comparison-family predecessors without another repository read. A missing selector that conflicts
with a verified exact child elsewhere in the same graph fails. A genuine membership mismatch may
coexist with an independently reached, verified criterion set and remains unavailable. No missing
selector receives an invented digest or a replacement version.

Unreadable parents retain `record: null` and `references: null`. A missing subordinate remains an
explicit manifest observation, not an omitted member or a verified empty leaf. The pass cannot
independently establish the truth of a repository's absence/unavailability observation from a
discarded body; protected reinspection at publication is still required.

`recordClosure.sources` is the sorted exact record inventory derived through those paths.
It can supply the expected **retained record** sources to the existing complete-page manifest
verifier. A self-consistent, correctly hashed subset still fails against that inventory. This does
not make the metadata manifest a complete guarded semantic snapshot.

## Explicit remaining frontier

`recordClosure.frontier` retains each non-record edge index with one of four categories:

- `artifact`: an exact content descriptor, whose bytes and lifecycle are observed separately.
- `trace`: the parent's exact retained event selector, not proof of whole-trace completeness.
- `unresolved_selector`: the original missing/unavailable record-selector observation.
- `retained_declaration`: parent-owned protocol, implementation, endpoint, qualification-policy,
  prompt/tool, source, model, safety-event, artifact-identity or requirement declarations.

The reference-kind inventory is exhaustive at typecheck. A retained declaration is not installed
code, provider identity, credential access, approval or verified content. In particular, an ID
from a deliberately omitted comparison artifact is not permission to fetch a current catalog
descriptor and resurrect the omission. Existing content/trace/semantic reports stay separate.

## Admission and remaining work

Every repeated re-enumerated reference and its canonical UTF-8 bytes enter the shared invocation
meter before trace/content acquisition. Exact limits pass and one below fails wholly. This
accounts for reference inspection, not every CPU operation or a measured resident-memory limit.
Selector-heavy parents require additional pure reinspection; no throughput claim is made.

The [tests](../../packages/policy-evaluation/src/capture-record-graph.test.ts) cover actual memory
graphs, cycles, missing roots, unresolved and contradictory selectors, manifest subsets, provenance
corruption and cumulative budgets. [Routing tests](../../packages/policy-evaluation/src/record-routing.test.ts)
exercise retained re-enumeration across every source kind, including full replay histories.

Complete logical authority/history and absent-record guards, content/trace binding, typed rule
projections, strict sealed contracts, atomic snapshot/job/fence publication and all durable worker,
public API/SDK, recovery and exit gates remain open. The read-only source-recheck report still ends
after releasing its guards and cannot authorize later publication. No route, role, grant, migration,
worker, seal or accepted Workflow 2 checkpoint is added here.
