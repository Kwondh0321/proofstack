# Captured dataset and fixture relationships

[English](workflow-2-policy-dataset-relations.md) | [한국어](workflow-2-policy-dataset-relations.ko.md)

Status: direct dataset membership and predecessor semantics are inspected in request-rooted record
capture. Complete semantic closure and Workflow 2 checkpoint 3 remain open.

## Why individual record integrity is insufficient

A valid definition digest and a verified full-record observation do not establish that two records
belong together. Recorded interaction fixtures must preserve the exact evidence-only predecessor's
snapshot, including the `capturedAt` receipt excluded from the definition digest. A verified file and
matching artifact ownership cannot repair that relationship.

These rules follow existing dataset publication and
[ADR-0017](../architecture/0017-own-interaction-content-per-fixture.md); they do not introduce another
fixture format or reinterpret old versions:

- A dataset member names one exact fixture identity, version and definition digest in the same
  tenant/project/environment. Both evidence-only and recorded-interaction members are supported.
- A dataset predecessor names an exact version of the same logical dataset and scope.
- Both fixture formats may name only an evidence-only (`0.1`) predecessor of the same logical fixture
  and scope. The existing recorded format requires that predecessor.
- Promotion to recorded interactions (`0.2`) copies the complete predecessor snapshot exactly:
  trace ID, ordered event IDs, event count, completeness and `capturedAt`. Timestamp strings are
  compared as preserved receipts, not rounded or normalized into a new representation.
- An evidence-only successor may capture a different snapshot. It does not inherit the stricter
  recorded-promotion copy requirement.

## Fixed owning-domain inspector

`inspectPolicyEvaluationDatasetRelations` in `@proofstack/datasets` accepts scope/evaluation time,
unique acquired dataset/fixture observations, and reference-count/byte limits. It revalidates each
verified immutable body once with the fixed owning inspector, exact reference and original full
record hash before joining dependencies. Scope and receipt-cut checks remain mandatory.

No repository, trace, object, plaintext or network I/O occurs here. There is no pluggable validator,
latest-version lookup, or public HTTP route. Missing/unavailable observations must have a null body;
they preserve the original reason. Those observations are provenance from the trusted acquisition
path, not a caller's proof of absence or authority.

Each declared child must have its own exact observation in the supplied inventory. An omitted node,
duplicate identity, contradictory full reference, changed body/hash, malformed input or exceeded
bound fails inspection; no partial successful report is returned. The node count and cumulative
relation occurrences are independently bounded by `maxReferences`, and compact canonical record
references by `maxReferenceBytes`. Repeated relations still count. These are bounded pure inspection
limits, not a second acquisition meter or a complete process-memory/wire-transfer limit.

## Result and trusted composition

`capturePolicyRecordGraph` derives the inspector input from its own captured nodes. It never accepts
a caller-authored graph. The resulting `datasetRelations` is retained by comparison, trace and
artifact composition; it adds no repository calls and does not reset or recharge acquisition usage.
Existing graph edges, metadata observations, trace reads and artifact checks remain intact.

`parents` is sorted by source identity. Each entry retains the exact source and full `recordSha256`.
Its ordered `relations` preserve `dataset_member`, `dataset_predecessor` or `fixture_predecessor`,
the parent JSON pointer, complete target source, and original child `recordObservation`. Member
order and shared predecessor occurrences are not deduplicated.

| Relation observation | Meaning |
| --- | --- |
| `matched` | The inspected direct relation agrees with the retained target |
| `unavailable` | No verified target body exists; `recordObservation` retains missing/invalid/reference/time detail |
| `mismatch / predecessor_format_mismatch` | A fixture names a recorded-interaction predecessor, which the current publication model does not allow |
| `mismatch / trace_snapshot_mismatch` | Recorded promotion does not copy its evidence-only predecessor's exact complete snapshot |

`unavailableParents` separately retains unreadable parents. Their unknown dependency inventory is
not converted into a valid root with no predecessors. An empty relation list for a readable
evidence-only fixture describes its declaration only; it does not prove registration as the logical
root. Only the first applicable mismatch is reported for a relation, not all possible defects.

**A direct match is not transitive eligibility.** A dataset member can match while that fixture's
own predecessor relation is mismatched or unavailable. Consumers must retain both observations.
Neither an all-matched subset nor `artifacts_captured` is policy satisfaction or release permission.

## Verification and remaining work

Unit tests cover both fixture formats, dataset predecessors, ordered/shared membership, original
record hashes, missing/invalid/future/reference-mismatched targets, omitted and duplicate observations,
receipt and definition substitutions, exact timestamp representations/precision, changed event order
or membership, deterministic ordering, detached results and exact count/byte limits.

Public capture tests use actual memory publication, graph/evidence repositories and authenticated
synthetic artifact bytes. They retain edge/hash provenance and one lookup per captured identity
(both fixture stores still count separately). A controlled corrupt-adapter response demonstrates
that unchanged definition hashes, valid bytes and matching artifact ownership do not hide a changed
promotion receipt. Storage errors propagate instead of becoming favorable unavailable observations.
These tests do not establish PostgreSQL policy-worker or live-provider acceptance.

Logical-root registration, other replay/evaluation relationships, mutable authority and revocation,
concurrent revision guards, authoritative full closure, snapshot sealing, deterministic predicates,
durable jobs, API/SDK, recovery/isolation and end-to-end checkpoint acceptance remain separate work.
Workflow 2 remains **2/7** accepted checkpoints.
