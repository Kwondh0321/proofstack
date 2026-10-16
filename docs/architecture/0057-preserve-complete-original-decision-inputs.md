# ADR-0057: Preserve complete original decision inputs

Status: Accepted trusted immutable storage design. Atomic external request reservation, current
publication authority and checkpoint 4 acceptance remain open.

Date: 2026-10-16

## Context

The frozen decision input contract retains a publisher receipt, exact candidate/selection, every
selected policy and all planned evaluation definitions before a decision can use their results.
A changed login, clock cut or derived request cannot replace the first original on an equal public
intent retry. Persisting only the root hash would lose the witnesses needed to verify that graph.

## Decision

Add a trusted input repository port, a copy-on-write memory reference and unchanged shared cases.
The owning graph validator reuses the existing complete input binding validator and each domain's
original record validator. It retains the entire original candidate, selection and ordered policy
witnesses, including advisory members and an explicitly empty observation-only selection.

Retry equality binds exact scope, input ID, candidate, selection, rationale and publisher principal,
type and authentication method. Fresh credentials/request receipts, native cuts, expiry, limits and
derived plans return the first complete graph. Changed original intent conflicts. Local planned
request ownership is unique per tenant and commits wholly with the original graph; an equal retry
does not claim newly derived IDs. This ownership is not reservation in the external policy-job store.

Migration 0069 adds three private append-only forced exact-scope RLS tables: original roots, complete
original source witnesses and ordered plans. Exact foreign keys, normalized projections, original
canonical UTF-8/hash, native order keys transported as text, deferred complete graph/ordinal checks
and canonical outbox intent bind whole writes. No new runtime role or default grant is introduced.
Provisioning removes stale private table/function access from existing managed roles and PUBLIC.

Mandatory insert triggers retain a separate coarse tenant input guard through commit. The fixed
VOLATILE READ COMMITTED reader acquires the nonwaiting shared guard before observing root presence
or absence. The supplied-client adapter retains that client, transaction and guard. It compares all
root/plan/source projections, independently validates every full original witness and checks the
original canonical outbox. Individual source-body reads avoid packing sixteen complete policies in
one response. Every raw row, repeated acquisition, missing inventory and intent uses the original
aggregate meter before interpretation; a caught failure permanently taints that cut.

## Consequences

The native and memory stores implement the same trusted original-storage behavior, not actual
authentication, current installation/reviewer authority, pre-outcome planning or release approval.
Synthetic witness fixtures explicitly do not require populated upstream domains. Convenience reads
end their transaction before returning; their graph is no reusable publication seal. Native recovery
retains all three nonempty tables, complete witnesses/plans, original receipts and retry behavior.

Initial authoritative publication must still authenticate the actor, derive the complete owning
selection and sources, hold migration/recovery/metadata and request-absence guards, prove every
planned ID absent across participating C3 writers and atomically reserve them with root and outbox.
Final decision publication needs complete original job/snapshot/result lineage and all current
selection, credential, reviewer, approval/control and absence authority under dedicated roles in
one held transaction through immutable decision/outbox commit. No public route, worker, external
job, decision, signing, deployment or schedule is created by this storage component.

See the [original input repository guide](../development/workflow-2-decision-input-repository.md),
[frozen input contract](../development/workflow-2-decision-input-contracts.md) and
[checkpoint entry audit](../development/workflow-2-decision-entry-audit.md).
