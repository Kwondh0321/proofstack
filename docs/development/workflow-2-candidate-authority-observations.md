# Candidate external-authority observations

[English](workflow-2-candidate-authority-observations.md) |
[한국어](workflow-2-candidate-authority-observations.ko.md)

Status: experimental input observations; Workflow 2 checkpoint 3 remains open,
with 2/7 checkpoints accepted. This is not a sealed input or a policy result.

Candidate publication historically verifies source availability. An identical
publication retry preserves its original receipt and does not repeat those checks.
Policy capture therefore keeps its own optional `candidateAuthority` observations
before and after object/key I/O, separate from that historical publication.

## Existing operator-owned ports and original subjects

The shared core [authority interfaces](../../packages/core/src/release/release-candidate-authority.ts)
retain the existing API type exports and implementations. The operator-allowlisted
[local Git and copied runtime authorities](../../apps/api/src/release-candidate-authorities.ts)
are unchanged. They resolve exact scope, repository/commit/tree relationships,
model declarations and adapter versions/digests. Candidate roles identify original
occurrences; they do not grant runtime registry authority.

The fixed internal [observer](../../packages/policy-evaluation/src/capture-candidate-authority.ts)
revalidates every captured candidate body, complete parent references, original
receipt/hash and graph occurrence. It derives only existing source-revision,
model-declaration and runtime-adapter subjects; no arbitrary URL, caller-selected
replacement or broad publication/source resolver is exposed. Unavailable candidate
parents retain their exact observations without fabricated query subjects.

Missing overall composition returns `not_configured` without authority I/O or extra
inspection admission. Partial composition preserves each missing port separately.
Configured ports must return native booleans: `true` becomes `available`, `false`
becomes `not_verified`; false does not establish physical absence. Undefined, null,
truthy values and malformed responses fail wholly. Thrown port failures propagate;
existing authority implementations retain their documented fail-closed semantics.

## Finite admission and observation boundaries

Each phase charges complete parent and repeated original authority references to
the invocation-wide canonical UTF-8 count/byte meter before any authority I/O.
Every actual authority call/response consumes the same acquisition read/record/JSON
budget. Negative and repeated reads do not receive refunds. Owned scope/subject
copies prevent port-side mutation of the graph, and returned observations own their
original subject/edge/hash data.

Each observed phase retains its start/end receipts, scope and semantic evaluation
time. Receipts cannot precede the request or run backwards. The internal clock port
accepts full-precision UTC text; the existing public artifact composer still uses
its Date clock. Material comparison excludes advancing receipts but compares every
original occurrence, parent observation, subject and availability. Any before/after
change rejects the capture. All external-authority I/O finishes before metadata
guards are acquired; it is never invoked through a database transaction port.

Availability from the reference registry does not establish loaded implementation
bytes, provider identity, OS enforcement or exact model-version evidence. An
alias-only model retains that limitation. These completed observations cannot
authorize publication later. Guarded database reinspection remains separate, and
complete current-authority/semantic closure, strict sealed contracts, same-transaction
snapshot/job/fence publication, predicates, durable worker/API/SDK/recovery and the
independent checkpoint exit audit remain required.
