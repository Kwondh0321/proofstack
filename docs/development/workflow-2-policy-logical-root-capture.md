# Original logical roots in policy record capture

[English](workflow-2-policy-logical-root-capture.md) | [한국어](workflow-2-policy-logical-root-capture.ko.md)

Status: trusted read-only storage provenance. Workflow 2 remains **2/7 accepted checkpoints**.
Checkpoint 3 still requires complete semantic/current-authority closure and atomic sealed publication.
See [ADR-0030](../architecture/0030-retain-original-roots-without-moving-semantic-time.md).

## Original storage and semantic time

Fixed capture readers for all 48 installed source kinds retain a
validated original body, canonical full-record SHA-256 and receipt in `storage`. Their `read`
keeps the existing semantic observation at the request's full-precision evaluation time.
A future body has `read.record:null` and `not_yet_available`; retention does not make it an operand.
Ordinary readers retain their previous shape and do not hash discarded future bodies.
Validation still checks the owning definition digest, every exact reference field, scope and receipt.
Invalid/mismatched bodies are not retained as valid storage. Missing observations and recognized
invalid records stay separate from repository errors. Semantic/storage bodies are detached copies.

The interaction fixture reader still queries both formats and rejects identity conflicts; pure body
inspection does not validate its ownership wrapper or replace those reads. No fabricated future
inspection time, rounded receipt or requester-supplied validator is used.
Graph nodes keep original storage beside semantic reads, including future parents. Independent
closure inspection recomputes the full body/hash/receipt and semantic observation. These families'
verified/future nodes cannot silently lose retained storage. Semantic edges still expand only
available parents. Missing/invalid/context-mismatched bodies do not become valid storage. Protocol
lookup scope failures retain their original candidate in the resolution with null node storage;
descriptor mismatch remains an unavailable parent resolution independently of child body validity.
Replay-result aggregate receipts preserve the latest actual contained timestamp and finite history
admission; neither retention nor complete source-kind coverage establishes complete closure.

## Fixed owning root ports

The [stored declaration enumerators](workflow-2-policy-stored-reference-enumeration.md) reuse
the fixed owning field grammars across all 48 installed source kinds while preserving original
availability. Storage provenance is separate; root-only traversal and complete closure remain open.

Optional server-owned `logicalRoots` supplies five evaluation resource-definition kinds, three
comparison kinds, candidate, policy, dataset and regression fixture. Manifest `comparison_snapshot`
maps explicitly to owning `comparison_evidence_snapshot`. Snapshot/result roots are original
comparison definitions. Interaction fixture roots are original evidence-only fixtures, independent
of later content revocation. Model/human, replay and runtime kinds do not gain synthetic resources.

The exact captured child's scope/kind/ID selects its owning first-storage binding. Receipt order,
predecessor walks and latest lookup do not select roots. Full owning root validation and logical-ID/
scope joins must succeed. A configured reader returning null for a retained child fails capture.
Shared identities cannot have different references/full bodies, including ordinary-node overlap.
Every alias/parent retains its own binding origin.

The asynchronous reader validates and owns the parent before I/O; its private post-I/O inspector
reuses that owned result. Public pure inspection independently validates its supplied parent.
Node-side comparison, hashing and byte accounting reuse strict canonical JSON text with native
UTF-8 processing; hashes and admitted byte counts remain identical to the portable byte encoder.
No evidence cache, relaxed validation or changed test deadline is introduced.
Complete criterion-history inspection reuses each row's canonical text only within its own strict
admission call, preserving the exact full-history envelope/hash and per-row hashes. Subsequent
calls validate current rows again; byte limits, ordering, scope and whole failure remain unchanged.

`graph.logicalRoots` records configuration and sorted bindings. Request roots remain exactly
candidate and policy; original storage is separate from selected comparisons, current candidate
components and current authority. This increment does **not** traverse root-only dependencies into
the complete source inventory or close their relevant storage relationships. That next work must
preserve provenance/semantic-use origins before the sealed flow can be accepted.

Without root ports, each retained rootable parent keeps a `root_port_unconfigured` frontier.
`unresolved.logicalRoots` counts those binding frontiers only; zero does not mean complete closure.
Reinspection preserves the original missing configuration instead of silently upgrading it. Losing
previously configured root ports fails before record I/O.

## Held connection and admission

PostgreSQL metadata transactions expose fixed root readers after the existing barrier/ledger checks,
using the same held connection, exact three-part scope and owning normalized-storage inspection.
They expose no SQL/client, DML, content, keys or publication. Invalid scope/kind/ID fails before source
SQL and taints the operation. Started reads drain before cleanup; caught/unawaited errors cannot
commit and expired ports cannot query. No migration, role, grant or production composition is added.

Graph reinspection compares parent storage and full original roots before following descendants.
This comparison belongs to metadata transaction mode. Source-only recheck keeps its existing
artifact/policy observation scope; it does not recheck all root bindings or root-only dependencies.
Existing edge/graph/trace/artifact/authority checks remain required. Its transaction ends before the
report returns; it cannot authorize later publication. See the [source recheck boundary](workflow-2-policy-source-recheck.md).
The shared request meter counts each actual root call before I/O, including repeated/absent/failed
calls, and charges returned bodies. Deduplication does not refund calls. Complete internal SQL/row/
scan/statement-deadline admission and immutable job-wide budgets remain separate required work.

## Verification

Tests use owning fixtures and independent sorted-JSON full-body hashes. They cover every root family,
comparison aliases, both fixture formats, future cuts, first binding versus receipt order, ownership
of copies, missing configuration, missing/substituted roots, changed-root failure before descendants,
and independent omitted/extra/substituted witnesses. PostgreSQL tests cover fixed held-client reads,
scope taint, lifetime and draining. Existing repository conformance/integrity gates remain required.
Green capture tests do not accept checkpoint 3 or replace sealed/job/API/SDK and independent audits.
