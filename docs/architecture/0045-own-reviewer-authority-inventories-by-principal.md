# ADR-0045: Own reviewer authority inventories by principal

Status: Accepted memory/shared reviewer repository design. Private issuer authorization, native
persistence and checkpoint 4 remain open.

Date: 2026-10-16

## Context

Reviewer declarations alone do not prove who owns an installation/gate/reviewer authority root
or enumerate its history. Selecting a favorable verified version could hide rejection, conflict
or revocation. Sharing one gate binding across different reviewers would merge independent people.

## Decision

Add an exact-scope trusted reviewer authority repository and a copy-on-write memory reference.
The physical target includes installation, gate and reviewer principal. The first retained root
fixes its logical authority and full tenant/project/environment scope. Different reviewers may
own different roots at one gate; one logical authority cannot be reassigned to a different reviewer,
target or scope. Different tenants may reuse identical physical IDs.

Reuse owning canonical authority validation, including distinct issuer/reviewer and explicit
synthetic provenance. Retain verified, unverifiable and rejected declarations without relabelling.
Equal definition retries preserve original publication receipts. Equal terminal-intent retries
preserve the original actor and native timestamp. Changed definitions/events, missing or substituted
predecessors/successors, reversed native receipts and duplicate terminals fail atomically.

Derive complete reads from the physical reviewer target. Preserve the original root, competing and
future-effective versions, revocation and supersession; do not select latest or filter by favorable
status. Charge all observations and repeated relationship reads to the original server-owned meter.
Reject quota-truncated inventories, taint caught read failures and validate physical indexes, exact
slots, causal history and canonical records. Return owned copies.

## Boundaries and validation

This is declaration persistence, not actual private authentication, human expertise, an approval
action or current release authority. The trusted record port is not a public raw-record endpoint.
It creates no native role, grant, outbox, decision or service. The future native issuer must prove
current installation authority and retain identity/source/absence guards through publication;
approval authorship and decision publication remain distinct boundaries.

Shared cases cover separate reviewer roots on one gate, full competing/future inventories,
synthetic/unverified/rejected declarations, self-issued and forged input rejection, three-tenant
collisions, exact scope, original receipts, lineage, concurrent terminals, native precision and
aggregate quotas. Memory corruption cases reject missing indexes and substituted slots. Native
adapter execution and the full checkpoint exit audit remain open. See the
[reviewer repository guide](../development/workflow-2-reviewer-authority-repository.md).
