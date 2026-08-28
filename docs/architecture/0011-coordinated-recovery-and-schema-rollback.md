# ADR-0011: Recover authoritative state as a coordinated immutable set

Status: Accepted  
Date: 2026-08-28  
Owners: ProofStack maintainers

## Context

ProofStack's authoritative state spans PostgreSQL, encrypted object storage, and a versioned key
provider. PostgreSQL owns evidence, identity, delivery, projection, receipt, artifact-catalog,
tombstone, purge-receipt, and migration-ledger records. Object storage owns ciphertext, while the
key provider owns every key-encryption-key version needed to unwrap live catalog entries. None of
these systems participates in one distributed transaction or one portable backup primitive.

A PostgreSQL dump alone can therefore restore metadata that points to missing or undecryptable
objects. An object snapshot alone can restore bytes without authorization and lifecycle state.
Restoring an older object snapshot over newer tombstones can also resurrect content that the live
system had purged. Database migration rollback creates a separate hazard: an older application can
misinterpret a newer schema even when both versions start successfully.

Foundation 2 may claim recoverability only after the complete authority set is identified,
documented, restored into isolated destinations, and verified through its public repository and
cryptographic boundaries. A restart or storage-provider replica is not a recovery rehearsal.

## Decision

### Recovery set

One recovery point is an immutable, access-controlled set with one identifier. It contains or
references all of the following:

- a PostgreSQL custom-format logical dump created by a supported `pg_dump` client;
- an immutable object-store snapshot or backup namespace plus a complete inventory of all
  ProofStack-managed ciphertext objects at the cut;
- an independently protected key-provider backup containing every key version referenced by the
  restored catalog;
- the deployment configuration, object-store policy, database and object-store engine versions,
  and exact ProofStack release or source revision; and
- a canonical manifest recording the recovery-set identifier, capture time, component references,
  SHA-256 digests, migration identifiers and checksums, referenced key identifiers, and operator
  provenance.

The manifest contains references and digests, never database passwords, object-store credentials,
plaintext data keys, key-encryption-key material, or recovered artifact plaintext. The database,
object, key, and manifest components use independent access control and retention. A recovery set
is usable only when every component is present and its digest or provider version matches.

### Consistent capture

The supported logical procedure creates a recoverable cut in this order:

1. stop or fence ProofStack writers, publishers, consumers, identity administration, retention,
   reconciliation, purge, and key rotation for the affected installation;
2. wait for in-flight database and object operations to terminate, recording the fence evidence;
3. capture the PostgreSQL dump and migration ledger;
4. capture the complete reserved object prefix with provider version identifiers and an inventory;
5. capture every referenced key version through the external key provider's backup mechanism;
6. build the manifest from those immutable components, verify their digests, and only then release
   the fence; and
7. retain the fence, backup, verification, and release audit records outside the restored system.

Continuous production recovery may replace the maintenance fence only after a future protocol
proves an equivalent database/object/key cut. PostgreSQL point-in-time recovery and object
versioning are useful building blocks but do not by themselves prove that equivalence.

### Isolated restore

A restore targets a newly created empty database and a new empty object bucket or reserved prefix.
It never overlays a live installation. The operator restores the database without source runtime
role ownership or credentials, restores ciphertext under the exact catalog locators, restores the
key versions through the provider, and provisions fresh least-privilege runtime credentials.

Before traffic is admitted, the verifier must fail closed unless all of these conditions hold:

- the database migration ledger is known, ordered, checksum-correct, and current for the selected
  ProofStack release;
- the manifest and database dump digests match the captured values;
- every available catalog entry has an object with the expected ciphertext digest and length;
- reserved and tombstoned entries agree with the captured object inventory so reconciliation or
  purge can resume deterministically;
- every referenced key identifier exists and can decrypt a sampled or complete bounded set;
- purged artifacts remain unreadable and their objects are not restored to the live namespace;
- evidence, identity, outbox, projection cursor, consumer receipt, catalog, tombstone, purge
  receipt, and migration state match the capture;
- forced row-level security and least-privilege grants still deny absent, forged, guessed, and
  cross-tenant access; and
- the restored API can ingest and read new evidence without mutating restored evidence.

The rehearsal uses representative state from every authoritative table and decrypts restored
ciphertext through the normal artifact read path. Counts alone are insufficient verification.

### Migration rollback and forward repair

Shared migrations remain immutable and do not have automated `down` scripts. A failed pending
migration rolls back its own transaction. Once a migration is applied to a shared or backed-up
installation, remediation uses a new forward migration unless the entire installation is restored
from a pre-change coordinated recovery set.

Rolling application binaries back is allowed only while that release recognizes every applied
migration. The migration ledger is a startup compatibility barrier: an older release must reject
an unknown newer migration, a missing earlier migration, or any checksum mismatch before serving
traffic. Destructive DDL requires a compatibility window in which both the previous and next
application releases operate correctly; removal happens only in a later migration after rollback
support expires.

Every migration change records:

- a forward path and transaction/locking analysis;
- old-binary and new-binary compatibility expectations;
- a forward-repair path for partially deployed application fleets;
- the last recovery set required before irreversible work; and
- a clean-install, upgrade, integrity, and old-binary rollback-barrier test.

### Executable acceptance

CI restores a real PostgreSQL custom-format dump into a separately named empty database, checks the
ledger through the production migrator, reprovisions runtime roles, and verifies representative
authoritative state. A coordinated integration rehearsal copies encrypted objects into an isolated
backup namespace, restores them to an empty namespace with the matching test key versions, and
proves normal authenticated reads and tenant isolation after restore.

A separate adversarial matrix runs with real least-privilege roles across evidence, delivery,
projection, receipt, identity, and artifact tables. It attempts absent tenant context, forged row
tenant values, guessed identifiers, cross-tenant reuse, and pooled-connection context leakage.

These tests prove the repository's supported recovery procedure on the pinned CI versions. They do
not claim a production recovery-point objective, recovery-time objective, continuous backup,
cross-region recovery, or support for an untested provider. Operators must rehearse their exact
provider, external key system, scale, and retention policy before production use.

## Consequences

### Positive

- Recovery preserves authorization, deletion evidence, ciphertext, and key availability as one
  reviewable unit instead of treating database rows as the whole system.
- Empty-target restore and manifest verification prevent accidental overlay and silent component
  mixing.
- Immutable migrations and startup ledger checks make application rollback fail closed.
- Real restore and adversarial tests exercise the same adapters and roles used at runtime.
- The documented boundary is honest about what CI proves and what deployment operators still own.

### Negative

- Capturing a consistent logical backup currently requires a maintenance fence.
- External key-provider backup and restoration remain provider-specific operational work.
- Logical dump/restore time grows with authoritative PostgreSQL volume and requires measured
  rehearsal before an RTO can be declared.
- Object inventory and verification add storage reads and can be expensive for large installations.
- ProofStack cannot promise production disaster recovery until a deployment supplies immutable
  storage, monitoring, off-site retention, and repeated provider-specific rehearsals.

## Alternatives considered

### Treat the PostgreSQL dump as the authoritative backup

Rejected because artifact rows would outlive their ciphertext or wrapping keys, and older restored
catalog state could contradict newer object deletion.

### Restore into the existing database and bucket

Rejected because overlay can mix recovery points, retain unknown rows or objects, and resurrect
purged content without an auditable decision.

### Generate reverse SQL for every migration

Rejected because reverse DDL can destroy data, cannot reliably undo external effects, and gives an
older binary a false compatibility signal. A forward repair or whole-set restore is explicit and
testable.

### Let an older application ignore unknown migrations

Rejected because unknown schema meaning can corrupt or expose authoritative state before an
operator notices the rollback mismatch.

### Depend only on provider replication

Rejected because replication can copy corruption or deletion immediately and does not coordinate
PostgreSQL, object, and key-provider time points.

## Revisit when

- measured backup duration makes a writer fence incompatible with a declared recovery objective;
- PostgreSQL physical backup and object-version checkpoints can form a proven continuous cut;
- production external key providers expose a portable recovery attestation interface;
- recovery-set manifests need signing, transparency-log inclusion, or tenant-specific ownership;
  or
- multiple regions require a coordinated failover protocol rather than an isolated restore.
