# ADR-0026: Recheck policy sources through scoped transaction ports

Status: Accepted

Date: 2026-10-03

Owners: ProofStack maintainers

## Context

[ADR-0024](0024-compose-policy-record-acquisition-above-domain-packages.md) and
[ADR-0025](0025-compose-authorized-policy-artifact-observations.md) keep fixed, request-owned
evidence composition above its owning domains. The installed PostgreSQL source-guard protocol and
normalized same-connection readers exist, but a coordinate plan does not prove that every guard
was acquired or that completed content observations still match authoritative catalogs/history.
Repository methods opening independent transactions cannot provide this recheck. Conversely,
importing PostgreSQL into the domain composer would introduce persistence coupling and a cycle.

## Decision

Define trusted read-only source-transaction ports in `@proofstack/policy-evaluation` and implement
them with `PostgresPolicySourceTransactions` in `@proofstack/postgres`. Add only the workspace edge
`postgres -> policy-evaluation`, enforced by the architecture checker. Do not add a reverse edge,
move owning validators or expose caller-selected validators/SQL/publication callbacks.

Authorized artifact capture optionally invokes the adapter after content/key I/O. Its internal
composer derives the complete request-owned installed-domain guard set and acquires every guard
before source reads. The adapter owns exact scoped READ COMMITTED isolation, one connection,
strict guard results, transaction-local context, whole rollback, operation lifetime and draining
started reads. Any port failure taints the operation even when caught by its callback. Reuse the
owning normalized readers and pure artifact/control/lifecycle inspectors; compare complete source
observations and exact database-cut availability under guards.

This slice is deliberately a read-only reinspection prerequisite, not a publisher. Its returned
report is historical after the transaction ends and cannot authorize a later seal. A subsequent
publisher must retain all required guards while validating complete closure and worker fences,
then publish snapshot/job state in that same transaction. No roles, grants, HTTP routes, worker,
snapshot contracts or outcome predicates are added here.

The subsequent `runMetadata` mode acquires the complete metadata barrier and verifies the current
migration ledger before exposing fixed exact-scope repository ports for the full record graph,
trace events, criterion histories and fixture content metadata. It shares the same transaction
lifetime, taint/drain and rollback machinery. Static installation/runtime records are bounded,
validated copies made before guards, never caller resolver callbacks or live installation proof.
This is still a read-only adapter prerequisite: complete request-owned graph reinspection and
guarded atomic publication remain separate. The existing artifact-capture recheck is not silently
replaced by this mode, and returned metadata cannot authorize a later seal.

## Consequences

### Positive

- Source reinspection can be exercised through the real request-owned capture and actual PostgreSQL.
- Fixed validators, complete guard derivation, normalized integrity and shared admission remain owned
  by their existing layers rather than by a configurable persistence registry.
- Explicit isolation, failure taint and expired ports prevent stale snapshots and partial cleanup.
- Optional integration preserves independent capture usage without inventing publication authority.

### Negative

- The PostgreSQL adapter now depends on the private composition package; its build order and
  boundary allowlist require maintenance. This does not turn the composer into a database service.
- Logical read/response admission does not measure every underlying SQL statement, allocation,
  transfer retry or query duration. Draining started work alone cannot stop a hung query.
- The initial two-kind domain does not serialize all upstream absence/selector/authority sources, and
  object storage is not held in a global simultaneous database snapshot.
- Returning after commit releases guards, so this report cannot be reused as current seal authority.

### Follow-up

- Close complete semantic/authority/presence boundaries and freeze sealed snapshot contracts.
- Implement dedicated worker authority, guarded atomic snapshot/job/fence publication and durable
  retry/deadline/cancellation accounting without releasing guards between validation and publication.
- Finish deterministic predicates, persistence, recovery, API/SDK and independent real-service acceptance.

## Alternatives considered

### Import PostgreSQL or a raw client into policy evaluation

Rejected because it reverses the adapter direction, couples fixed composition to SQL and lets a
callback change context, issue unrelated mutations or choose inconsistent transaction boundaries.

### Reuse repository methods while a separate connection holds guards

Rejected because authoritative reads and scope/isolation would belong to a different transaction.

### Treat a successful read-only report as a revision token for later publication

Rejected because writers may commit after guard release. The publisher must revalidate and publish
within one still-open guarded transaction rather than trust this returned report.

## Revisit when

Atomic publication requires an expanded internal transaction protocol or measured workloads need
query cancellation/streamed admission. Preserve fixed request derivation, owning validators, no
content I/O under guards, whole rollback and separate worker authority. This ADR does not accept
Workflow 2 checkpoint 3 or supersede the sealed-evidence requirement in ADR-0022.
