# Request-rooted policy record graph

[English](workflow-2-policy-evaluation-record-graph.md) |
[한국어](workflow-2-policy-evaluation-record-graph.ko.md)

Status: metadata traversal building block; Workflow 2 checkpoint 3 remains open.

`@proofstack/policy-evaluation` now composes the fixed source readers, direct-reference enumerators,
and parent-bound selector reader. The dependency direction is fixed by
[ADR-0024](../architecture/0024-compose-policy-record-acquisition-above-domain-packages.md).

## API and ownership

`capturePolicyRecordGraph(request, repositories)` accepts a complete immutable
`PolicyEvaluationRequest` and application-owned read-only ports. It validates the request schema and
scoped definition digest before I/O, and owns a defensive copy before awaiting a repository. The
caller must already authorize acquisition and supply scoped repositories. A valid request digest
is not authentication or permission to read another tenant.

The only roots are the request's exact release candidate and policy. Callers cannot supply a
different root list, record validator, graph, or successful verdict. Fixed routing covers all 44
source kinds through their owning packages. The API is a private workspace building block, not a
new HTTP endpoint, CLI, published SDK operation, or functioning policy-worker service.

## Traversal and retained evidence

1. Read roots in candidate-then-policy order and expand records breadth first.
2. Validate each record's schema, scope, exact reference, definition digest, receipt cut, and full
   canonical record observation through the owning reader before enumerating children.
3. Keep every direct-reference occurrence, with its parent source, parent record hash, and JSON
   pointer. Repeated references are not discarded merely because their target was already visited.
4. Resolve criterion selectors, model evaluator selectors, run identities, and partial comparison
   predecessors from the validated parent occurrence. Reuse a verified prefetched child when its
   queue position is reached; do not repeat that read merely to expand it.
5. Expand each exact record identity once. Preserve normal criterion/oracle/fixture and
   model-profile/evaluator backreferences. Reject different full references under one repository
   identity, changed full-record observations when the same exact child is observed again, or
   incompatible content descriptors under one artifact ID.
6. Sort node/manifest-entry observations by the established source identity key. Keep edges in
   deterministic parent traversal and occurrence order.

`nodes` contain the owning read and its references. Missing or unavailable records retain
`references: null`, never a fabricated verified leaf. A verified record may genuinely have no
references. `entries` contain the corresponding source/observation pairs; they are **not an
authoritative expected closure** suitable for sealing without the remaining validation.

`datasetRelations` additionally reports [direct dataset/fixture semantics](workflow-2-policy-dataset-relations.md)
from those same captured nodes: exact membership, predecessor format and recorded-promotion snapshot
equality. It retains original hashes, paths and unavailable parent/child observations without more
I/O or resetting admission. Inspect this report separately from metadata verification; matching one
relation does not establish transitive eligibility or logical-root authority.

`replayPlans` retains [declared replay-plan consistency](workflow-2-policy-replay-plan-bindings.md)
from the captured target/profile/dataset/fixture records, including boundary support, invocation
digests, membership and recorded format. Missing plans and prerequisites stay explicit. No target is
executed, and a direct match does not prove historical execution, runtime installation or eligibility.

`replayResults` retains [result-to-plan checks](workflow-2-policy-replay-result-bindings.md) for all
attempts, retry declarations, history receipts, budget policy and boundary observations. Missing
results stay separate from successful reports; unavailable plans and unretained lease-expiry timing
are explicit. This adds no repository I/O and does not prove execution or result-content meaning.

An edge's `target` is the exact child record reference or `null`. Missing/unavailable selectors
retain a typed `selectorFailure`; no missing hash is fabricated. Artifact descriptors, exact trace
selectors, protocol/profile declarations, candidate source claims, approval requirements, and
other non-record evidence stay visible as unresolved edges. A non-null target can itself have a
missing/unavailable node: inspect both `unresolved.records` and `unresolved.references`.

Even zero unresolved counters would not establish semantic validity, policy effectiveness,
authority, availability of bytes, or a sealed capture. This helper does not verify every
parent/child relationship or reject every invalid semantic cycle. Selector lineage checks remain
specific to the selector reader; further domain validation belongs to complete snapshot capture.

## Admission accounting and failure

| Output counter | Accounting |
| --- | --- |
| `usage.reads` | Actual repository calls, including missing and repeated selector reads; a dual-format fixture lookup uses two calls |
| `usage.records` | Calls plus retained replay attempt, budget, cancellation, execution, and usage rows |
| `usage.bytes` | Compact JSON-compatible UTF-8 response bytes; repeated responses and null responses count again |
| `usage.references` | Every admitted reference occurrence, including duplicates and unresolved declarations |
| `usage.referenceBytes` | Sum of canonical UTF-8 bytes for those reference entries |

The request's `maxAcquisitionRecords` bounds `records` and, separately, `references`. The combined
`bytes + referenceBytes` must fit `maxAcquisitionRecordBytes`; this conservatively admits retained
reference metadata in addition to repository responses. Per-parent and replay-history limits are
also enforced by the owning components. These are invocation-local ceilings, **not** durable
job-wide accounting, wire transfer limits, complete process-memory accounting, or artifact-byte
verification. The request's artifact, rule, lease, attempt, and deadline limits require later layers.

Before each call, reserve its lookup count. Admit response bytes before semantic processing and
defensive cloning. Measurement rejects cycles, excessive nesting, non-finite numbers, non-JSON
objects, accessors, hidden/symbol properties, and malformed arrays; it does not invoke getters.
Schema-admitted optional undefined object properties do not add JSON bytes, but are not stripped
before the owning schema has an opportunity to reject unknown fields. Missing responses count.

Graph admission and cross-parent conflicts throw `PolicyRecordGraphError` with `code`, `reason`,
and an optional conflicting identity (not a full record or secret payload). Owning request,
reference, or history validation errors remain distinguishable; storage errors propagate unchanged.
No error returns a partial successful graph. An already-started sibling fixture read is drained
before failure is exposed. This does not cancel or forcibly interrupt a hung repository operation.

## Verification

- Real memory evaluation/model/human and comparison repositories, all 44 fixed source-kind routes,
  both fixture formats, retained runtime catalogues, and an actually completed memory replay job.
- Recursive non-model evidence, normal model/profile cycles, prefetched comparison predecessors,
  stable ordering, repeated occurrences, defensive ownership, and unavailable/missing frontiers.
- Cross-parent reference/artifact conflicts and changed full-record receipts during repeated reads.
- Exact aggregate byte/reference boundaries and one-unit overflow; null/duplicate reads and replay
  history row accounting; malformed raw responses; storage failures and in-flight sibling drainage.

These tests validate metadata acquisition, not live provider execution, complete content lineage,
PostgreSQL snapshot capture, a production deployment, or policy-evaluation checkpoint acceptance.

## Remaining dependency order

[Captured comparison integration](workflow-2-policy-comparison-capture.md) now connects complete
selection and direct re-derivation without repository rereads. The higher-level
[exact trace capture](workflow-2-policy-trace-capture.md) now reads verified-parent event selectors
under this same acquisition budget; this graph-only entry point and its frontier counters remain
metadata-only. Complete cross-record semantics; acquire retained artifact bytes and
declaration/installation/source authority; collect
mutable lifecycle state and guard against acquisition races; derive closure and seal the snapshot;
evaluate all policy predicates; persist and run separately authorized durable jobs; expose and
verify API/SDK, recovery, isolation, and end-to-end contributor paths. Release decisions,
exceptions, attestations, CI enforcement, and the later roadmap checkpoints follow those gates.
