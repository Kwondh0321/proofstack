# Request-owned policy source guard plan

[English](workflow-2-policy-source-guard-plan.md) | [한국어](workflow-2-policy-source-guard-plan.ko.md)

Status: bounded coordinate derivation integrated into authorized artifact capture. Workflow 2
remains **2/7** accepted checkpoints. This plan is neither an acquired lock nor an atomic revision,
sealed snapshot, policy result, worker capability or release approval.

## Scope and ownership

The [installed source serialization domain](workflow-2-policy-source-locks.md) covers exactly two
resource kinds: tenant-wide artifact IDs and release-policy version IDs. A successful
`capturePolicyArtifactEvidence` now returns `sourceGuards` derived internally from that invocation's
validated request, acquired graph, exact trace references, artifact observations and retained
terminal lifecycle history. Callers cannot choose a guard subset, submit a capture graph or select
a different policy root. The derivation function and shared admission meter are not package-root
exports; the coordinate, origin and usage types describe capture output only.

The trusted composer still owns metadata/trace authorization and authenticates the artifact
principal. Plan coordinates acquire no privileges. The enclosing request supplies exact scope and
semantic time; guard IDs follow the existing tenant-wide identity, not digest, logical policy ID,
project/environment or object-store locator. A caller-provided array that resembles this output is
not proof of request-owned acquisition and must not authorize publication.

## Complete coordinates for the installed domain

| Captured source | Guard and retained origin |
| --- | --- |
| Every graph release-policy node, including missing/unavailable versions | `release_policy` + `policyVersionId`; `policy_node` + `nodeIndex` |
| Every graph artifact edge, then every original trace artifact descriptor | `artifact` + `artifactId`; `artifact_capture` + `captureIndex` |
| Every retained supersession successor | `release_policy` + successor version ID; `policy_successor` + `historyIndex` |

Unique coordinates are sorted by code-unit resource kind, then ID. Each coordinate preserves all
origins in capture traversal order. Artifact and policy IDs with the same text remain different
resources. Repeated graph/trace content references are not a license to discard their evidence
occurrences. Missing catalogs, failed content reads and unsupported managed-store descriptors
still have known coordinates. Unsupported descriptors remain unqueried by the artifact reader.
The original observations and complete hashes stay in the capture; origins point back to them.

A successor published after `evaluationTime` can still be retained by the owning lifecycle reader
at the later capture cut. Its guard is included without replacing the exact historical request
policy. Duplicate coordinates require identical full descriptors and observations. Missing versus
verified records, different full receipt hashes, catalog/ownership changes or other conflicting
outcomes abort with `reference_conflict` or `observation_conflict`; the plan does not pick a preferred
observation or infer that differently timed observations are coherent. Existing owning lifecycle
validation continues to bind successor scope, predecessor, exact reference and receipt cut.

Derivation checks the exact graph request, scope, time and ordered roots, the verified policy root
and lifecycle context/full root hash, and the complete artifact-capture sequence against graph and
trace occurrences. Missing, extra, reordered or substituted capture entries fail without a partial
result. Unknown children of an unreadable parent remain unknown. `roots_unavailable` has no
`sourceGuards` field and zero plan usage; it is not a successful empty plan.

## Shared admission and output boundary

Unique guard resources independently obey the immutable request's `maxAcquisitionRecords` ceiling;
exhaustion raises `guard_limit`. Each resource and origin entry is admitted before insertion. The
exact canonical UTF-8 size of the guard array, including brackets and commas, is additionally charged
to the same invocation-wide `maxAcquisitionRecordBytes` budget used by graph, trace, catalog and
lifecycle reads. It does not reset any counter or invent new evidence-reference occurrences.

`usage.sourceGuards` reports `resources`, `origins` and `canonicalBytes`. The last value is the guard
array's canonical size, not a hash, the entire response size or a claim that all temporary allocation
and transport bytes are metered. These bytes contribute to `usage.referenceBytes`; existing raw
record bytes and evidence-reference counts retain their meanings. Exact remaining capacity passes;
one byte less fails with `byte_limit`. A previously fitting request may now exhaust its unchanged
metadata ceiling because this new output is not free.

The function performs no repository, object/key, clock or database I/O. The capture's final clock
and expiry checks run after derivation. It returns independently owned coordinate/origin objects,
not aliases of request or observation inputs. No plaintext, locator, wrapped key, guard-acquired flag,
snapshot digest or evaluator verdict is introduced.

## Verification and remaining publication work

The [derivation tests](../../packages/policy-evaluation/src/derive-source-guards.test.ts) use owning
record inspectors and a separately constructed expected coordinate/origin map. They cover both
resource kinds sharing an ID, every repeat, absence/unavailability, unsupported descriptors, later
and repeated successors, conflicting references/receipts/outcomes, context/composition substitutions,
independent output ownership, resource ceilings and exact shared byte admission.

The [public capture tests](../../packages/policy-evaluation/src/capture-artifact-evidence.test.ts)
exercise the real request-owning memory repositories and authenticated artifact encryption. They
verify complete output coordinates, retained missing predecessor frontiers, a legitimately later
supersession successor, unsupported descriptors without catalog I/O, rejection of caller-supplied
subsets before I/O, unchanged acquisition call counts and unchanged reference-occurrence counting.
These are composition and unit checks, not a newly implemented PostgreSQL publisher acceptance test.

The forthcoming publisher must derive or independently verify this complete request-owned plan,
acquire every required guard on one scoped READ COMMITTED connection and roll back the whole
transaction on any nonblocking acquisition failure. It must use the
[transaction-local normalized reads](workflow-2-policy-transaction-reads.md) in subsequent statements
and independently compare all relevant source presence, complete records, policy lifecycle,
artifact ownership and time-dependent availability before atomic snapshot/job/fence publication.
No object/key I/O may occur while guards are held; no partial/unguarded fallback is allowed.

The current two-kind domain does not serialize every missing immutable upstream record, unresolved
selector or mutable authority source. A complete policy snapshot must close those boundaries rather
than treat this plan as proof of globally atomic recursive evidence. Lock orchestration, current
migration verification, dedicated worker privileges, durable admission/retries/deadlines, snapshot
contracts, pure predicates, jobs, API/SDK, cancellation, recovery and end-to-end acceptance remain
open. Coordinate completeness for this installed domain does not accept checkpoint 3.
