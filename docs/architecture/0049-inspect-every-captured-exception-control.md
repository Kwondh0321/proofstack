# ADR-0049: Inspect every captured exception control

Status: Accepted captured control-observation prerequisite. Exception quorums, actual owning
acquisition, current publication authority and checkpoint 4 remain open.

Date: 2026-10-16

## Context

An exception declaration retains up to sixteen exact compensating-control references. Previously
captured bytes must not hide a missing last occurrence, later catalog change, revocation or native
expiry. The existing captured-control contract preserves those facts but does not resolve them.
Retained bytes and reviewer claims do not establish a control's effectiveness.

## Decision

Add an internal pure inspector for one original canonical rule-exception approval and every known
numeric control occurrence. Match exact approval digest, scope, index and content reference; reject
duplicates, unknown occurrences, future capture/action receipts and inconsistent current public
catalog observations for one physical artifact. Return every original occurrence in numeric order,
including missing, uninspected, unverified, changed, expired and unavailable observations.

Retained evidence requires verified captured content, the same complete sanitized catalog plus
owning record digest under guards, native availability/creation/ownership receipt order and expiry
strictly after the supplied full-precision cut. Retain the earliest actual catalog expiry only
when every original occurrence is retained. No catalog deadline is invented for indefinite storage.
Opaque full-record catalog hashes cannot be recomputed from the sanitized projection: the owning
artifact reader and native source ports must establish those original preimages independently.

Use the same original server-owned admission meter for the approval, complete observation and
its retained content/catalog projections. Unknown outer fields and fake meter callbacks are
rejected. Owning acquisition must additionally charge every actual failed, discarded, repeated
and relationship read to this same meter. A retained-observation meter is not a complete I/O ledger.

## Alternatives and consequences

Reject a favorable subset, lexical index ordering, digest-only catalog equality, Date-rounded
expiry and converting an uninspected control into verified bytes. Return owned public references,
without plaintext, keys or locators. Conditions, opposing actions, quorum and original rule outcomes
are not changed by this inspection. Even an opposing action can retain its evidence without
becoming support. No default exception authority or reviewer requirement is introduced.

The future owning composition must derive exact subjects and installed reviewer requirements,
authenticate actual users, establish current authority, retain every action and lifecycle, compare
shared physical source preimages across all approvals, and retain guards through atomic publication.
This per-approval captured-data report provides none of those boundaries or control-effectiveness
proof. No native role, grant, migration, route, decision or deployment is introduced.

See the [control-observation guide](../development/workflow-2-captured-exception-controls.md).
