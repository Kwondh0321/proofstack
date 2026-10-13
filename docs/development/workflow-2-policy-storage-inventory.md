# Request-owned recursive storage inventory

[English](workflow-2-policy-storage-inventory.md) |
[한국어](workflow-2-policy-storage-inventory.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`capturePolicyRecordGraph` now produces `storageInventory` separately from its ordinary
semantic `roots`, `nodes`, `edges` and manifest entries. Both inventories derive their
two request roots from the validated immutable candidate/policy request. Stored future
records retain their original unavailable observation; traversing their stored declarations
does not make those records, historical roots or their descendants semantic operands.

The internal queue uses the existing fixed owning reader dispatcher, all 48 stored
reference grammars and the four original-cut stored selector families. Each valid stored
parent obtains its owning logical-root binding when applicable. Those independently
validated root bodies enter the same finite breadth-first queue and acquire their own
bindings and dependencies. Missing root configuration is explicit. Missing, malformed
or scope-failed records have a null stored frontier rather than verified empty closure.

Repeated parent/path occurrences and every ordered protocol candidate remain in edges.
Identity deduplication occurs only after complete source coordinates agree. Full body,
record hash and actual receipt agree across original semantic, root and selector reads,
including equally unavailable future observations. Scope/descriptor/relationship failures
remain explicit, never a silently selected winner or evidence of protected absence.

The semantic composer uses the stored owning joins for its existing selectors and retains
their original full child captures for the storage pass. It preserves ordinary semantic
outcomes and avoids a later lookup that would discard the first future child's body.
Repeated occurrences still execute their fixed owning lookup. Core selectors now reserve
whole-parent inspection before lookup, as the other selector families already did.

`inspectPolicyStorageInventory` is an internal independent reconstruction: it derives
reachability and ordered occurrences from immutable request roots and owning body fields,
checks original logical-root witnesses, recomputes valid retained selector joins and
compares original same-invocation prefetch material. It rejects missing, extra, reordered
or substituted captures, origins, receipts and targets. This validates retained structure
and agreement, not external source authenticity. Failure responses without a valid retained
child body remain explicit frontiers and cannot establish absence or current authority.

The owning storage boundary validates the complete checked canonical JSON before comparing
independently owned clones. Strict structural equality avoids serializing the same complete
material twice; unequal structures retain the canonical fallback, including `0`/`-0` equivalence.
Whole-body, scope, original-cut, hash, receipt, Unicode and nesting checks remain in force.
This uses no shared observation cache and does not skip a fixed owning inspector.

Semantic closure reconstruction owns its bounded root/node/edge witness once. For verified
nodes, the fixed stored enumerator validates both original storage and semantic read together;
the resulting private frontier is reused within that invocation. Original-cut unavailable
records remain separately checked, and all repeated reference/byte admission is preserved.

Independent reconstruction groups valid retained core selector children under one privately
owned, admitted parent. Every selected path must occur in the complete owning grammar and each
child is independently validated. Sparse/oversized inputs and non-owning paths are rejected;
raw child accessors cannot change the fixed parent or context. Repeated occurrences retain
their full per-occurrence inspection budget, even when parent validation is shared.

Both traversals share one request acquisition meter and, in metadata-transaction mode,
the supplied scoped connection. All actual reads and complete response rows/bytes remain
metered. Stored enumeration and independent reconstruction charge repeated reference
counts and canonical bytes; a new root-only selector reserves complete parent inspection
before lookup. Each storage node, root binding and edge is compared during guarded
reinspection before following descendants, followed by complete final material equality.

This increment performs no artifact object or key I/O, source publication or predicate
evaluation. The subsequent [stored artifact catalog prerequisite](workflow-2-policy-stored-artifact-catalogs.md)
adds separately authorized catalog, ownership, integrity and complete known artifact/policy
guard origins without automatic plaintext fetching. The
[original evaluation/assurance/dataset/replay relationship inspection](workflow-2-policy-stored-relationships.md)
adds complete original-body checks and request-owned node/edge origins while preserving semantic
unavailability. Current semantic/authority/presence closure,
native SQL/scan/wire/deadline admission and durable job-wide limits remain required.

The [input record source derivation](workflow-2-policy-input-record-sources.md) joins this original
inventory to independently re-derived semantic sources, preserving all original parent/target
origins, unavailable observations, mappings and body/receipt witnesses for the record manifest.
It does not turn that record-domain inventory into complete source authority or a sealed snapshot.

The read-only reinspection transaction ends before its report returns. A later publisher
must validate complete closure, current migration, worker job/lease/fence/epoch/state and
native database expiry and publish atomically while all guards remain held on that same
connection. No role/grant, migration, API route, job, worker, public SDK release or production
composition is introduced. This is not checkpoint acceptance or production readiness.

Tests exercise future request/root-only sources, repeated origins and cycles, missing/invalid joins,
original versus substituted future bodies, ordered closure tampering, guarded reinspection and
exact/one-below cumulative row/reference/byte admission. Existing thresholds and deadlines remain.
