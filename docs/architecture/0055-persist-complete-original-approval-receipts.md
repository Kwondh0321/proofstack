# ADR-0055: Persist complete original approval receipts

Status: Accepted trusted storage design. Actual current approval/decision authority and
checkpoint 4 acceptance remain open.

Date: 2026-10-16

## Context

An approval's full definition hash binds its original OIDC receipt, authority and recording time.
The existing shared repository deliberately compares retry intent and reviewer principal instead:
a new login or derived current authority must return the first stored receipt. Complete subject
reads must retain opposition, escalation, abstention, expiry, conditions, conflicts, supersession
and revocation. A favorable latest row cannot substitute for that inventory.

## Decision

Migration 0067 adds five private immutable normalized tables: original approvals, six exact
subject references, ordered condition/conflict declarations, compensating control references and
revocations. Exact-scope foreign keys, canonical original bytes/hash, complete deferred graph and
ordinal checks, causal native time and canonical outbox intent bind each whole write. One original
has at most one successor and one revocation. Upstream reference retention does not establish
current upstream authority; these trusted storage fixtures do not require populated owning domains.

Equal approval intent plus principal returns the entire original record. Fresh authentication,
authority and recording receipts cannot replace it. Revocation first validates the original exact
reference, principal and causal order, then compares retry intent and retains its first receipt.
Conflicts, invalid lineage, incomplete projections or mismatched outbox roll back wholly.

All five tables use forced exact-scope RLS and append-only protection. Mandatory insert triggers
take an exclusive coarse tenant approval guard. The private nonwaiting shared reader guards before
its VOLATILE READ COMMITTED subject-presence observation. Fixed 16-entry keyset pages retain every
original of the exact kind and full subject and all revocations, without latest/action/expiry
filtering. This is a separate C4 guard domain; existing C3 guards are unchanged.

The owning adapter re-encodes full original definitions and compares all normalized fields,
references, ordered declarations/controls, parent/successor lineage and intent. Raw source bytes,
every repeated original observation, packed metadata, absence and pages use the original server
meter before interpretation. Failure taints the same meter; limits cannot yield a truncated census.
Native UTC text retains full contract precision, with numeric order keys transported as text.
Authentication receipts retain the existing millisecond contract.

## Consequences

The adapter implements the existing trusted memory/shared port without changing public contracts.
Parsed stored OIDC receipts do not authenticate a current actor. No new runtime role, default
grant, route, worker or publisher is introduced. Provisioning removes stale table/function access
from all existing managed runtime roles and PUBLIC. Recovery retains every normalized table,
original receipt, causal history and canonical intent, including nonempty exception controls.

Provided-client readers retain the caller's explicit scoped connection and guards. Convenience
repository reads end their transaction before returning. A detached inventory cannot authorize
later publication. The future fixed publisher still needs actual authentication, complete current
source/absence/selection/reviewer/control closure, dedicated roles, migration/recovery epoch,
bounded DB-time validity and one held transaction through atomic immutable decision/outbox.

See the [native approval guide](../development/workflow-2-native-approval-repository.md),
[original shared semantics](../development/workflow-2-approval-repository.md) and
[checkpoint entry requirements](../development/workflow-2-decision-entry-audit.md).
