# ADR-0042: Read policy jobs through original request ownership

Status: Accepted owning-reader design. Complete current decision authority and checkpoint 4 remain open.

Date: 2026-10-16

## Context

Decision input predeclares exact original policy evaluation requests. A caller-provided job ID or
latest successful result cannot establish which job owns that request. Historical result/actor
inspection needs the original immutable request binding before inspecting the full job graph.

## Decision

Add a separate internal `PolicyEvaluationRequestJobReader` with exact scope and request reference.
Keep existing job-ID readers compatible. Memory resolves its atomic request-to-job map; a dangling
or substituted owner is invalid. An existing request ID with a different definition digest is a
conflict. Absence is null, without creating a request/job or selecting a favorable alternate.
Cancelled and other terminal owners remain visible; this reader does not filter for success.

Migration 0063 adds a private stable fixed-search-path PostgreSQL function. It reads the exact
normalized request and unique scope/request job binding, compares the original request digest
and reuses the normalized full graph reader. It rejects a retained request without its exact
owning job. There is no latest query or new table. Only existing C3 control/worker roles receive
this read function; API access and PUBLIC execution remain denied. No capability or role is added.

Share existing owning graph, canonical last-history and outbox validation between job-ID reads and
the new request reader. The supplied-client helper uses only that connection and does not begin,
commit, roll back, release or obtain a connection. Its trusted caller owns exact transaction scope
and current migration/guard admission. Keep the existing bounded transaction wrappers for ordinary
repository calls. Preserve exact native receipts and original idempotent enqueue ownership.

## Boundaries and remaining work

This is historical ownership, not private authentication, current reviewer/publisher authority,
guarded request absence or permission to publish a decision later. A future C4 composer must use
this owning selector, derive complete current authority and retain all required identity/source/
absence guards on the same transaction through atomic graph/decision/outbox publication.

Memory/native shared cases cover absence, exact graph/history, idempotent alias proposals, digest
conflict, cancelled owners, three-tenant ID collisions, exact project/environment and isolated
materialized results. Native cases also cover same-transaction use, API denial and private function
properties. Existing migration inventory and metadata-barrier assertions explicitly include 0063.
English/Korean guidance and focused execution evidence are in the
[owning request reader guide](../development/workflow-2-policy-request-job-readers.md).
