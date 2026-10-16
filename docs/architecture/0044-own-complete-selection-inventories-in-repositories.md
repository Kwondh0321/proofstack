# ADR-0044: Own complete selection inventories in repositories

Status: Accepted memory/shared repository design. Native persistence, private authorization and
checkpoint 4 remain open.

Date: 2026-10-16

## Context

Captured decision material cannot establish who owns a target or which versions/history exist.
The selection census validator must receive the entire owning inventory. A caller-selected
selection ID, favorable current version or latest query cannot supply that inventory.

## Decision

Add an exact-scope trusted selection repository and a synchronous copy-on-write memory reference.
The first stored selection owns an immutable tenant installation/gate target and logical root.
Versions cannot reassign that target, project or environment. Other tenants may use colliding IDs.
Read the root through its physical target binding before enumerating all its versions and terminal
history. Preserve competing and future-effective versions, withdrawal and supersession. Never
truncate to fit a budget or reconstruct a missing root from a caller-selected version.

Validate canonical definitions on writes and reads. Preserve first publication receipts on equal
definition retries; preserve first terminal actor/time on equal lifecycle-intent retries. Changed
version/event bodies conflict. Exact retained predecessors and supersession successors must exist
and retain the same logical target. Compare native receipt order without Date rounding. One version
accepts one terminal event; a later action never overwrites withdrawal or supersession.

The complete target read accepts the original server-owned verification meter. Charge root and
inventory observations, repeated relationship reads and missingness before returning. Read failures
taint that same meter; catching them cannot continue a partial cut. Validate physical root/version/
terminal indexes, owning scope, canonical records and causal history. Corruption must not become
normal absence or a shorter favorable census. Return owned copies.

## Boundaries

This repository trusts server-owned publication inputs. It does not authenticate an installer,
validate current installation evidence, hold a native guard, publish a decision/outbox or establish
production durability. The read result is historical source data. The future native implementation
must add dedicated roles, normalized/projected integrity, identity/source/absence guards and current
migration/recovery-epoch admission; atomic decision publication remains a separate still-held
transaction boundary. Memory mutations linearize in one JavaScript process only.

Shared cases cover exact target ownership, complete competing/future inventories, original retry
receipts, three-tenant collisions, project/environment isolation, lineage, terminal conflicts,
native precision, copies, concurrent publications and aggregate admission. Memory-specific fault
injection checks corrupt physical indexes and substituted slots. Native execution is still open.
See the [repository guide](../development/workflow-2-selection-repository.md).
