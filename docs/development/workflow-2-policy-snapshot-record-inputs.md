# Strict record inputs for policy snapshots

[English](workflow-2-policy-snapshot-record-inputs.md) |
[한국어](workflow-2-policy-snapshot-record-inputs.ko.md)

Status: record-component contract prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`PolicyEvaluationSnapshotRecordInputs` version 0.1 binds the exact request reference, scope,
full-precision semantic time and ordered original record witnesses. It is one component of future
sealed input. Authority histories, selectors, artifacts, traces, complete rule projections,
snapshot/result records and guarded publication still require their own contracts and validation.
The separate [strict rule input component](workflow-2-policy-snapshot-rule-inputs.md) now preserves
all seven original rule families and bounded operands after owning reinspection; it does not close
the other input domains or establish a seal.

Witnesses retain original manifest observations, full stored-body hashes, original receipt text
and every original node/root/parent/target use. Verified semantic and stored hashes must agree.
Missing, invalid and mismatched records cannot carry valid stored bodies. Valid future bodies
retain their hashes and receipts while remaining unavailable at the original semantic cut.
PostgreSQL-compatible offsets and supported precision are preserved without rounding or rewriting
the original receipt text.

Sources are unique and ordered by repository identity, excluding digest. Every original coordinate
is distinct across the component, including repeated target positions. Records and occurrences
share a fixed ceiling, admitted before nested material parsing. The existing acquisition meter
separately preserves cumulative inspection and byte charges; contract parsing does not reset it.

The server [record derivation](workflow-2-policy-input-record-sources.md) validates this component
after admitting all output metadata. Full owning scope/source/body/hash/receipt, relationship,
reachability and selector validation still happens first. Schema admission and a digest cannot
authenticate source bodies, establish source authority or prove complete expected closure.
Arbitrary supplied source lists and coordinates remain insufficient.

`encodePolicyEvaluationSnapshotRecordInputs` uses the existing strict canonical JSON encoder,
domain `proofstack.policy-evaluation-snapshot-records.v1` and encoding
`proofstack.policy-evaluation-snapshot-records-jcs.v1`. The independent Python UTF-8/hashlib
[public vector](../../packages/contracts/vectors/policy-evaluation-snapshot-records-v1.json)
binds scope/request, availability, full body hashes, original receipts and every ordered use.
The component adds no body copy, content/key read, locator, credential, approval or publication port.

Focused cases cover last-fraction temporal boundaries, substituted hashes/availability/identity,
duplicate coordinates, missing/future witnesses, offsets, admission before material access,
exact/over ceilings and canonical mutations. Real owning captures validate verified and future
records. Existing request and fixed-page manifest contracts are preserved. Complete snapshot/page/
result transport, atomic snapshot/job/fence publication, native job-wide admission, predicates,
worker/API/SDK/recovery and independent checkpoint-3 acceptance remain open.
