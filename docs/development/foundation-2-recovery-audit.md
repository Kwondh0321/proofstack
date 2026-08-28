# Foundation 2 recovery and isolation audit

Status: accepted; Foundation 2 exit approved  
Reviewed: 2026-08-29  
Scope: roadmap Foundation 2, item 7 and stage exit criteria  
Production readiness: not approved

## Decision

Foundation 2 is accepted as a complete repository foundation. ProofStack can preserve its full
authoritative state across restart, capture the database/ciphertext/key authority set under a
documented fence, restore it into isolated empty destinations, verify exact content through normal
repositories and cryptographic reads, provision fresh runtime roles, and continue writing without
changing the source installation.

The database boundary now discovers every tenant-bearing public table, requires enabled and forced
row-level security with at least one policy and no public DML grant, and attacks a reused
least-privilege connection with absent, forged, guessed, and cross-tenant context. Migration
history is immutable and checksum-bound; an older binary that does not recognize the restored
ledger fails closed.

This acceptance does not make ProofStack a production release. It accepts the pinned reference
procedure and its executable invariants. Every deployment still owns a production external key
provider, provider-specific immutable backups, measured RPO/RTO, off-site retention, repeated
restore rehearsals, topology, monitoring, and deletion behavior.

## Audit method

The review crossed contract, PostgreSQL, object storage, cryptography, runtime roles, migration
compatibility, operator tooling, documentation, and CI boundaries:

1. Enumerated PostgreSQL tables and sequences from the live catalog and required representative
   state in every authoritative `proofstack_*` table before capture.
2. Created a real custom-format PostgreSQL 16.15 dump with the supported recovery operation and
   restored it into a separately named empty database in one transaction.
3. Compared every table row and sequence value, the complete ordered migration ledger, and exact
   checksums between the source and restored database.
4. Created and purged real artifacts, copied available ciphertext through isolated source, backup,
   and restore buckets, and compared exact bytes, sizes, and SHA-256 values.
5. Restored the matching test key snapshot, read plaintext through the normal authenticated
   artifact path, and proved purged and wrong-tenant content remained unreadable.
6. Provisioned new API, identity, artifact, publisher, and consumer roles on the restored database;
   no source runtime credentials or ownership were restored.
7. Read original evidence, denied a second tenant, appended new evidence to the restored target,
   and proved the source had not changed.
8. Replayed migration absence, reordering, unknown IDs, checksum mismatch, an older bundled set,
   transactional failure, and the concrete 0010 forward-repair path.
9. Discovered every public `tenant_id` table and combined forced-RLS metadata assertions with
   existing role-specific cross-tenant repository suites and pooled context-leak attacks.
10. Reconciled the runbook, ADRs, threat model, roadmap, both entry documents, public limitations,
    and CI jobs with executable behavior.

## Closed findings

| Area | Finding | Resolution |
| --- | --- | --- |
| Recovery authority | PostgreSQL, objects, keys, configuration, and lifecycle deletion evidence could be described as independent backups | ADR-0011 and the runbook require one fenced immutable recovery set with exact component references and digests |
| Database operation safety | Tested dump/restore functions were not directly usable by an operator | `proofstack-recovery` exposes dedicated database backup and empty-target restore commands without command-line credentials |
| Schema binding | A database receipt did not expose the exact migration history needed by the recovery manifest | The CLI verifies the checksum ledger before capture and after restore and includes it in the bounded receipt |
| Restore realism | Restart persistence and storage tests did not prove an empty installation could be recovered | The recovery job restores a real custom dump, ciphertext, and key snapshot into three isolated targets and uses production repositories afterward |
| Content verification | Catalog counts could pass while restored ciphertext differed | The rehearsal compares exact database rows, sequences, ciphertext digests and bytes, then decrypts through the normal artifact read path |
| Migration rollback | Reverse SQL could hide destructive or externally inconsistent rollback | Migrations remain immutable and transactional; older binaries reject unknown ledgers, applied changes repair forward, and irreversible rollback restores the whole coordinated set |
| Identity table isolation | Four older identity tables enabled RLS but did not force it | Migration 0010 applies `FORCE ROW LEVEL SECURITY` without rewriting prior migration checksums |
| Failure diagnostics | The first all-table isolation assertion reported only a boolean | The matrix reports the exact violating catalog rows while retaining a strict complete-table expectation |
| Public accuracy | Entry, operations, audit, and threat documents still called recovery unimplemented | Current documents distinguish the accepted reference recovery profile from unsupported production disaster-recovery claims |

The forced-RLS issue was first observed as a failing PostgreSQL CI job. It was not retried away or
weakened in the test. A new forward migration repaired live and fresh installations, and the same
real integration then passed.

## Acceptance evidence

| Invariant | Executable evidence |
| --- | --- |
| Strict recovery contract | [Recovery schemas](../../packages/contracts/src/recovery.ts) bound component references, timestamps, versions, inventories, migration checksums, key IDs, and manifest size limits |
| Canonical inventory and manifest verification | [Recovery verifier](../../packages/recovery/src/verification.ts) recomputes dump, configuration, inventory, ledger, and key-reference comparisons and fails by component |
| Safe database component | [Logical backup operations](../../services/recovery/src/postgres-logical-backup.ts) require matching supported versions, private non-overwriting output, digest verification, empty restore targets, and transactional restore |
| Operator entrypoint | [Recovery CLI](../../services/recovery/src/cli.ts) uses a dedicated environment credential, emits a bounded non-secret receipt, binds the ledger, and closes the database pool on every path |
| Coordinated empty-target recovery | [Recovery integration](../../services/recovery/src/postgres-recovery.integration.test.ts) restores PostgreSQL, exact ciphertext, and a matching key snapshot before normal authenticated reads and writes |
| Immutable schema history | [Migration runner](../../packages/postgres/src/migration-runner.ts) rejects unknown, altered, missing, or reordered history and applies each new migration transactionally under an advisory lock |
| Concrete forward repair | [Migration 0010](../../packages/postgres/migrations/0010_force_identity_tenant_rls.sql) closes the identity RLS gap without changing previously applied migration bytes |
| Complete tenant-table discovery | [Isolation matrix](../../packages/postgres/src/tenant-isolation.integration.test.ts) enumerates every public tenant table, verifies forced RLS/policies/grants, and attacks a reused least-privilege pool |
| Role-specific tenant denial | PostgreSQL integrations for evidence, outbox, cursor, receipt, workload identity, OIDC identity, and artifact catalog exercise their real scoped repositories and grants |
| Supported operator procedure | [Recovery runbook](../operations/backup-and-recovery.md) defines fencing, capture, provider duties, verification, isolated restore, migration repair, and unsupported claims |
| Reproducible external gate | [CI](../../.github/workflows/ci.yml) pins PostgreSQL 16.15 and SeaweedFS 4.44 and separates quality, PostgreSQL, recovery, artifact, S3, secret, dependency, and CodeQL checks |

## Verification gates

The accepted implementation passes repository formatting, architecture boundaries, documentation
links, lint, strict TypeScript, package coverage thresholds, unit and property behavior, production
builds, production dependency audit, secret scanning, CodeQL, PostgreSQL integration,
S3-compatible integration, combined artifact lifecycle, and the coordinated recovery rehearsal.

The final review does not treat a skipped push-only dependency-review job as a success. Dependency
review is pull-request scoped; the production dependency audit remains required on pushes, while
CodeQL and secret scanning run independently.

## Accepted limits after Foundation 2

- The supported recovery database profile is PostgreSQL 16 on the pinned tested release. No major
  PostgreSQL upgrade or downgrade procedure is claimed.
- The S3-compatible proof covers the pinned test service. Arbitrary providers, proxies, policies,
  versioning behavior, and cross-region replication require staging and recovery rehearsal.
- The repository uses a test key snapshot. Production external-key backup, rotation, rewrap,
  attestation, destruction, and isolated restore remain deployment-specific.
- Capture currently requires a maintenance fence. There is no continuous coordinated checkpoint,
  point-in-time recovery protocol, zero-downtime failover, or declared RPO/RTO.
- Backup retention may preserve ciphertext after a live purge. Each deployment must declare and
  enforce access, tenant deletion, expiry, and physical destruction for recovery copies.
- Recovery manifests are strict and hash-bound but are not yet signed or included in a
  transparency log.
- The outbox state machine is durable, but no production publisher deployment, transport, lag
  alerting, or exactly-once external-effect claim exists.
- Artifact APIs, continuous maintenance scheduling, console-integrated OIDC, production deployment
  packaging, distributed quotas, and a broad OTLP collector/provider matrix remain unfinished.

These limits block production-readiness claims, not Foundation 2's stated exit criterion.

## Next dependency-ordered work

The next stage is Workflow 1, the incident-to-regression loop: immutable datasets, replay modes,
budget and cancellation controls, versioned evaluators, uncertainty and disagreement evidence, and
baseline/candidate comparison. It must treat operator criteria and model judgments as versioned
evidence rather than unquestioned truth. Search can discover candidate standards and counterevidence
but cannot become an authority by itself.

No Workflow 1 implementation is included in this acceptance commit.
