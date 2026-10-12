# Original stored evaluation, assurance, dataset and replay relationships

[English](workflow-2-policy-stored-relationships.md) |
[한국어](workflow-2-policy-stored-relationships.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

Graph capture exposes `storedRelationships` beside semantic relationship reports and the
[original storage inventory](workflow-2-policy-storage-inventory.md). Original datasets,
fixtures, replay plans, successful replay histories, evaluation snapshots and model/human
assurance retain complete record hashes, actual
receipts and semantic availability at the unchanged request evaluation time. A stored relationship
can match while its original record remains `not_yet_available`; the future body cannot become
an operand or establish current source authority from that match.

Canonical byte generation optionally uses a native UTF-8 encoder while retaining the ES-only
fallback. Both paths preserve strict Unicode scalar admission, key order and the existing exact
byte vectors; this changes encoding cost, not retained hashes or observations.

The owning dataset inspector checks every original membership and predecessor occurrence.
Recorded fixture promotion preserves the entire predecessor trace snapshot, including capture
time and event order, and requires the original evidence-only predecessor format. Missing or
invalid stored parents remain explicit unavailable parents; a missing child remains an unavailable
relationship. Exact identity/digest substitutions and omitted required captures fail inspection.

Replay plan inspection checks exact dataset, runtime/isolation, target, fixture and endpoint
dependencies: runtime configuration/family, declared boundary modes/kinds, recorded invocation
digest, fixture membership/format and exact live endpoint destination/operation/boundary context.
These checks do not establish loaded runtime/provider authority, actual compatibility, credentials,
external execution or artifact content verification.

Successful replay-history inspection checks its exact original plan, all retained attempts,
retry declarations/timing, full receipts, recorded boundaries, usage and declared budget
reconciliation. Semantic and stored inspection share private original-body rules. An unretained
expired lease instant still produces `lease_expiry_unretained`; the inspector does not substitute
a replacement attempt's receipt for that missing instant.

Evaluation run/result, aggregate and assessment inspection reuses the original fixed run bindings,
snapshot reconstruction and complete history rules. Evaluation-to-replay inspection uses original
plan/result bodies and their owning prerequisite/history reports. Model/human assurance inspection
reuses the complete base history, qualification, calibration, blinding, critique, independence,
quorum, lineage, validity and receipt rules. Repeated nested inputs retain their actual owners.
Missing evaluator mappings remain explicit in the complete inventory; no arbitrary selector target
or body is invented. These local relationships are distinct from policy predicates and verdicts.

The internal body witness separates an original validated body/hash/receipt from its unchanged
semantic observation. Semantic wrappers retain their verified-only body boundary and existing
report shapes. Stored composition revalidates the complete request-rooted original inventory at
the original cut before using bodies, including parent hashes, reachability, ordered references,
logical roots and complete owning selector outcomes. It never fabricates a verified observation,
changes the cut or weakens the owning validators. A future human review can expose an original
receipt contradiction while remaining unavailable as evidence at the request cut.

Every original semantic observation is preserved. Fixed owning inspectors revalidate whole stored
bodies at the original cut, including hash, actual receipt, scope and complete reference. The
internal composer binds every domain parent to its original storage node/full parent hash, and
every relationship to its original edge index, JSON pointer and complete ordered target. Shared
targets retain every occurrence. Missing/extra/duplicate/substituted origins fail. Histories
without valid stored bodies retain explicit unavailable source observations.

Admission counts complete context/inventory/capture material, owning closure reinspection,
repeated references, nested snapshot/model history, each replay history row,
domain reports, every origin frame and the combined report. Sufficient operational per-read
ceilings do not alter the source-context witness; those ceilings remain validated and enforced
by the owning history inspector. Exact limits succeed; count/byte overflow fails wholly.

Graph reinspection reproduces and compares these reports on the existing held metadata connection.
This adds no repository/object/key call, SQL/migration, role/grant, public route, job or worker.
The read-only transaction ends before its report returns. Atomic snapshot/job publication still
requires complete closure and live worker/lease/fence/epoch/state authority on the same open
connection, with guards retained until publication.

Complete current-authority/presence/selector closure,
native SQL/scan/row/body/wire/deadline admission and durable job-wide limits remain open. Strict
sealed snapshot/result contracts, publication, all seven predicates, durable scheduling/recovery,
public transports, contributor acceptance and the independent C3 exit audit remain required.

Main code: `packages/datasets/src/policy-evaluation-dataset-relations.ts`,
`packages/replay/src/policy-evaluation-replay-plan-bindings.ts`,
`packages/replay/src/policy-evaluation-replay-result-bindings.ts`,
`packages/policy-evaluation/src/capture-stored-relations.ts`, `relationship-material.ts`,
`capture-evaluation-snapshots.ts`, `capture-evaluation-run-bindings.ts`,
`capture-evaluation-replay-bindings.ts`, `capture-model-assurance.ts` and `capture-record-graph.ts`.
