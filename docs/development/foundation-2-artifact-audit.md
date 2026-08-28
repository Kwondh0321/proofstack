# Foundation 2 encrypted artifact audit

Status: accepted checkpoint

Reviewed: 2026-08-28

Scope: roadmap Foundation 2, item 5

## Decision

Foundation 2 item 5 is accepted. ProofStack now has a bounded, opt-in encrypted artifact interface
whose classified metadata, redaction summary, retention plan, lifecycle state, tombstone, and purge
receipt remain authoritative in PostgreSQL while immutable encrypted bytes live behind an exact-key
object-store port.

This checkpoint accepts the domain interface, memory and PostgreSQL catalog adapters, the pinned
S3-compatible adapter, and scoped one-shot maintenance operations. It does not declare Foundation 2
complete or ProofStack production-ready. API composition, a production external key provider,
continuous scheduling, coordinated backup and restore, and OTLP compatibility remain separate
gates.

## Audit method

The review crossed public contracts, authorization, cryptography, state transitions, PostgreSQL,
object storage, operator composition, failure recovery, documentation, and CI:

1. Compared [ADR-0009](../architecture/0009-encrypted-artifact-lifecycle.md) with the executable
   contract and every reserve, upload, read, tombstone, purge, retention, and reconciliation use
   case.
2. Replayed ciphertext tampering, protected-metadata substitution, wrong-tenant access, digest and
   length mismatch, duplicate upload, invalid state transition, key rotation, and unavailable-key
   scenarios.
3. Ran the same catalog and object-store conformance cases against memory, PostgreSQL, and the
   pinned S3-compatible service where applicable.
4. Inspected migration constraints, forced RLS, append-only lifecycle receipts, deterministic
   candidate indexes, and runtime grants rather than relying only on repository behavior.
5. Exercised the provisioned API and artifact-maintenance database roles through their real
   repository paths and verified denial of unrelated evidence, identity, delivery, sequence,
   deletion, and administration access.
6. Rehearsed failure after object creation but before catalog activation, missing abandoned
   objects, expired artifacts, pending purges, and configured-versus-referenced key drift.
7. Ran all five one-shot commands through the real PostgreSQL and S3 adapters in one isolated CI
   lifecycle and verified the final database states, object presence, and key counts.
8. Reconciled the primary and secondary project entry documents, threat model, local guide, and
   operations contract with the implemented and explicitly unsupported surfaces.

## Closed findings

| Area | Finding | Resolution |
| --- | --- | --- |
| Interrupted activation | A process failure after immutable object creation could leave valid ciphertext stranded behind a reserved row | Reconciliation now decrypts with authenticated metadata, verifies plaintext and ciphertext receipts, and activates only a valid exact object |
| Key retirement safety | A configured key could be removed without an operator knowing that live rows still referenced it | Catalog key-reference counts and `key-status` report configured and unconfigured versions; referenced missing keys produce an actionable nonzero result |
| Lifecycle operation | Domain retention and purge recovery existed without a supported composition root | A dedicated one-shot service validates command-scoped settings, checks migrations, creates a restricted principal, and closes database and object clients on every path |
| Worker privilege | Reusing the API database role would allow maintenance code to create reservations and access unrelated runtime paths | Provisioning now creates an isolated artifact role limited to catalog state advancement and immutable lifecycle receipts |
| Error integrity | A command failure could be obscured by a later resource-cleanup failure | Runtime cleanup preserves the operation, object-store, database, and idle-connection failures in one aggregate error |
| End-to-end evidence | Independent PostgreSQL and S3 tests did not prove their combined lifecycle converged | The dedicated CI job provisions real roles and runs reconciliation, expiration, retry, abandonment cleanup, and key inspection against both pinned services |
| CI fixture drift | Adding the fifth runtime role left the API integration provisioner fixture on the four-role contract | The fixture now provisions the complete role set and clean CI type and integration checks pass |
| Public accuracy | Entry documents and the threat model still described artifact storage and maintenance as absent | Public documents now distinguish the implemented domain/operator path from missing API, scheduler, external-key, and recovery work |

## Acceptance evidence

| Invariant | Executable evidence |
| --- | --- |
| Strict opt-in metadata | [Artifact contracts](../../packages/contracts/src/artifact.ts) reject missing retention, unbounded content, malformed redaction provenance, and invalid lifecycle timestamp shapes |
| Tenant and capability authorization | Reserve, upload, read, tombstone, purge, and maintenance use cases in [the artifact package](../../packages/artifacts/src) enforce principal capability and project/environment scope |
| Independent envelope encryption | [Artifact cryptography](../../packages/artifacts/src/artifact-crypto.ts) uses per-artifact data keys, AES-256-GCM, canonical authenticated metadata, versioned wrapped keys, and verified ciphertext/plaintext receipts |
| Recoverable lifecycle | [Lifecycle operations](../../packages/artifacts/src/artifact-maintenance.ts) and [interrupted-upload reconciliation](../../packages/artifacts/src/reconcile-artifact-reservations.ts) preserve explicit reserved, available, tombstoned, and purged states |
| Durable tenant boundary | [Migration 0009](../../packages/postgres/migrations/0009_artifact_catalog.sql) and the [PostgreSQL adapter integration](../../packages/postgres/src/postgres-artifact-catalog-repository.integration.test.ts) prove constraints, forced RLS, immutable receipts, concurrency, and restart persistence |
| Immutable object behavior | [S3 adapter tests](../../packages/s3/src/s3-artifact-object-store.integration.test.ts) prove conditional creation and deletion, exact-key isolation, fresh-client durability, checksums, bounded reads, and idempotence against the pinned compatible service |
| Least-privilege maintenance | [Role provisioning integration](../../packages/postgres/src/runtime-roles.integration.test.ts) proves the artifact role can advance only its required lifecycle path and cannot use unrelated runtime privileges |
| Safe operator composition | [Configuration](../../services/artifact-maintenance/src/config.test.ts), [runner](../../services/artifact-maintenance/src/runtime.test.ts), and [command](../../services/artifact-maintenance/src/cli-command.test.ts) suites cover scoped inputs, production refusal of local keys, migration gating, result codes, and cleanup failures |
| Real combined convergence | [Artifact maintenance integration](../../services/artifact-maintenance/src/runtime.integration.test.ts) proves all five commands through real PostgreSQL and S3 adapters and verifies final catalog, object, and key-reference state |
| Reproducible gate | [CI](../../.github/workflows/ci.yml) pins PostgreSQL 16.15 and SeaweedFS 4.44 and runs quality, PostgreSQL, S3, combined lifecycle, secret scan, and CodeQL jobs |

## Verification gates

The accepted commit passed repository formatting, architecture boundaries, documentation-link
checks, lint, strict TypeScript, unit and property tests, package coverage, production builds,
production-dependency audit, secret scanning, CodeQL, PostgreSQL integration, S3 compatibility, and
the combined artifact lifecycle job. The artifact domain retains complete statement, branch,
function, and line coverage; the operator package separately covers its pure configuration,
composition, and command boundaries and receives real-adapter coverage in the isolated integration
job.

## Accepted limitations and next work

- The API does not expose artifact reserve, upload, read, tombstone, or status routes, and the SDK
  does not upload content. The accepted surface is a domain and operator interface.
- Redaction provenance is validated and cryptographically protected, but ProofStack does not yet
  execute a configurable content-redaction ruleset. Callers may attest only to source-stage work.
- The local keyring is intentionally development/test-only. Production reads, reconciliation, key
  inspection, rotation, rewrap, backup, and recovery require an external key-provider composition.
- Maintenance commands operate on one explicit tenant/project/environment scope. There is no
  continuously scheduled multi-tenant worker, lease coordination, heartbeat, metrics exporter, or
  alert delivery.
- The direct path is limited to 16 MiB and has no multipart, range, deduplication, legal-hold, or
  delegated-upload protocol.
- The pinned service proves one compatibility target, not arbitrary S3 providers, proxies, bucket
  policies, or later versions. Production deployment requires staging rehearsal and policy review.
- PostgreSQL, encrypted objects, every referenced key version, and lifecycle policy must be backed
  up and restored coherently. That proof remains Foundation 2 item 7.

The next dependency-ordered capability is the OTLP/HTTP adapter and compatibility fixtures. The
artifact checkpoint must be reopened if that adapter captures content, changes evidence-reference
meaning, or adds a new network upload path.
