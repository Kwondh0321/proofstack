# Original stored artifact catalogs and complete source guard origins

[English](workflow-2-policy-stored-artifact-catalogs.md) |
[한국어](workflow-2-policy-stored-artifact-catalogs.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`capturePolicyArtifactEvidence` now returns `storedArtifacts` separately from its verified or
attempted content `artifacts`. It derives every full artifact declaration from the complete
request-owned [recursive storage inventory](workflow-2-policy-storage-inventory.md), including
historical original roots and future stored parents. Each occurrence retains its original
inventory edge index, exact parent, parent record hash and JSON pointer, plus scope, full descriptor,
immutable evaluation time, actual catalog observation receipt and owning catalog inspection.
Stored future bodies retain their original unavailable observation and never become operands.

All known semantic and storage descriptors are preflighted for declared restricted classification
and full same-ID descriptor agreement before catalog, object or key I/O. Catalog-only acquisition
then uses the existing authorized owning catalog inspector and outer metered catalog port, before
content acquisition. The inspector checks actual stored classification again, exact scope/reference,
complete catalog integrity and private record hash, ownership, lifecycle and retention. It exposes
no plaintext, locator, wrapped key or private catalog body. Unsupported descriptors cannot authorize
managed-store reads. Null, malformed, mismatched, future, reserved, tombstoned, purged and expired
catalogs retain explicit owning missing/unavailable observations rather than verified absence.

Catalog `content_pending` means only that the inspected catalog describes ready content. It is not
verified bytes: a stored-only occurrence never invokes object or key I/O, even if its catalog is
ready and the object is missing. Existing semantic content acquisition, authenticated encryption,
repeated content attempts and conservative ciphertext reservation remain separate. Shared origins
must agree on complete descriptor/catalog identity and catalog readiness; attempted content states
`verified`, `object_missing` and `content_integrity_failed` correspond to `content_pending` only for
that comparison. Repeated content observations still require their original stricter full agreement.

Every repeated storage occurrence performs its own authorized catalog lookup, retains its actual
receipt and admits its full parent-bound projection before I/O. Its complete public catalog read
report is additionally admitted against the same cumulative byte ceiling. No record, reference,
metadata or artifact budget is reset. `storedArtifactInspectionUsage` reports these repeated
projection/read bytes and occurrence counts; it does not measure hidden transport or temporary
allocation. Stored-only ready catalogs are checked again for expiry at aggregate completion.

The [source guard plan](workflow-2-policy-source-guard-plan.md) now preserves semantic policy,
storage policy, content artifact, stored catalog, ID-only storage artifact and retained successor
origins. Deduplication is only by installed kind plus ID, after full coordinates and retained material
agree. Whole policy bodies, record hashes and actual receipts agree across storage and lifecycle
origins even when the later lifecycle read is verified but the original-cut read remains unavailable.
This does not move evaluation time or substitute a successor for the request policy.

Owning comparison omissions and artifact changes also contain ID-only declarations. These retain
their parent-bound storage edges and guard origins without fabricating a descriptor, catalog query
or content verification. A separately retained full descriptor owns any catalog read. In particular,
the comparison snapshot contract requires an omission's exact unavailable artifact state; its ID
origin creates no additional lookup and does not erase the original omission or availability.

Optional [guarded reinspection](workflow-2-policy-source-recheck.md) acquires all known installed
artifact/policy guards before authoritative reads. Unique catalogs are selected from actual content
or stored descriptor origins; an ID-only origin alone cannot supply a lookup. Every catalog-only
observation is compared at the native database cut, including exact expiry. Full stored policy
captures are independently revalidated at the original semantic cut, detecting changed bodies or
receipts even when both semantic observations remain unavailable. Complete root lifecycle and
criterion histories, guard failure rollback, scoped port lifetime and cleanup remain required.

Metadata mode also progressively compares complete original graph/trace/storage material on the
same held connection before following descendants. Its metadata report separately counts semantic
record observations, storage record observations and storage edge observations. Source-only mode
remains a narrower catalog/policy/criterion report; it does not recheck all storage source kinds.
Static operator catalogues are retained installation inputs, not proof of loaded implementation.

Canonical serialization preserves its existing domain, property order and exact bytes while
using an ordered object loop and a bounded per-invocation cache of escaped immutable key text.
It does not cache objects, skip current value/Unicode/cycle/depth checks or share validation state
between calls. Cumulative history admission, fixture sizes, test deadlines and coverage thresholds
remain unchanged; complete vectors and independent UTF-8 oracles verify the encoding boundary.

The read transaction ends before the report returns. Current semantic/authority/presence and
relevant storage relationships, native SQL/scan/wire/deadline admission, durable job-wide ceilings,
sealed contracts and atomic publication remain open. A publisher must revalidate complete closure,
current migration and live job/attempt/worker/lease/fence/epoch/state/native DB expiry while retaining
all guards through the same atomic snapshot/job transaction. This report cannot authorize later
publication. No role/grant, migration, external dependency, API route, worker or deployment is added.

Tests retain real repeated aliases and double-digit paths, independent native JSON/UTF-8/hash
oracles, restricted declaration and stored classification checks, unavailable states, original
omissions, conflicting full descriptors, changed equally unavailable policy receipts, native and
aggregate expiry, complete origin substitutions and exact/one-below guard bytes. Real PostgreSQL
tests exercise future-only catalog aliases, intervening writes, actual writer waiting and pool cleanup.
These checks do not accept checkpoint 3 or establish production readiness.
