# ADR-0025: Compose authorized policy artifact observations

- Status: Accepted
- Date: 2026-09-26
- Owners: ProofStack maintainers

## Context

[ADR-0024](0024-compose-policy-record-acquisition-above-domain-packages.md) established a fixed,
request-owning composition package above the evidence domains. Its metadata, comparison and exact
trace readers retain artifact occurrences without proving content availability. The artifact domain
now provides an authorized exact observer with encryption, lifecycle and catalog-race validation.
Copying that validation into the composer or accepting caller-supplied observations would bypass
the owning domain. Starting a fresh acquisition budget after trace capture would evade request limits.

## Decision

Extend ADR-0024's dependency allowlist with `@proofstack/artifacts`, enforced by the workspace
manifest and architecture checker. This replaces only its four-package dependency restriction;
fixed validators, request-derived roots, authority separation and its other constraints remain.
Do not add artifact dependencies to core or accept a pluggable artifact validator.

`capturePolicyArtifactEvidence` owns graph, comparison, exact trace and artifact acquisition under
one metadata meter. It receives an authenticated artifact principal and separately authorized
read-only metadata/trace ports. It validates and snapshots the request and principal, enforces
artifact scope/capabilities, and obtains a monotone server-clock window before acquisition.

Visit graph artifact edges in their retained order, then every retained trace artifact occurrence.
Retain the source index and the owning-domain observation, including known absence/unavailability.
Read repeated occurrences again and reject differing catalog/content observations under the same
artifact identity. Do not accept a preassembled graph, discard duplicates, or infer owner eligibility.

Count both catalog reads and their complete raw JSON bodies against the same limits used by graph
and trace acquisition. Before each object request, conservatively reserve its expected encrypted
length against `maxArtifactReadBytes`; retain the reservation on missing, short, invalid or failed
responses. Charge any excess returned bytes before hashing/decryption. Report reservations,
complete-buffer receipts and conservative charges separately. This is invocation-local admission,
not a durable billing ledger or measurement of hidden transport retries/partial reads.

## Consequences

### Positive

- Every observed artifact remains tied to a retained parent rather than a caller-selected URL.
- Content capabilities remain non-transitive: policy or metadata access does not grant plaintext access.
- Cross-phase record/byte limits and repeated observations cannot reset or silently deduplicate costs.
- Storage/key failures stay operational failures, and changed observations cannot form a successful cut.

### Negative

- Repeated occurrences perform repeated reads and can exhaust a deliberately small request budget.
- Conservative object reservations can exceed actual received bytes, especially for missing objects.
- Whole-buffer object ports cannot bound remote allocation, meter hidden retries or observe partial
  transfer bytes. A throwing call terminates this capture; it does not publish a completed result.
- Two catalog reads and a final retention-time check are not a database sealing transaction or an
  atomic global object-store snapshot. A later mutation still requires a sealing revision guard.

### Follow-up

- Validate expected ownership and complete cross-record semantics, then capture mutable authority.
- Guard snapshot publication under authoritative database revisions and execution fences.
- Add durable job-wide accounting and transport instrumentation for retries/partial failures,
  cancellation, deadlines, worker/API/SDK persistence, recovery and end-to-end acceptance.

## Alternatives considered

### Accept caller-collected artifacts or a caller-supplied graph

Rejected because omission, substituted observations or fabricated parent provenance would redefine
the evidence set before the owning acquisition path could validate it.

### Deduplicate repeated artifact observations without a sealing guard

Rejected for this capture boundary: it would hide changes between occurrences. Future optimization
requires authoritative revision/retention guards while preserving every occurrence and actual cost.

### Report complete-buffer lengths as exact transport or job-wide cost

Rejected because the current object-store interface cannot observe partial transfers or hidden
retries. Conservative admission and measured receipts must remain explicitly separate.

## Revisit when

A metered streaming transport or the durable worker provides enforceable job-wide limits and
revision-guarded sealing. Any optimization must preserve source occurrences, non-transitive
permissions, failure evidence and correct accounting. This ADR does not accept Workflow 2 checkpoint 3.
