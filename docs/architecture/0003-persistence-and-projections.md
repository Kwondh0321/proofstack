# ADR-0003: Separate system-of-record data from analytical projections

Status: Accepted  
Date: 2026-08-28  
Owners: ProofStack maintainers

## Context

ProofStack has two materially different data workloads:

- transactional control-plane data needs constraints, authorization checks,
  migrations, and consistent writes;
- telemetry and evaluation data needs append-heavy ingestion, time-range scans,
  high-cardinality filtering, and retention controls.

Introducing PostgreSQL, ClickHouse, Kafka, Redis, and object storage as mandatory
dependencies on day one would make the first workflow difficult to run and test.
Using only one database forever would make high-volume trace queries expensive and
couple retention to control-plane recovery.

## Decision

Persistence is accessed through domain-owned ports. No application or domain
module imports a database client directly.

The foundation deployment uses:

- **PostgreSQL** as the system of record for organizations, projects, API keys,
  configuration, releases, policies, datasets, jobs, and audit metadata;
- a PostgreSQL append-only evidence table for development and small deployments;
- **S3-compatible object storage** for large encrypted content, fixtures, exports,
  and immutable artifacts;
- an in-memory adapter for unit tests and the dependency-light quickstart.

High-volume deployments may add:

- **ClickHouse** as a rebuildable analytical projection for traces, events,
  evaluations, and cost metrics;
- **Redpanda or Kafka** as a durable fan-out log when independent consumers or
  sustained ingestion make the transactional outbox insufficient;
- **Redis** only for ephemeral coordination such as rate limiting or short-lived
  caches, never as the sole store for evidence or jobs.

Every authoritative mutation and corresponding publication intent are committed
in one PostgreSQL transaction using an outbox. Projection consumers are
idempotent. Analytical projections can be deleted and rebuilt without changing
the system-of-record meaning.

Evidence is append-only. Retention removes encrypted content or entire records
according to policy and writes a tombstone audit event; it never silently mutates
an existing evidence payload.

Database rows include tenant identity even when it can be inferred by joins.
PostgreSQL row-level security will provide defense in depth, but application-level
authorization remains mandatory.

## Consequences

### Positive

- The first complete workflow needs only one database and can use memory in tests.
- Transactional invariants remain enforceable.
- Analytical scale can grow without redefining domain ownership.
- Queue and projection failures do not corrupt the system of record.
- Backup and retention policies can differ by data class.

### Negative

- Projection lag is an explicit state the UI and API must represent.
- Rebuild tooling and schema compatibility require engineering effort.
- The PostgreSQL evidence path will not serve the largest workloads.
- Dual stores make deletion and retention verification more complex.

### Follow-up

- Define persistence ports before database implementations.
- Add outbox state and idempotency rules with the first PostgreSQL adapter.
- Publish projection freshness and rebuild metrics.
- Create deletion verification tests across system-of-record, projections, cache,
  backups, and object storage.

## Alternatives considered

### Require the complete production data stack locally

Rejected because it makes contribution and deterministic tests needlessly heavy.

### Use ClickHouse as the only database

Rejected because control-plane transactions, relational constraints, and frequent
small updates are not its primary workload.

### Use PostgreSQL for all scales permanently

Rejected as a long-term promise because trace analytics and independent retention
will eventually need specialized projections.

### Publish directly to a message broker after a database write

Rejected because a process failure between the two writes can lose publication or
produce inconsistent state.

## Revisit when

- sustained ingestion exceeds the tested PostgreSQL path;
- projection consumers need independent retention or replay;
- outbox delivery delay violates a declared service-level objective;
- object storage or analytical projections become mandatory for the quickstart.
