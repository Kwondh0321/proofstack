# Captured policy terminal lifecycle

[English](workflow-2-policy-lifecycle-capture.md) | [한국어](workflow-2-policy-lifecycle-capture.ko.md)

Status: request-rooted terminal-history observations and capture-time change detection implemented.
Workflow 2 checkpoint 3 remains open; **2/7** checkpoints are accepted. This is not an atomic
authority cut, sealed evaluation input, policy result or release permission.

## Exact root and owning history

The core's `readPolicyEvaluationLifecycle` owns policy validation, lifecycle semantics and hashing.
The upper composition package binds its original graph root and compares the two observations;
it gains no new external dependency or alternative policy validator.

`capturePolicyArtifactEvidence` returns `policyLifecycle.beforeArtifacts` and `afterArtifacts`.
Each observation revalidates the original root's owning policy schema, exact scope/reference and
complete retained-record hash before querying `listReleasePolicyLifecycleEvents`. It never selects
a replacement policy. Unavailable roots retain `roots_unavailable` without history reads.

The existing repository contract permits a complete history of zero or one terminal event per
version. Non-arrays, malformed or multiple events (including duplicates), another scope/reference
and events predating policy publication are repository contract errors. No preferred winner is
selected. Unexpected repository exceptions propagate; an operational failure is not an empty history.

A supersession requires an exact successor lookup. Its owning schema and definition digest must
validate; scope, event reference and predecessor must match the original policy exactly. Its
publication cannot follow the event. The observation retains entire event and successor records
plus complete canonical SHA-256 hashes, including receipt fields outside definition digests.
The successor is auxiliary lineage evidence, not a replacement rule-policy root or a new immutable
graph source. Its own authority prerequisites are not certified by this observation.

Metadata ports still need separate authorization by their trusted composition boundary. Artifact
access grants neither policy authoring nor evaluation permission. The package exports report and
artifact-capture repository types, not the arbitrary-graph internal observer. Existing pure record
and trace acquisition keep their narrower repository requirements.

## Semantic time and observation time

The existing comparator preserves evaluation timestamps with up to 30 fractional digits. Event
receipts keep their owning UTC millisecond contract. An event at or before `evaluationTime` gives
`withdrawn_at_evaluation` or `superseded_at_evaluation`. Otherwise the state is
`no_terminal_event_at_evaluation`, **not** active, valid or approved.

Later terminal history remains visible. Its successor may be published after evaluation time:
this is later-transition lineage, not future-positive evidence for an earlier policy rule. Event
receipts cannot exceed observation completion time; equality is permitted. The enclosing capture
owns and checks the nondecreasing server clock.

Static `policyAuthority.requirements.status` and lifecycle state remain separate. A policy can
satisfy static installation/source/reviewer requirements and still be withdrawn. Future derivation
must consume both observations and all other prerequisites. Static `valid` must never grant release.

## Change detection and admission

The first observation precedes object reads. The second follows artifact/static authority inspection,
before final retention-expiry checking. Each retains scope, exact policy, original root hash,
evaluation time, full history and start/completion times. Its digest uses the domain separator
`proofstack.policy-lifecycle-observation.v1` and includes records but not observation clock values.
Advancing clocks therefore do not invent record conflicts.

Changed history or successor fingerprints abort with `source_revision_changed`, even if a new event
postdates evaluation time and the semantic state is unchanged. Invalid second responses are contract
errors. No partial success or automatic retry is returned. Repository exceptions propagate unchanged.

History and successor I/O share the request's cumulative acquisition budget. Each lookup consumes
a read and record reservation; each returned history member consumes another record. Complete raw
JSON bytes, including empty arrays and repeated observations, are charged before use. Supersession
charges its successor lookup/body on each observation. Existing reference, artifact-byte, classified
access, non-JSON, clock and retention checks remain. These are response-admission limits, not
transport allocation caps or durable retry accounting.

The fingerprint is **not a database revision token**. Equal reads do not prevent a write after the
second observation, establish a globally atomic cross-store cut, or detect an out-of-contract change
undone between reads. ADR-0022 still requires authoritative lifecycle/artifact revision guards in
atomic snapshot publication. Double reads do not substitute for that transaction.

## Verification and remaining work

Unit tests cover precise time edges, later supersession lineage, owning validation, malformed complete
history, predecessor binding, future receipts, complete hashes, copying and exact count/byte admission.
Composition tests use actual memory publication repositories, request-rooted graphs and encrypted
artifact storage. They cover terminal writes during object reads, same-time actor/reason substitution,
storage failures, static validity alongside terminal states, advancing clocks and expiry at recheck.

This does not establish PostgreSQL sealing concurrency, durable worker execution, complete semantic
closure or release acceptance. Guarded sealing, deterministic rules, durable jobs, API/SDK,
recovery/isolation and end-to-end checkpoint acceptance remain open.
