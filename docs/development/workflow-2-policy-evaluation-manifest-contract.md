# Policy evaluation dependency manifest contract

[English](workflow-2-policy-evaluation-manifest-contract.md) |
[한국어](workflow-2-policy-evaluation-manifest-contract.ko.md)

Status: implemented manifest building block; the policy-evaluation checkpoint remains open.

This slice implements the immutable source inventory required by
[ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.md) and the
[evaluation entry audit](workflow-2-policy-evaluation-entry-audit.md). It does not implement a sealed
snapshot, source acquisition, policy results, a worker, persistence, or a public endpoint. Manifest
integrity does not establish source truth, policy satisfaction, human approval, or release authority.

## Exact references and observation meaning

The [reference contract](../../packages/contracts/src/policy-evaluation-source-reference.ts)
preserves 44 typed source kinds: candidate/policy/binding versions, datasets, fixtures, comparison
definitions/results/snapshots, assessment/aggregate/run/observation graphs, source/reviewer
qualification, model/human assurance, replay results, and runtime references. Existing reference
schemas are reused; discovery/run-rejection references reuse existing identity and digest fields.
Arbitrary JSON, URLs, mutable aliases, and caller-selected operands cannot replace these references.

Identity is `kind:recordId`, ordered by ASCII code units, not locale or digest. The record ID is the
repository's immutable version/result/attempt ID, not a redundant logical parent ID. Runtime and
isolation profile definitions use `kind:id:version`. Changing a digest, logical parent, comparison
role, or replay job under one record identity is a conflict, not another source entry. Different
source kinds remain distinct even when their IDs or JSON shapes happen to agree.

Each entry contains one exact reference and one capture-derived observation:

- `verified` retains `recordSha256`: SHA-256 of `encodeEvaluationCanonicalJson(record)` for the
  complete validated retained record, including original receipt fields when present. This differs
  from the source's existing semantic definition digest. Capture must independently validate the
  source-specific schema, exact scope/reference, original definition digest, and projections.
- `missing` means an exact authoritative lookup established absence at the capture cut.
- `unavailable` retains `record_invalid`, `reference_mismatch`, or `not_yet_available`. Corrupt or
  future evidence is not zero, a successful empty set, or permission to omit an entry.

Unexpected repository errors, network failures, worker interruption and retry state are operational
failures, not source observations. Unknown/corrupt candidate or policy roots must prevent a usable
snapshot. The manifest schema alone does not identify roots or waive that later requirement.
Artifact ownership, byte availability and mutable lifecycle revisions need separate snapshot
observations and sealing guards. A nested artifact reference does not verify retained bytes.
Embedded criterion members remain bound by their owning record and need exact later rule projections.

## Fixed pagination and canonical binding

The [manifest contract](../../packages/contracts/src/policy-evaluation-manifest.ts) fixes:

| Boundary | Limit and invariant |
| --- | --- |
| Inventory | 2–100,000 entries; the later job must also enforce its smaller requested cumulative acquisition budget |
| Page | 128 entries except the final nonempty remainder; exact zero-based index, total count, manifest ID and request ID/digest |
| Root descriptors | Every page, at most 782; exact digest, count, first/last key and disjoint increasing ranges |
| Read representations | Separate 512 KiB UTF-8 root/page response budgets, including metadata and escaped HTTP correlation ID |

Page hashes bind all entries/observations, index, count, manifest ID, request, scope, schema and
encoding domain. Root hashes bind the complete ordered descriptor table with the same request and
scope. Pages refer to the manifest ID; the root binds page hashes; the later snapshot must bind the
exact root hash. This avoids a digest cycle. Reads must use that immutable root and page index, not
a mutable `latest` cursor.

`assemblePolicyEvaluationManifest` requires preordered capture-derived entries. It never silently
sorts, deduplicates, fills absence, drops unavailable entries, or truncates an oversized set.
`validatePolicyEvaluationManifest` checks the expected root/request/scope, recomputes every digest,
and compares the full reference sequence with a separately supplied expected closure. Equal counts
alone are insufficient: every kind, identity, digest, role, target/result and timestamp spelling
must agree. Structural schema success is not cryptographic verification.

The expected closure must later be derived from authoritative roots/dependencies, not copied from
the manifest or provided by a public caller. A missing parent leaves an unavailable frontier;
unknowable descendants cannot satisfy a rule. The validator detects deviation from the supplied
closure, not whether that closure itself is authoritative or complete. Capture/repository acceptance
must establish that separate fact and include all dependencies actually used.

The [public vectors](../../packages/contracts/vectors/policy-evaluation-manifest-v1.json) were
calculated with an independent sorted-key JSON serializer. The page is 982 UTF-8 bytes with SHA-256
`2fc339b5ba692ae9f457b4bb9aa66e7ac2b2a2f4e8149def4fe9a84bc63e13fc`; the root is 676 bytes with SHA-256
`b88de1f231975fa1c5d5338355977af0890db9dbe1a54879f4b27d62436d1504`.
Source digests in these vectors are synthetic, not claims about retained real evidence.

## Validation and remaining gates

Tests cover all kinds, identity conflicts despite changed hashes/parents/roles, explicit absence,
page boundaries, omission/duplication/reordering, scope/request substitution, forged hash claims,
full recomputation and expected-closure mismatches. The core also assembles and verifies the entire
100,000-entry/782-page ceiling without dropping entries.

Representation tests use a full root with maximal profile keys and a full page of maximal replay
references: 64-character IDs/versions, 256-character protocol names, 255-character media types,
30-digit fractional timestamps and bounded integers. Correlation IDs include Korean, emoji, control
characters, lone surrogates, quotes and backslashes. Exponent-to-integer expansion is covered.
These are representation headroom tests, not HTTP streaming enforcement, a memory/performance
benchmark or production SLO. Acquisition byte budgets and concurrency still need job enforcement;
full inventories must not become one unbounded HTTP response.

The separate
[comparison-selection building block](workflow-2-policy-evaluation-comparison-selection.md) now
accounts for every candidate comparison result and preserves unreadable and ambiguous sets. The
[comparison-lineage building block](workflow-2-policy-evaluation-comparison-lineage.md) validates
the selected definition and snapshots, re-derives the result, and emits a bounded direct-source
frontier. Still required here are recursive authoritative closure derivation, subordinate-record
verification, typed rule evidence, artifact/lifecycle observations, guarded capture/sealing,
snapshot/result contracts and durable jobs with separate worker authority. HTTP/SDK implementation must test
just-below/exact/over-limit streamed bytes, immutable identity and complete pagination. Response
schemas do not expose endpoints. This slice does not change the roadmap's completed item count.
