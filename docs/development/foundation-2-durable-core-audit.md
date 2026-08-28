# Foundation 2 durable core audit

- Status: Passed for ordered work 1–3
- Reviewed: 2026-08-28
- Foundation 2 exit: Not approved
- Production readiness: Not approved

## Verdict

The durable evidence core is coherent enough to support the remaining Foundation 2 capabilities.
Evidence can cross the existing API and repository contract into PostgreSQL, survive API and pool
restarts, remain isolated by forced row-level security, and create exactly one durable publication
intent for every newly accepted event. Delivery and consumer state have bounded, recoverable lease
protocols rather than placeholder tables.

This checkpoint accepts only roadmap items 1–3. Production identity, encrypted artifact retention,
OTLP compatibility, backup and restore, migration rollback analysis, and a broader adversarial suite
remain required before Foundation 2 can exit.

## Audit method

The review crossed architecture, schema, adapter, runtime privilege, API, and operator setup
boundaries:

1. Compared [ADR-0005](../architecture/0005-postgresql-tenancy-and-migrations.md),
   [ADR-0006](../architecture/0006-transactional-outbox-delivery.md), and
   [ADR-0007](../architecture/0007-leased-consumer-receipts.md) with executable SQL and repository
   behavior.
2. Rehearsed fresh, current, pending, upgraded, unknown, reordered, and checksum-mismatched migration
   histories.
3. Ran the same evidence repository conformance cases against memory and PostgreSQL.
4. Exercised absent, matching, and mismatched tenant contexts under forced RLS and pooled
   transaction-local settings.
5. Cross-checked API restart persistence with evidence/outbox atomicity and duplicate behavior.
6. Exercised concurrent outbox claims, stale acknowledgements, retry backoff, poison visibility,
   lease recovery, monotonic projection generations, and leased consumer receipts.
7. Used roles created by the real provisioner to execute the API producer, publisher, receipt, and
   cursor paths—not only to inspect PostgreSQL privilege metadata.
8. Compared the public durability claims with the pinned local Compose profile, migration commands,
   runtime credentials, safe shutdown, and destructive reset instructions.

## Closed findings

| Area | Finding | Resolution |
| --- | --- | --- |
| Provisioning integrity | Required tables could exist while a bundled migration was pending or its ledger was corrupt | Provisioning now verifies the full ordered migration ledger and SHA-256 checksums inside its locked transaction |
| Privilege convergence | A previously managed runtime role could retain manually granted sequence access | Provisioning revokes all public-schema sequence privileges before applying the role-specific table matrix |
| Runtime credentials | Least-privilege roles existed as library functionality but had no supported operator command | `db:provision` validates all credentials before connecting, rotates only marked roles, and emits no secrets |
| Privilege evidence | Metadata checks did not prove the provisioned grants were sufficient for real repositories | Integration now writes evidence/outbox as the API role, publishes as the publisher role, and records receipts/cursors as the consumer role |
| Local reproducibility | Durable setup, role order, persistence, and reset behavior were not discoverable from a clean checkout | A digest-pinned loopback-only Compose profile, local environment template, CI validation, and complete operator sequence are committed |
| Public accuracy | The primary and secondary READMEs still described persistence as absent | Both now distinguish the memory quickstart, durable development adapter, and remaining production blockers |

## Acceptance evidence

| Invariant | Executable evidence |
| --- | --- |
| Ordered immutable schema | [Migration runner](../../packages/postgres/src/migration-runner.ts), [migration tests](../../packages/postgres/src/migrations.integration.test.ts), and [upgrade fixture](../../packages/postgres/src/consumer-receipt-migration.integration.test.ts) |
| Database tenant boundary | [Forced-RLS and append-only tests](../../packages/postgres/src/migrations.integration.test.ts) plus transaction-local context in [tenant transaction](../../packages/postgres/src/tenant-transaction.ts) |
| Adapter compatibility | Shared [repository conformance cases](../../packages/core/src/testing/evidence-repository-conformance.ts) run by both [memory](../../packages/core/src/evidence/evidence-repository.contract.test.ts) and [PostgreSQL](../../packages/postgres/src/evidence-repository.integration.test.ts) suites |
| Durable API behavior | [API restart integration](../../apps/api/src/postgres.integration.test.ts) and startup/readiness migration verification in [storage composition](../../apps/api/src/storage.ts) |
| Atomic publication intent | [Evidence adapter](../../packages/postgres/src/postgres-evidence-repository.ts) and [accepted-versus-retry integration](../../packages/postgres/src/evidence-repository.integration.test.ts) |
| Recoverable delivery | [Outbox integration](../../packages/postgres/src/outbox-repository.integration.test.ts) covers parallel claims, tenant separation, stale leases, retries, failures, and recovery |
| Idempotent consumers | [Receipt integration](../../packages/postgres/src/consumer-receipt-repository.integration.test.ts) covers contention, recovery, backoff, terminal completion, conflicts, and the shared handler harness |
| Monotonic projections | [Projection cursor integration](../../packages/postgres/src/projection-cursor-repository.integration.test.ts) covers generations, concurrency, regression refusal, and tenant isolation |
| Least-privilege operation | [Role provisioning integration](../../packages/postgres/src/runtime-roles.integration.test.ts) proves role attributes, grant denial, password rotation, privilege convergence, and the complete repository path |
| Reproducible local install | [Compose definition](../../compose.yaml), [durable profile](../../config/postgres.env.example), [local guide](local-development.md), and [CI validation](../../.github/workflows/ci.yml) |

Every referenced PostgreSQL integration runs against the pinned PostgreSQL 16.15 image in the
dedicated CI job. The repository-wide `pnpm check` remains a separate required gate for formatting,
architecture boundaries, documentation links, lint, strict types, unit behavior, coverage, and
production builds.

## Accepted checkpoint limitations

- Development authentication remains loopback-only; OIDC and workload API keys are not implemented.
- The outbox has durable state semantics but no deployed publisher loop, transport adapter,
  lag metrics, or operational alerting.
- Receipt leases have no heartbeat renewal. External side effects still require destination
  idempotency because the protocol does not claim exactly-once effects.
- Content references have no encrypted artifact store, redaction executor, tombstone, or retention
  worker.
- OTLP/HTTP ingestion and compatibility fixtures do not exist.
- The local named volume demonstrates restart persistence, not backup or disaster recovery.
- Restore verification, forward-repair and rollback analysis, PostgreSQL upgrade rehearsal, and the
  complete cross-tenant adversarial suite remain roadmap item 7.
- Runtime roles assume a dedicated ProofStack database whose administrator is allowed to create
  roles and revoke `CREATE` on the public schema.

These limitations are gates, not optional polish. Foundation 2 remains active until ordered work
4–7 and its backup-based exit criterion pass.
