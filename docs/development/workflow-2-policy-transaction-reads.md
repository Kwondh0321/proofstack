# PostgreSQL transaction-local policy source reads

[English](workflow-2-policy-transaction-reads.md) | [한국어](workflow-2-policy-transaction-reads.ko.md)

Status: normalized reads on a caller-owned connection implemented. Workflow 2 remains **2/7**
accepted checkpoints; checkpoint 3 still requires guarded snapshot publication and durable evaluation.

## Connection and validation boundary

The [source serialization protocol](workflow-2-policy-source-locks.md) requires locks, authoritative
reinspection and publication on one READ COMMITTED connection. The existing repository methods
open their own scoped transactions. Calling those methods from a guarded transaction would perform
the authoritative read on a different connection.

`@proofstack/postgres` now exports these connection-specific reads:

| Function | Complete normalized read |
| --- | --- |
| `readPostgresArtifactCatalogOnClient` | Catalog entry, original expiry text and exact order, native lifecycle receipts, encryption/object receipt, optional fixture ownership |
| `readPostgresReleasePolicyOnClient` | Canonical policy with its resource root, predecessor, complete source/rule projections and counts |
| `readPostgresReleasePolicyLifecycleEventOnClient` | Exact canonical lifecycle event and every normalized projection |
| `listPostgresReleasePolicyLifecycleEventsOnClient` | Complete ordered terminal history for an exact scoped policy version |

The functions take a query-only view of the supplied `PoolClient`. They issue their SELECTs through
that client and do not connect to a pool, begin/commit/roll back a transaction, release a connection,
set scope, acquire a source lock or change privileges. The trusted caller owns authorization, exact
transaction context, isolation, guards, admission, deadlines and cleanup. Supplying a client alone
does not establish any of those conditions.

Existing `PostgresArtifactCatalogRepository.find` and policy repository reads now call the same
functions inside their existing transaction wrappers. Both entry paths therefore retain one
normalization and validation implementation. Policy canonical digests, root/lineage consistency,
child projections, counts, strict lifecycle schemas and projection comparisons remain checked.
Artifact reads preserve authenticated expiry text, exact expiry/projection consistency, native
receipt precision and complete ownership. Corrupt records and unexpected database errors still
propagate rather than becoming absence.

All lookups retain tenant, project, environment and exact record-ID predicates; PostgreSQL RLS and
the supplied connection's privileges still apply. The catalog reader copies the supplied scope
before its first asynchronous query so a changed caller object cannot redirect its later ownership
read. Returned normalized records are independently owned. No new database function, migration,
runtime role grant, HTTP route or public caller capability is added.

## Actual transaction and concurrency regressions

The real PostgreSQL suites cover the connection boundary directly:

- An uncommitted artifact activation is visible through the supplied client with its microsecond
  receipt and original thirty-digit offset expiry, while a separate repository transaction still
  sees the committed reserved state. The caller's savepoint, context and rollback remain intact.
- A policy successor and supersession event published inside one uncommitted transaction are
  visible through all three policy reads. Other transactions see neither new record. Rolling back
  the caller's savepoint removes both from subsequent reads on that same connection.
- Exact-scope substitutions yield no matching rows, and normalized expiry/policy corruption and
  unknown lifecycle fields retain the owning adapter's integrity failures.
- Existing lock tests now also use these reads on the connection holding the source guard. They
  verify absent creation, activation/tombstone/purge, unchanged catalog state during an ownership
  insertion, and both adapter/SQL withdrawal or supersession. Actual advisory waits are observed
  through `pg_blocking_pids`; a timer alone is not concurrency evidence.

The catalog unit regression additionally changes the caller's scope object between the catalog
and ownership queries and verifies that both queries retain the original exact parameters. It
checks that only the two expected SELECTs occur and that the helper does not release the client.
This test is separate from the real database transaction and source-lock evidence above.

Tests are retained in the
[catalog suite](../../packages/postgres/src/postgres-artifact-catalog-repository.integration.test.ts),
[policy suite](../../packages/postgres/src/postgres-release-policy-repository.integration.test.ts),
[source-lock suite](../../packages/postgres/src/policy-evaluation-source-locks.integration.test.ts)
and [catalog unit suite](../../packages/postgres/src/postgres-artifact-catalog-repository.test.ts).

## Remaining publication contract

These reads provide the owning adapters' validated values on the correct connection. They do not
derive a trusted request-rooted lock set, compare a completed acquisition with current observations,
meter a durable job, validate a lease/fence or persist a sealed snapshot.

The publisher must still derive the complete bounded guard set, acquire every guard without waiting,
roll back the whole transaction on a conflict, use these reads in subsequent READ COMMITTED
statements, compare full lifecycle/catalog observations and time-dependent availability, then
publish snapshot and job state atomically. It must not hold database guards during object/key I/O
or fall back to repository methods that open another transaction. Dedicated worker authority,
snapshot contracts, predicates, API/SDK, cancellation, recovery and end-to-end acceptance remain
the subsequent checkpoint requirements.
