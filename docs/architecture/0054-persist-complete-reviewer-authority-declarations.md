# ADR-0054: Persist complete reviewer authority declarations

Status: Accepted declaration storage design. Actual issuer authorization, complete current
approval/decision authority and checkpoint 4 remain open.

Date: 2026-10-16

## Context

A reviewer's original declaration includes roles, independence groups, qualifications/provenance,
basis references and explicit relationships, conflicts and unresolved reasons. A favorable latest
verified row cannot replace the target's complete original inventory or erase revocation. Stored
`human`, `verified` or `operator_verified` labels do not independently establish expertise.

## Decision

Migration 0066 stores exact reviewer target roots, immutable original versions, ordered role/group
memberships, declarations, every basis reference and terminal history in six normalized tables.
The original root belongs to exact tenant/project/environment/installation/gate/reviewer. Scope
foreign keys, complete deferred projection/ordinal/lineage constraints, canonical definitions and
canonical outbox intent bind the whole graph. Each version accepts one terminal event. Equal
intent retries retain first publication or terminal actor/time; conflicts roll back wholly.

All six tables use forced exact-scope RLS and append-only protection. Mandatory insert triggers
take an exclusive tenant reviewer transaction guard. The private complete-root reader acquires
the shared nonwaiting guard before its VOLATILE READ COMMITTED SPI observation. Missing targets,
future/competing versions and subsequent revocations remain protected until the caller ends its
transaction. This separate coarse C4 guard does not widen the accepted C3 metadata domain or
establish measured throughput. The exact-scope and native precision helpers from 0065 are reused.

The owning adapter derives the original installation/gate/reviewer root, then reads every version
and terminal through fixed keyset pages. It re-encodes canonical definitions and compares full
normalized original, membership/declaration/basis, lineage and intent observations. Preserve
synthetic/unverified/rejected state, conflicts and every basis occurrence. No caller-picked
authority ID, latest lookup, verified-only filter or budget-truncated prefix is accepted.

Use the same original verification meter for raw source bytes, packed record counts, absences,
pages and repeated relationship observations. Failures taint that same meter. Full-precision UTC
receipt text and numeric ordering survive native reads; JSON order keys are strings, never rounded
JavaScript numbers. Existing canonical and reviewer contracts are unchanged.

## Consequences

Private storage accepts trusted declarations through the existing memory/shared port. It creates
no actual issuer authenticator, proof of reviewer expertise, runtime role, default grant, public
route, worker or decision publisher. Runtime provisioning removes restored stale access to all
private tables/functions from existing managed roles and PUBLIC. Recovery fixtures retain the
entire graph and original receipts; complete current decision recovery remains a separate gate.

Provided-client helpers leave the caller's explicit scoped transaction and guards held. The
convenience repository ends its own read before returning. A detached census cannot publish later.
The future fixed publisher must combine actual issuer/reviewer/publisher authentication, current
complete selection/identity/authority/basis/control/absence closure, bounded validity and current
migration/recovery epoch on one held connection through atomic decision/outbox publication.

See the [English/Korean native reviewer guide](../development/workflow-2-native-reviewer-repository.md)
and [checkpoint entry requirements](../development/workflow-2-decision-entry-audit.md).
