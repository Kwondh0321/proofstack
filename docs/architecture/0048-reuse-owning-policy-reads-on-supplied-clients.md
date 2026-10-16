# ADR-0048: Reuse owning policy reads on supplied clients

Status: Accepted immutable source-read design. Complete current-authority composition,
native decision publication and checkpoint 4 remain open.

Date: 2026-10-16

## Context

The snapshot and result repositories open their own bounded transactions. A future decision
publisher must revalidate original policy evidence while retaining all current-source guards on
one client. Opening a second transaction would sever that boundary; copying only stored result
JSON would lose original header, job, history, outbox, page and deterministic-result checks.

## Decision

Extract fixed supplied-client readers for original snapshot headers, individual pages and results.
The existing repository read methods delegate to them. They issue only the existing fixed SELECTs
and never connect, begin, commit, roll back, release, load files or accept an injected validator.
No migration, SQL function, runtime role/grant or external dependency is added.

Snapshot reads retain exact original request/job/snapshot binding, canonical header validation,
last canonical job history and canonical outbox checks. Page reads retain these same checks and
the owning page validator. Invalid indices fail before transport; absent exact roots return null,
and an out-of-root page or malformed scalar response fails rather than becoming absence.

Result reads use the shared owning job reader, retain canonical history/outbox verification, read
the original seal and recompute evidence from that seal and its exact page set. The publication
path shares the same deciding closed-attempt and full result validator. Historical records are
not caller-computed verdicts, current release authority or permission to publish a new decision.

## Alternatives and consequences

Reject separate repository transactions under a future publication guard, raw JSON-only reads,
duplicate result validators, caller-selected latest evidence and callbacks that can replace owning
state. The caller still supplies the original exact request-derived identity and page set, owns
scope/migration/recovery/current-source guards, lifetime, aggregate admission and failure taint,
and must retain all guards through its own atomic publication. These helpers grant none of those
duties implicitly. No content/key/network/human wait belongs under that transaction.

The unit transport now returns real canonical history heads/pages rather than overriding owning
history validation. A forged closure therefore fails earlier at its graph/history binding; keep
the separate deciding-attempt assertion too. Native coverage extends the populated three-tenant
collision case to read headers, every page and recomputed results on one query-only client view,
checking backend/transaction IDs and the caller's savepoint. See the
[source-reader guide](../development/workflow-2-policy-original-client-readers.md).
