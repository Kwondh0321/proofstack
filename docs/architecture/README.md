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
