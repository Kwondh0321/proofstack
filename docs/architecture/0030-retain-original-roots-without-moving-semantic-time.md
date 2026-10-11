# ADR-0030: Retain original roots without moving semantic time

[English](0030-retain-original-roots-without-moving-semantic-time.md) | [한국어](0030-retain-original-roots-without-moving-semantic-time.ko.md)

- Status: Accepted
- Date: 2026-10-11

## Context

Owning repositories retain first-storage resource bindings separately from record JSON and receipt
order. Ordinary source reads hide future bodies from semantic evaluation. Discarding all original
material prevents full storage reinspection; a fabricated future cut would change request semantics.

## Decision

Use fixed domain capture readers to retain validated full storage/hash/receipt beside the unchanged
semantic read. Compose optional fixed owning root ports above domain packages, selected by exact
captured child. Retain every binding origin, explicitly map comparison aliases, and validate complete
root bodies, logical IDs, scope and shared identity/hash consistency. Request roots and semantic
operands remain separate from original-storage provenance.

PostgreSQL exposes these ports on the existing held scoped metadata connection after barrier/ledger
checks, with taint/drain/expiry behavior. Meter actual calls/bodies and compare parent/root material
before descendants. Missing configuration remains a frontier and cannot silently upgrade on recheck.

This accepts a read-only prerequisite. Root-only inventory/relevant relationships, semantic/current
authority closure, internal SQL admission, sealed contracts, live worker/lease/fence checks and atomic
publication remain required by [ADR-0022](0022-snapshot-bound-policy-evaluation.md). No migration,
role, grant, production composition or public root/snapshot API is introduced.

## Alternatives

- Advance inspection time to recover future bodies: rejected because it promotes unavailable input.
- Choose oldest/latest receipt or walk predecessors: rejected because first-storage binding differs.
- Invent `/root` fields or caller-selected request roots: rejected because this is normalized storage.
- Substitute root dependencies for current candidate operands/authority: rejected because provenance
  and semantic-use origins require different explicit relationships.

## Consequences

Ordinary APIs stay compatible. Capture preserves more material and charges repeated root calls.
Complete inventory must retain every origin while rejecting conflicting shared identities/bodies.
The read transaction ends before the report returns; it cannot authorize later sealing/publication.
Workflow 2 remains two of seven accepted checkpoints. See the [English/Korean guide](../development/workflow-2-policy-logical-root-capture.md).
