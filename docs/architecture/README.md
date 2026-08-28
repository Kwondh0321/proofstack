# Architecture decisions

ProofStack records consequential and difficult-to-reverse technical decisions as
architecture decision records (ADRs).

## Process

1. Copy `adr-template.md` to the next zero-padded number.
2. Describe context and constraints before proposing a decision.
3. Include rejected alternatives and operational consequences.
4. Merge accepted ADRs with the implementation that depends on them, or earlier.
5. Never edit history to reverse a decision. Add a new ADR that supersedes it.

## Status values

- Proposed
- Accepted
- Superseded by ADR-NNNN
- Rejected

## Index

The index is maintained in numeric order. Its absence from this list does not
invalidate an ADR present in this directory.

- [ADR-0001: Begin as a modular monorepo with logical planes](0001-modular-monorepo.md)
- [ADR-0002: Use an OTLP-compatible canonical telemetry contract](0002-canonical-telemetry-contract.md)
- [ADR-0003: Separate system-of-record data from analytical projections](0003-persistence-and-projections.md)
- [ADR-0004: Make identity, tenancy, and data classification explicit](0004-identity-tenancy-and-sensitive-data.md)
- [ADR-0005: Enforce tenant-scoped PostgreSQL transactions](0005-postgresql-tenancy-and-migrations.md)
- [ADR-0006: Publish durable mutations with leased outbox delivery](0006-transactional-outbox-delivery.md)
- [ADR-0007: Reserve consumer work with leased receipts](0007-leased-consumer-receipts.md)
- [ADR-0008: Authenticate browsers and workloads with revocable server-side identity](0008-production-identity-boundary.md)
- [ADR-0009: Encrypt artifact content before object storage and preserve lifecycle evidence](0009-encrypted-artifact-lifecycle.md)
- [ADR-0010: Normalize a bounded OTLP/HTTP trace profile at an authenticated ingress](0010-otlp-http-trace-ingestion.md)
- [ADR-0011: Recover authoritative state as a coordinated immutable set](0011-coordinated-recovery-and-schema-rollback.md)
- [ADR-0012: Version incident evidence as immutable regression inputs](0012-immutable-regression-versions.md)
