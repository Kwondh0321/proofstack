# Workflow 2: exact control-record readers

[한국어](workflow-2-policy-evaluation-control-record-readers.ko.md)

Status: an internal record-acquisition prerequisite for deterministic policy evaluation, not
checkpoint completion, release authorization, or a production policy worker.

## Exact reads and receipt boundaries

`readPolicyEvaluationControlRecord` in `@proofstack/core` acquires one exact record through
existing read-only domain ports. The caller must already be authorized for the requested scope;
this helper does not authenticate a caller or grant access to a tenant.

| Manifest source kind | Existing read operation | Stored receipt |
| --- | --- | --- |
| `comparison_definition` | `findComparisonDefinition(scope, comparisonVersionId)` | `createdAt` |
| `comparison_snapshot` | `findComparisonEvidenceSnapshot(scope, snapshotId)` | `createdAt` |
| `comparison_result` | `findComparisonResult(scope, resultId)` | `createdAt` |
| `release_candidate` | `findReleaseCandidate(scope, candidateVersionId)` | `createdAt` |
| `release_policy` | `findReleasePolicy(scope, policyVersionId)` | `publishedAt` |
| `policy_installation_binding` | `PolicyInstallationBindingResolver.resolve({ scope, reference })` | `registeredAt` |

The snapshot manifest name maps to the existing `comparison_evidence_snapshot` domain validator.
The binding resolver is operator-owned infrastructure, not a requester-supplied claim of authority.
No latest-version selection, fallback store, lifecycle query, child read, or write is introduced.

Input scope, exact source reference, and evaluation time are strictly captured before repository
I/O or record inspection. Read ports receive separate copies. Fixed domain validators parse the
complete record and recompute its semantic digest before any JSON transport normalization.
Unknown fields, including undefined-valued unknown fields, cannot disappear before validation.
Schema-admitted values that the domain canonical encoder rejects, such as an undefined semantic
predecessor, remain invalid rather than being silently removed.

All three scope dimensions and every source-reference field must match, including snapshot role.
Stored receipts retain each domain's canonical millisecond timestamp schema; evaluation cuts
retain the finer precision supported by the policy evaluation contract. A receipt equal to the cut
is admissible; a later receipt is not. `effectiveAt` is not a publication receipt. A policy can be
record-verified before it is semantically effective; that does not authorize its use.

The shared internal definition reader now supports a fixed receipt selector, required by its type
contract for records without `createdAt`. It never inserts a synthetic `createdAt`. A broken
explicit selector cannot silently fall back to a different timestamp. The observation SHA-256
binds the entire validated canonical record, including its original receipt metadata, separately
from the domain's semantic definition digest.

## Outcomes and reinspection

- Only an exact read returning `null` produces `missing`.
- Recognized domain validation failures produce `unavailable / record_invalid`.
- A valid record with a different scope or reference produces `unavailable / reference_mismatch`.
- A valid matching record received after the cut produces `unavailable / not_yet_available`.
- A matching admissible record produces `verified` and its complete record hash.
- Storage failures and unexpected exceptions outside recognized domain validation failures
  propagate; they are not manufactured as absence or a favorable result.

`inspectPolicyEvaluationControlRecord` applies the same validation to a materialized record without
I/O. Its output must be bound to the previously captured source and complete observation hash before
dependency expansion. Supplying a record or `null` does not prove acquisition provenance or store
completeness. Neither entry point re-derives comparison outcomes, verifies child availability,
checks revocation/effectiveness, establishes current installation authority, approves a release,
or seals a policy-evaluation snapshot.

## Verification and remaining work

Tests cover all six kinds using owning-domain fixtures, an independent sorted-JSON hash oracle,
and actual memory repositories plus the installation binding resolver. They exercise every exact
reference field and scope dimension, cross-family substitution, corrupt digests, unknown fields,
invalid versus missing responses, canonical receipt rejection, fine-precision evaluation cuts,
receipt-sensitive hashes, pre-I/O input capture, record-accessor mutation, output isolation,
single-port routing, and original storage-error propagation. Shared-reader tests additionally
cover missing or failing receipt selectors and the absence of synthetic receipt fields.

This adds six kinds to the prior 35 record-level acquisition kinds: **41 of 44** manifest source
kinds have readers. Direct dependency enumeration remains **35 of 44**; these are narrow inventories,
not phase or product completion percentages. Replay runtime profiles, replay isolation profiles,
and runtime adapters still need acquisition. The six control kinds still need dependency
enumeration. Recursive capture, unresolved-selector resolution, retained artifact bytes, global
budgets/conflicts, authority and lifecycle revision guards, snapshot sealing, deterministic rule
execution, and durable worker/API/SDK integration remain separate requirements of the
[checkpoint entry audit](workflow-2-policy-evaluation-entry-audit.md).

These tests do not claim a new PostgreSQL integration, artifact-content verification, a deployed
worker, or checkpoint acceptance. See the preceding
[definition readers](workflow-2-policy-evaluation-definition-readers.md) and
[replay dependency enumerators](workflow-2-policy-evaluation-replay-references.md) for adjacent
proof boundaries.
