# Recorded-fixture artifact binding observations

[English](workflow-2-policy-fixture-bindings.md) | [한국어](workflow-2-policy-fixture-bindings.ko.md)

Status: recorded-fixture publication bindings are checked during request-rooted artifact capture.
Complete semantic closure, mutable authority, guarded sealing and Workflow 2 checkpoint 3 remain open.

## Why byte integrity is not enough

A decryptable file with the expected digest can still belong to another fixture, have a different
publisher, or describe different redaction/retention terms. Conversely, an intact ownership record
does not prove the bytes still exist. Keep these observations separate; neither is a policy verdict.

The invariants come from [ADR-0017](../architecture/0017-own-interaction-content-per-fixture.md) and
the existing memory/PostgreSQL fixture publication paths. This does not introduce a new ownership
requirement for ordinary candidate build files, general trace references, or evidence-only fixtures.

## Owning-domain inspection and trusted composition

`inspectPolicyEvaluationFixtureArtifactBindings` in `@proofstack/datasets` accepts a previously
captured exact schema-0.2 fixture and one ordered catalog projection for each declared binding. It
revalidates the immutable fixture once against the scope, reference, evaluation time and original
full-record digest. A replaced publication receipt fails even when the definition digest is unchanged.
Malformed, sparse, short or extra projection inventories fail rather than silently skipping bindings.

The inspector is pure. It performs no repository, object, network or plaintext reads and accepts no
pluggable validator. Catalog metadata/ownership projections are validated, but their full private
catalog hash cannot be recomputed from those projections. That digest is provenance from the fixed
[artifact observer](workflow-2-policy-artifact-observation.md), not proof supplied by an HTTP caller.

The public `capturePolicyArtifactEvidence` path now derives these inputs from **its own** acquired
graph and artifact observations. Its internal fixture composer is not exported from the package root.
It groups every direct recorded-fixture occurrence, including request, prompt and attempt aliases,
without dropping any original artifact reads or resetting metadata/object budgets. Contradictory
repeated observations still fail before binding inspection.

`fixtureBindings` retains each verified recorded fixture's exact source and full record digest. Each
binding includes its `bindingIndex`, artifact ID, observed catalog digest and `artifactCaptureIndexes`
pointing to every direct fixture occurrence in the same result. The original graph edges preserve
the parent record hash and JSON pointer. General build/trace occurrences remain separately available;
the fixture-specific result does not automatically reinterpret them as fixture-owned content.

An unreadable parent retains the graph's unresolved observation; its unknown binding inventory is
not invented. An empty `fixtureBindings` list therefore does not prove there are no missing fixtures.
`roots_unavailable` does not return a successful empty binding inventory.

## Binding outcomes

| Outcome | Meaning |
| --- | --- |
| `matched` | All inspected immutable publication-binding fields agree |
| `unavailable / catalog_unavailable` | The artifact observer has no usable catalog projection; the original read retains missing/invalid/unsupported/mismatched detail |
| `mismatch / scope_mismatch` | Catalog tenant, project or environment differs from the fixture |
| `mismatch / descriptor_mismatch` | Exact artifact ID, digest, size, media type, classification or redaction-stage descriptor differs |
| `mismatch / retention_mismatch` | The catalog does not retain the fixture's required non-expiring content |
| `mismatch / redaction_mismatch` | Redaction status or complete ordered redaction records differ |
| `mismatch / publication_time_mismatch` | No activation receipt exists, or creation/activation follows fixture publication |
| `mismatch / ownership_missing` | A known catalog lacks an ownership record |
| `mismatch / ownership_mismatch` | Owner fixture/version, scope, artifact ID, binding time or binding principal differs from the exact publication |

Only the first mismatch in the table's inspection order is reported; this is not an exhaustive list
of every defect in a corrupted catalog. Every declared binding is still inspected. Ownership must
equal the canonical record produced at publication: `boundAt === fixture.createdAt` and
`boundByPrincipalId === fixture.createdByPrincipalId`, not merely a plausible owner ID. Creation and
activation comparisons preserve full supported timestamp precision instead of rounding to milliseconds.

A later tombstone/purge does not erase the immutable owner binding. Such a binding may remain
`matched` while the independent artifact read reports unavailable content. The same separation holds
for a missing object. Consumers must not turn `matched`, successful decryption, or `artifacts_captured`
alone into satisfaction, release permission or a sealed snapshot.

## Verification and remaining boundaries

Dataset tests exercise exact reference and receipt binding, every ownership dimension, descriptor
and scope substitutions, complete redaction records, retention, timestamp equality and sub-millisecond
edges, invalid inventories and detached results. Composition tests use real fixture publication,
memory graph/evidence repositories, synthetic interaction bytes, and authenticated artifact encryption. The separate memory
catalog is populated through its existing test-only ownership bridge; this is **not** a claim of a new
cross-adapter transaction or PostgreSQL policy-worker acceptance.

Integration tests distinguish valid bytes with the wrong owner/publisher/binding time, re-encrypted
bytes with conflicting retention/redaction, missing/invalid catalogs, unavailable parents, tombstones,
missing objects, every alias occurrence, and internal composition failures. General artifacts remain
readable without fixture ownership. Existing read budgets and operational error propagation remain.

This does not validate every predecessor/dataset/replay/evaluation relationship, inspect semantic
plaintext, authorize an owner, acquire authoritative revocation/policy lifecycle state, or prevent a
change after observation. Complete those boundaries and transactional revision checks, then snapshot
sealing, deterministic predicates, durable jobs, API/SDK, recovery/isolation and end-to-end acceptance.
Workflow 2 remains **2/7** accepted checkpoints.
