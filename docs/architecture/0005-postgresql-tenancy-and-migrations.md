# ADR-0005: Enforce tenant-scoped PostgreSQL transactions

Status: Accepted  
Date: 2026-08-28  
Owners: ProofStack maintainers

## Context

Foundation 2 replaces the process-local evidence repository with durable PostgreSQL storage. The
adapter must preserve the existing repository meaning: batches are atomic, retries are idempotent,
conflicting event identifiers are rejected, reads are bounded and deterministic, and no operation
can cross an authenticated tenant boundary.

Application authorization alone is insufficient defense for a database that contains many
tenants. Connection pooling also makes session-scoped tenant state hazardous because a value can
leak into an unrelated request. Migrations introduce a separate integrity risk: concurrent
deployments can race, and changing an already-applied migration makes a restored database differ
from a newly installed one.

## Decision

The PostgreSQL adapter lives in the infrastructure package `@proofstack/postgres`. It imports the
domain-owned repository port from `@proofstack/core`; the core and contracts packages never import
a database client.

The adapter uses `pg` directly. Every scoped repository operation checks out one client, starts a
transaction, applies the authenticated tenant with
`set_config('proofstack.tenant_id', tenant_id, true)`, executes all statements on that same client,
and commits or rolls back before releasing it. The third argument to `set_config` is always `true`,
so pooled connections cannot retain tenant state. There is no unscoped runtime query interface.

The evidence table has tenant, project, environment, trace, ordering, and event identifiers as
explicit columns alongside the canonical JSONB envelope. Its primary key is `(tenant_id,
event_id)`, making event identity tenant-wide while allowing independent tenants to use the same
identifier. Database constraints require the indexed columns to match the canonical envelope.
Trace reads use the complete `(started_at, sequence, event_id)` keyset ordering.

Row-level security is enabled and forced on every tenant-bearing table. Policies fail closed when
`proofstack.tenant_id` is absent and permit only rows whose `tenant_id` exactly matches the local
transaction setting. Deployments use a non-superuser runtime role without `BYPASSRLS`; production
migration credentials and runtime credentials are separate. Application authorization remains
mandatory because row-level security is defense in depth, not the policy model.

Evidence insertion is append-only. Runtime roles receive `SELECT` and `INSERT`, not `UPDATE`,
`DELETE`, or `TRUNCATE`. A database trigger also rejects updates and deletes. Future retention must
use an audited, narrowly privileged operation that writes its tombstone in the same transaction;
ordinary repository code cannot weaken append-only history.

Batch ingestion runs in one transaction. Each envelope is inserted with `ON CONFLICT DO NOTHING`.
When a key already exists, the adapter reads the row within the same tenant transaction and compares
the complete stored envelope using JSONB equality. An identical envelope is a duplicate; any
different schema, scope, receipt time, or evidence payload is a conflict and rolls back the whole
batch.

Migrations are immutable, ordered SQL files embedded in the package. The migrator:

1. checks out one dedicated client and obtains a session advisory lock;
2. creates the migration ledger if necessary;
3. verifies the SHA-256 checksum of every previously applied migration;
4. applies each pending migration in its own transaction and records its checksum atomically;
5. releases the lock and client on every exit path.

Application startup verifies that no migration is missing or altered. Applying migrations is an
explicit operator command rather than an implicit side effect of starting an API replica. The
supported baseline is PostgreSQL 16 or newer.

## Consequences

### Positive

- Repository semantics remain independent of PostgreSQL and can be tested against both adapters.
- Tenant context cannot persist beyond a transaction or silently fall back to unrestricted access.
- Database policies limit the blast radius of a missed application filter.
- Immutable checksummed migrations make fresh installation and restored state comparable.
- The schema supports durable ingestion now and deterministic projection fan-out later.

### Negative

- Every repository call pays for a transaction and a checked-out connection.
- Operators must provision separate migration and runtime privileges in production.
- JSONB equality intentionally treats object key order as irrelevant and preserves PostgreSQL's
  JSON number semantics rather than source-text formatting.
- Retention requires a privileged path instead of ordinary deletion.

### Follow-up

- Publish the first schema migration and a migration-status command.
- Run one repository conformance suite unchanged against memory and PostgreSQL.
- Add adversarial tests for absent tenant context, forged tenant context, and reused pooled
  connections.
- Document role grants, backup behavior, restore verification, and supported PostgreSQL upgrades.

## Alternatives considered

### Use an ORM and generate migrations from models

Rejected for this boundary because the critical RLS, trigger, grant, advisory-lock, and JSONB
constraints still require explicit SQL. A low-level adapter keeps those invariants reviewable.

### Put tenant context in a connection string or session variable

Rejected because it either creates a pool per tenant or risks reusing tenant state across requests.

### Filter every query only in application SQL

Rejected because one missing predicate could expose another tenant and direct operational access
would have no database-level guardrail.

### Run migrations automatically from every API replica

Rejected because startup then needs DDL authority and deployment races become part of request
availability.

## Revisit when

- transaction-per-operation overhead violates a measured ingestion objective;
- PostgreSQL adds a safer native request-context mechanism than transaction-local settings;
- retention volume requires partition exchange or a separate evidence system of record;
- a migration framework proves it can enforce the same checksum, locking, and privilege invariants
  with less custom code.
