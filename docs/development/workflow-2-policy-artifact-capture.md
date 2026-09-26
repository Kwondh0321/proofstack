# Request-rooted authorized artifact capture

[English](workflow-2-policy-artifact-capture.md) | [한국어](workflow-2-policy-artifact-capture.ko.md)

Status: graph/trace artifact acquisition, recorded-fixture bindings and static policy-authority
prerequisite inspection and terminal policy lifecycle observations implemented.
Complete semantic closure, mutable authority, guarded snapshot sealing and Workflow 2 checkpoint 3
remain open.

## One request owns the acquisition

`capturePolicyArtifactEvidence` in `@proofstack/policy-evaluation` composes the existing record graph,
comparison resolution, exact trace capture and
[owning-domain artifact observer](workflow-2-policy-artifact-observation.md). It does not accept a
caller-supplied graph, list of artifacts, precomputed verdict or pluggable validator. The package
dependency extension is recorded in
[ADR-0025](../architecture/0025-compose-authorized-policy-artifact-observations.md).

Before repository I/O, validate and copy the immutable request and authenticated artifact principal.
Require `artifact:read`, matching tenant and project/environment access. Metadata and trace ports
still need separate authorization by their trusted composition boundary; artifact access does not
grant access to every source domain. The principal is not an authentication credential to trust from
an HTTP request body. `policy:evaluate` alone cannot read content.

Use a server-owned monotone clock across the whole invocation. Both the semantic evaluation time
and request receipt must be at or before the start. An invalid or backward-moving clock aborts.
After graph/trace capture, preflight every known restricted descriptor before any artifact lookup.
The owning reader separately checks the actual stored classification, so understated declarations
cannot bypass restricted-content permission.

## Occurrences and observations

Read graph artifact edges in their retained order, followed by trace artifact occurrences in trace
capture order. Each result retains an origin:

| Origin | Binding |
| --- | --- |
| `record` + `edgeIndex` | Exact graph parent identity, parent-record hash and reference JSON pointer |
| `trace` + `artifactReferenceIndex` | Exact trace selector, event identity, event-record hash and content-reference pointer |

The nested `traceCapture` retains those parent observations; source indices are not independent
authority or external URLs. Repeated references are not discarded or replaced with a caller-selected
observation. Every occurrence reaches the fixed owning reader, preserving original descriptors and
known absence/unavailability. Unsupported trace descriptors do not trigger a managed-store lookup.

`roots_unavailable` retains its source observations without claiming a successful empty artifact
inventory. `artifacts_captured` means observations were collected, **not** that every artifact is
verified or the dependency closure is complete. Unavailable parents still retain their unresolved
frontier; unknown child references cannot be invented or declared absent.

For repeated artifact identities, compare the complete catalog observation and content result.
Per-read clock/usage fields may differ, but changed catalog hashes, ownership, lifecycle, missingness
or content outcomes raise `observation_conflict`. A changed record during an individual object read
raises the owning reader's `source_revision_changed`. Storage, key-provider and other operational
errors propagate instead of becoming normal indeterminate evidence. No partial capture is returned.

At the final aggregate clock cut, reject earlier verified content whose retention has expired.
This is a `source_revision_changed` capture failure even if no maintenance process updated the row:
availability changed during collection. It does not rewrite an earlier observation as a historical
success, retry automatically, or authorize later snapshot publication.

## Recorded-fixture bindings

The subsequent [fixture-binding inspection](workflow-2-policy-fixture-bindings.md) adds
`fixtureBindings` derived from this invocation's verified recorded fixtures and catalog observations.
It compares exact ownership, publication receipts, descriptors, retention and redaction while
preserving every direct fixture occurrence. A matched binding and verified content are separate
observations; neither proves complete closure or mutable authority. Ordinary build/trace files do
not acquire a fixture-ownership requirement.

## Shared resource admission

The subsequent [policy-authority inspection](workflow-2-policy-authority-prerequisites.md) adds
`policyAuthority` from the original policy/source records and verified-byte observations. It performs
no additional I/O, preserves repeated dependency provenance and checks static requirements at the
exact request evaluation time. Its `valid` status is not mutable-authority, sealed-snapshot or
release approval. Inspection reference usage is reported separately from acquisition I/O usage.

The subsequent [terminal lifecycle capture](workflow-2-policy-lifecycle-capture.md) observes exact
policy history before and after object reads, retaining full event/successor hashes and rejecting
detected changes. It does not replace the required future atomic revision guard and snapshot seal.

Graph reads, trace rows, both catalog reads, terminal history/successor reads and raw JSON consume
one metadata budget. The raw admission wrapper rejects getters, hidden/non-JSON fields and cycles before domain
inspection. Original graph/trace references remain charged once per occurrence; adding a result's
origin index does not create a new source-reference occurrence or reset any counter.

For actual object requests, reserve the expected encrypted size (content length plus the existing
20-byte envelope) before I/O against the request's `maxArtifactReadBytes`. Repeated reads reserve
again. Missing, short, malformed or failed responses do not refund the reservation. Returned buffers
larger than expected charge the excess before copying, hashing or decrypting. An exhausted budget
throws `artifact_byte_limit`, never silently omitting content to make a rule pass.

| `usage.artifacts` field | Meaning |
| --- | --- |
| `reads` | Object calls admitted and started |
| `reservedBytes` | Sum of expected encrypted response lengths reserved before calls |
| `receivedBytes` | Sum of actual complete `Uint8Array` response lengths, not guessed failure traffic |
| `chargedBytes` | Sum of the larger of reservation and complete-buffer receipt for each call |

Zero budget does not waive content verification: an available artifact requiring an object read
fails admission. Catalog absence and explicit unavailability remain observable without object I/O.
These counters cover this invocation only. A thrown capture returns no success envelope; reservations
are not reset while its in-flight reads settle. The future durable worker must persist cumulative
accounting across failed/retried attempts and instrument partial transfers and transport retries.
The current whole-buffer interface cannot cap remote allocation or reveal bytes hidden by a failing
transport. These limitations are not an exemption from the request contract's durable obligations.

## Verified boundary and remaining work

Tests use actual graph/dataset/evidence repositories and authenticated artifact encryption. They
exercise origin binding, duplicate observations, absent roots, unsupported descriptors, authorization,
shared record/UTF-8/object limits, non-JSON rejection, input mutation, clock/retention transitions,
catalog/content changes and real key-provider failure. Existing graph/trace entry points retain
their behavior; internal shared-meter helpers are not package-root exports.

No plaintext, wrapped key, object locator, policy verdict or sealed marker is added to the capture.
This is not a PostgreSQL policy-worker or release acceptance test. Matching recorded-fixture bindings
do not establish current policy/source authority, atomic sealing, deployment permission or
production readiness. Complete those boundaries, then implement deterministic predicates, durable
jobs, API/SDK, recovery/isolation and end-to-end acceptance. The roadmap remains **2/7** accepted
Workflow 2 checkpoints.
