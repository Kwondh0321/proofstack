# Retained policy authority prerequisites

[English](workflow-2-policy-authority-prerequisites.md) | [한국어](workflow-2-policy-authority-prerequisites.ko.md)

Status: request-rooted static authority inspection implemented. Workflow 2 checkpoint 3 remains
open, with **2/7** checkpoints accepted. This is not a current-authority certificate, policy result,
sealed snapshot, permission grant or release decision.

## Composition and provenance

`capturePolicyArtifactEvidence` now returns `policyAuthority` alongside the original graph, trace,
artifact observations and fixture bindings. Its fixed internal inspector reads only the exact
release-policy root, installation binding, supporting and counterevidence source/review pairs,
reviewer qualifications and artifact observations from that invocation. No repository lookup,
search, network retrieval, replacement source or user-selected verdict is added. The package root
exports the report type, not the internal arbitrary-graph inspector.

The report retains the policy source reference, original full-record hash, exact evaluation time,
dependency-edge indexes, artifact-capture indexes and cumulative inspection usage. Rule source
occurrences are also inspected and charged, even when the same source pair already appears in the
policy. Original nested source, review and reviewer artifact occurrences remain traceable to their
parent hashes and JSON pointers. Deduplication for the owning authority function happens only after
occurrence admission; it does not remove original evidence or repeated usage.

Authority artifacts include installation evidence, source content, publisher-identity evidence,
review basis and reviewer credentials. A verified retained-byte observation is required for
availability; a catalog row, URL, descriptor or matching declared hash alone is insufficient.
Missing objects and authenticated-content failures remain unavailable. The original artifact
observation preserves the specific reason. Artifact access still requires the existing actor,
scope and classification checks, without granting publication or evaluation authority.

## Publication time and evaluation time are different

The core's `validateReleasePolicyEvaluationAuthority` reuses the existing installation/source
requirements but checks the policy's half-open `[effectiveAt, expiresAt)` interval at the request's
semantic `evaluationTime`. The capture clock does not make an earlier policy effective or extend
an expired policy. The recorded policy publisher, not the artifact-reading principal, is checked
against the installation's issuer and mode authority.

`validateReleasePolicyAuthority` remains the publication validator: a policy may be published
before it becomes effective. Its request time remains UTC millisecond precision. The new
evaluation validator accepts the existing UTC policy-evaluation timestamp contract, preserving up
to 30 fractional digits. Both functions now compare retained source timestamps without rounding
to database microseconds; supported source offsets keep their original values and digest bindings.

Existing source requirements still apply: exact scope/reference links, full policy-interval
coverage, declared applicability, licensing, independent publisher identity, review conclusions and
freshness, conflict review, qualified and independent reviewers, and retained authority bytes.
This does not establish that a declared identity, human expertise, review or source assertion is
true in the world. Searching for a newer document cannot silently replace the bound authority set.

## Failure semantics and limits

`requirements.status` is `valid` only when these static requirements have no findings. It is
`invalid` for unmet **or unavailable** requirements; it is not a final policy classification and
must not turn missing evidence into a confirmed policy violation. The original record and artifact
observations distinguish absence, invalid records, reference mismatch and availability failures.
The owning validator cannot infer dependent relationships when a required source/review is missing;
its findings are not an exhaustive counterfactual diagnosis of unseen records.

Root failure follows the existing `roots_unavailable` branch without a fabricated authority report.
Unexpected storage errors propagate. Broken internal parent hashes, missing dependency edges,
duplicate origins, substituted artifact scope/time/reference and conflicting repeated observations
abort capture rather than manufacture a normal result.

One inspection meter covers the whole policy, including counterevidence and repeated rule/nested
dependencies. Limits use the request's acquisition-record count and byte ceilings, applied to each
dependency occurrence and its canonical reference bytes before use. These inspection counters are
separate from actual metadata/object I/O usage. They are neither a CPU timer nor durable retry
accounting. Existing object, classification, monotone-clock and final retention checks remain active.

## Verification and remaining boundaries

Tests use actual memory publication repositories, the installation-owned binding resolver and
encrypted artifact catalog/object storage. They cover complete static prerequisites, an unrelated
artifact-reader identity, exact time edges, schema-admitted adverse authority, separately published
counterevidence/conflicts, missing and corrupt records, storage exceptions, missing/tampered bytes,
repeated provenance, exact cumulative limits, defensive copying and internal consistency failures.
Other candidate dependencies deliberately remain missing in these fixtures: static policy validity
is not evidence that the full candidate graph is complete. No PostgreSQL policy-worker or release
acceptance is claimed by these tests.

Terminal withdrawal/supersession history, current authority and artifact revision guards, atomic
snapshot publication, policy predicates, durable worker fencing/retries, API/SDK, recovery/isolation
and end-to-end checkpoint acceptance remain open. A static `valid` report must never bypass those
remaining gates or authorize a release.
