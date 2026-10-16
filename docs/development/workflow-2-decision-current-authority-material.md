# Complete captured decision authority material

[English](workflow-2-decision-current-authority-material.md) | [한국어](workflow-2-decision-current-authority-material.ko.md)

Status: checkpoint 4 prerequisite. Workflow 2 remains 3/7 accepted checkpoints. Actual current
source acquisition, private authentication, guarded publication, API/SDK and the independent
exit audit remain open. See [ADR-0043](../architecture/0043-version-complete-captured-decision-authority.md)
and the [entry audit](workflow-2-decision-entry-audit.md).

## Version and retained sources

The [0.2 material](../../packages/contracts/src/release-decision-current-authority-material.ts)
wraps the strict historical [0.1 view](workflow-2-decision-authority-snapshot.md) as `base` and adds:

- Exact installation/target selection-root observation and one census/root observation for each
  retained reviewer authority logical root, including related lifecycle roots and missingness.
- Every unique original publisher/reviewer credential observation, with exact principal, original
  binding and native creation/use/revocation cut. A newer login cannot replace the original one.
- Each planned original request's full owning job graph, all sealed pages and actor provenance,
  or an explicit unavailable reason. Full graph admission preserves the original deciding attempt,
  sealed snapshot, immutable evaluation and original subject author receipts.
- Every declared compensating-control occurrence, including repeated content, opposing actions
  and expired approvals. Preserve original approval order and numeric indexes 0–15.

[Source contracts](../../packages/contracts/src/release-decision-current-authority-sources.ts)
retain observed/missing/unavailable/invalid roots and later catalog state. Content either has its
actual bounded capture receipts and sanitized outcome or an explicit non-inspection reason.
Inactive/non-supporting skip reasons require their retained action/history facts. No synthetic
capture timestamp is generated for a skipped read. Later catalog scope/content/ownership is
validated even when content was not inspected. Earlier verified bytes do not make a changed,
missing, tombstoned or expired later catalog valid for publication.

Repeated physical identity/credential observations cannot acquire different owners or preimages.
All retained rows and canonical bytes charge the original input's record/byte lower bounds;
the server-owned acquisition meter must additionally charge every failed, repeated and discarded
attempt. Neither normalization nor deduplication creates new credit. The full canonical material
and encoded envelope each preserve the aggregate 64 MiB ceiling.

## Canonical integrity and compatibility

[Version 0.2 encoding](../../packages/contracts/src/release-decision-current-authority-encoding.ts)
uses separate v2 material/header/page domains and retains the proven 2,048-byte frames, 128 frames
per page, maximum 256 pages and tested 512 KiB header/page response headroom. Historical 0.1
domains, code and independent vectors retain their original meaning and bytes.

The [private codec](../../packages/core/src/release/release-decision-current-authority-snapshot.ts)
checks exact scope/decision/input/header/page ownership, domains, canonical bytes, strict UTF-8
and digests. It recomputes the input digest, owning immutable candidate/policy/selection/reviewer/
approval definitions, logical-root projection digests and summary assurance. For observed
original evaluations it reuses sealed original semantic inspection and binds the retained actor
report to exact original witnesses and root authors. Hashes alone cannot recover non-root actor
identities or authenticate content/credentials; fixed owning source validation remains required.

Four [independent vectors](../../packages/contracts/vectors/release-decision-current-authority-snapshot-v2.json)
were generated with Python compact UTF-8 JSON, hashlib and base64, without importing the JS codec
or schemas. They cover missing originals, synthetic observed authority, unavailable authority and
an original synthetic approval binding. Their explicit unavailable source views and synthetic
receipts do not establish a live current authority flow. Tests also preserve the old 0.1 bytes,
exercise real multiple pages and split Unicode, and reject tampering after outer hashes are
recalculated. Structural approval fixtures are not authenticated native approvals.

A separate standalone memory model creates a new request at its own synthetic capture cut before
enqueue, sealing and deterministic computation. It rebuilds that request's manifest and synthetic
lifecycle projections without modifying archived vectors or native receipts. Its complete original
graph/pages round-trip while current selection, identity and upstream actor availability remain
explicitly unavailable. Counterexamples replace an original actor witness or rehash a forged rule
result and all owning result references; the codec still rejects them. This is historical semantic
integrity evidence, not live acquisition, authentication or a valid release decision.

## Publication boundary and next work

The [target-owned selection memory/shared repository](workflow-2-selection-repository.md) starts
the owning persistence boundary. It does not supply native or actual current decision authority.

`complete`, `observed` and `underGuards` are retained data fields, not proof of actual source
enumeration, private authentication or held locks. Decoding ends without permission to publish.
An expired original session can remain historical evidence; current authority resolution must
separately distinguish natural expiry from revocation, changed identity and current grants.

Next compose the fixed owning readers and one original meter, resolve normal and exception
controls against complete current authority, and implement shared memory/native conformance.
The native writer must validate current migration/recovery epoch and retain all identity/source/
absence guards through atomic immutable graph/decision/canonical outbox publication. Capture
content/key I/O outside those guards. Then complete reservations/recovery, authorization-first
API/SDK, actual service contributor acceptance and the separate checkpoint 4 exit audit. No
caller-supplied snapshot, actor report or stale successfully decoded view can substitute.
