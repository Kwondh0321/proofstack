# Coordinated backup and isolated recovery

Status: Foundation 2 supported reference procedure  
Last reviewed: 2026-08-29

This runbook defines the recovery behavior that the ProofStack repository implements and rehearses.
It is deliberately narrower than a production disaster-recovery promise. The automated reference
uses PostgreSQL 16.15, a pinned S3-compatible test service, and a test key snapshot. A deployment
must repeat this procedure with its exact database, object provider, external key provider, scale,
retention rules, and access controls before declaring an RPO or RTO.

The governing design is [ADR-0011](../architecture/0011-coordinated-recovery-and-schema-rollback.md).
The executable reference is the
[coordinated recovery integration](../../services/recovery/src/postgres-recovery.integration.test.ts).

## Safety boundary

A recovery point is one coordinated set, not one database file. It contains all of these
components from the same fenced interval:

| Component | Authoritative content | Required evidence |
| --- | --- | --- |
| PostgreSQL | Evidence, delivery state, identity, artifact lifecycle, sequences, and migration ledger | Custom-format dump, byte count, SHA-256, server version, ordered migration IDs and checksums |
| Object backup | Exact encrypted bytes for every available catalog locator | Strictly ordered inventory, ciphertext length and SHA-256, provider version where available |
| Key-provider backup | Every key version referenced by the captured catalog | Provider recovery reference and the exact ordered key-ID set |
| Configuration | ProofStack revision, non-secret deployment settings, provider identity, and object policy | Immutable bytes and SHA-256 |
| Manifest | References and digests binding the other components | A validated `RecoveryManifest` with one recovery-set ID |
| External audit | Fence, capture, verification, release, and restore approvals | Records retained outside the system being restored |

Never place database passwords, object credentials, plaintext data keys, key-encryption-key
material, or recovered plaintext in the manifest, inventory, command line, logs, or issue tracker.
Keep each component immutable and access-controlled. A missing or mismatched component invalidates
the whole set.

The PostgreSQL CLI creates only the database component. Its successful receipt is not a complete
backup and is never sufficient reason to release the writer fence.

## Preconditions

Before capture:

1. Select an exact 40-character ProofStack revision whose required CI and security checks passed.
2. Assign a unique recovery-set ID and an immutable destination for every component.
3. Prepare dedicated recovery database credentials. They are privileged operator credentials,
   never one of the five runtime roles. Inject them from a secret manager through
   `PROOFSTACK_RECOVERY_DATABASE_URL`; do not paste the URL into shell history.
4. Install `pg_dump` and `pg_restore` with the same major version as the server. The supported
   wrapper refuses a mismatched or pre-16 client/server pair.
5. Prepare an object-backup identity that can enumerate the reserved `objects/v1/` prefix and read
   exact ciphertext. The runtime artifact identity intentionally cannot list the bucket.
6. Prepare the external key provider's documented snapshot/export mechanism and a separate restore
   destination. The repository does not export production key material.
7. Define how every writer and lifecycle worker will be fenced, how in-flight work will be proven
   complete, and who may release the fence.
8. Confirm capacity for the database dump, object copy, verification reads, and a second empty
   restore target. Measure elapsed time; do not infer an RTO from CI duration.

For non-loopback targets, `PROOFSTACK_ENV=production` makes TLS mandatory. The database URL parser
accepts only the reviewed libpq query parameters and the recovery command does not print the URL.

## Capture procedure

### 1. Fence all mutation

Stop or deny new work for API ingestion, OIDC and API-key administration, outbox publishers,
consumers, projection writers, artifact uploads, reconciliation, retention, purge, and key
rotation. Block migration execution as part of the same fence. Wait for in-flight database and
object operations to finish, then record the fence time and evidence externally.

Do not substitute an application restart for this fence. The database, object store, and key
provider do not share a distributed snapshot.

### 2. Capture PostgreSQL

Build the recovery command once from the selected revision:

```bash
pnpm install --frozen-lockfile
pnpm --filter @proofstack/recovery-operations build
```

After the secret manager has populated `PROOFSTACK_RECOVERY_DATABASE_URL`, run:

```bash
PROOFSTACK_ENV=production node services/recovery/dist/cli-entrypoint.js \
  database-backup /absolute/immutable/path/database.dump
```

The command fails closed unless:

- the dump path is absolute, its directory exists, and the final file does not already exist;
- the database URL is valid and non-loopback production transport uses TLS;
- the PostgreSQL client and server major versions match and are supported;
- the checksum-verified migration ledger is known, ordered, and current; and
- `pg_dump --format=custom --no-owner --no-privileges` completes successfully.

The dump is built under a private temporary file, synced, published without overwriting an existing
path, set to mode `0600`, and hashed. The one-line JSON receipt contains the database version,
size, SHA-256, and ordered migration ledger. Store that receipt with the recovery set.

### 3. Capture encrypted objects

Using the separate backup identity, enumerate the complete reserved prefix in ascending exact-key
order. Copy every object to a new immutable backup namespace and record for each object:

- canonical `objects/v1/` key;
- ciphertext byte length;
- independently computed ciphertext SHA-256; and
- immutable provider version ID when the provider supplies one.

Use `encodeRecoveryObjectInventory` from `@proofstack/recovery` to create canonical NDJSON and its
aggregate digest. Reject duplicate, missing, unsorted, malformed, or extra keys. A purged catalog
entry must not have an object in the live or restorable inventory. Provider replication or bucket
versioning alone is not this snapshot.

### 4. Capture referenced key versions

Read the exact key-ID set referenced by the fenced artifact catalog, sort it, and capture every
version using the external provider's recovery mechanism. Prove the snapshot can restore those
identifiers into an isolated key-provider destination. Do not unwrap or export plaintext keys into
the ProofStack manifest.

### 5. Build and verify the manifest

Record the exact ProofStack revision, non-secret configuration bytes, object-policy bytes, provider
references, all capture timestamps, database receipt, object inventory summary, and referenced key
IDs in the strict `RecoveryManifestSchema` from `@proofstack/contracts`.

Run `verifyRecoverySet` from `@proofstack/recovery` over the stored dump bytes, configuration,
inventory, migration ledger, key IDs, and manifest. It recomputes component digests and exact
ordered comparisons. The integration rehearsal shows the complete composition. Preserve the
verification report outside ProofStack.

Only after every component is immutable and verification succeeds may the authorized operator
record completion and release the mutation fence. On any error, keep the fence, preserve evidence,
and either finish the same set safely or abandon it explicitly and start a new recovery-set ID.

## Isolated restore procedure

1. Select the ProofStack revision named by the manifest and verify the stored component digests
   before opening any target.
2. Create a new, empty PostgreSQL database and a new, empty bucket or reserved prefix. Never restore
   over a live or previously used destination.
3. Restore the provider key snapshot into an isolated key-provider destination. Confirm that every
   manifest key ID exists, without logging key material.
4. Build the recovery command from the selected revision and inject dedicated credentials for the
   empty target database.
5. Run the database restore:

```bash
PROOFSTACK_ENV=production node services/recovery/dist/cli-entrypoint.js \
  database-restore /absolute/immutable/path/database.dump
```

The wrapper proves that the target has no user objects, executes `pg_restore` with
`--exit-on-error --single-transaction --no-owner --no-privileges`, and then verifies that the
restored migration IDs and checksums are current for the selected revision. It does not migrate or
repair the target silently.

6. Copy each inventoried ciphertext object under the exact same key into the empty restore
   namespace. Recompute every size and SHA-256. Refuse an overwrite, missing object, or extra object.
7. Re-run `verifyRecoverySet` using the restored migration ledger and restored catalog key-ID set.
8. Provision new least-privilege runtime roles and fresh passwords with `pnpm db:provision`. This
   also re-revokes public execution of every platform function because the owner- and
   privilege-independent dump intentionally carries no ACLs. Never reuse roles or credentials
   captured from the source installation.
9. Through the normal repositories and cryptographic read path, verify all authoritative tables
   and sequences, decrypt representative available artifacts, prove purged artifacts remain absent
   and unreadable, and compare exact content—not only counts. Regression fixtures and datasets must
   retain their exact logical and version identifiers, predecessor digests, canonically ordered
   event and fixture memberships, original provenance, and one canonical publication outbox intent.
10. Run the cross-tenant matrix with the fresh runtime roles: absent context, forged tenant values,
    guessed identifiers, cross-tenant reads, and pooled-connection reuse must all fail.
11. Start an isolated API, ingest and read new evidence, and prove this changes only the restored
    target. Keep external traffic blocked until an authorized reviewer accepts every result.

If any step fails, do not admit traffic and do not overlay another recovery set. Preserve the
failed target for investigation or destroy it through the deployment's audited disposal process,
then restore again into a new empty destination.

## Migration rollback and forward repair

ProofStack migrations are ordered, checksum-verified, immutable, and transactional. They do not
have generated `down` scripts.

- A migration that fails before commit rolls back its transaction.
- An applied migration is corrected by a new forward migration.
- Whole-installation rollback means restoring a coordinated recovery set captured before the
  irreversible change, never reversing only PostgreSQL.
- An older binary may run only if it recognizes every applied migration and checksum. Unknown,
  missing, reordered, or changed history is a startup barrier, not a warning.
- Schema removal requires a compatibility window across releases and a pre-change recovery set.

Migration `0010_force_identity_tenant_rls` is the reference forward repair. It adds no columns or
data transformation; it applies `FORCE ROW LEVEL SECURITY` to four identity tables. Each
`ALTER TABLE` takes an `ACCESS EXCLUSIVE` metadata lock, so it must run under the mutation fence and
operators must monitor lock wait time. New application code works before and after the change, but
a release that does not know migration 0010 must refuse the post-migration ledger. If deployment
fails after application rollout, retain a binary that recognizes 0010 and repair forward; use the
last coordinated pre-0010 recovery set only when whole-installation rollback is required.

Migration `0012_pin_evidence_event_collation` transactionally rebuilds the evidence trace-order
index so its final event-ID key uses the bytewise PostgreSQL `C` collation. The regular index build
scans the evidence table, consumes temporary disk and WAL capacity, and blocks writers, so apply it
under the mutation fence while monitoring lock wait, storage, and replication lag. Deploy the new
query code first and fully drain older processes: the new code is correct before and after 0012,
while an already-running old process can still issue locale-sensitive reads. Apply 0012 only after
that drain, verify the checksum ledger and valid/ready index collation, and then release the fence.
Any defect is repaired by a new 0016-or-later forward migration; never edit 0012 or synthesize a
down migration. Capture a coordinated pre-0012 recovery set when whole-installation binary rollback
must remain possible, because a binary that does not recognize 0012 must reject its ledger. CI
proves clean installation, an isolated 0011-to-0012 upgrade with preserved evidence, index
integrity and idempotence, the old-binary barrier, and restoration of the collated index.

Migration `0013_regression_catalog` adds the six tenant-scoped, append-only regression resource,
version, and ordered-membership tables. Fixture event membership carries the complete fixture
scope and source trace, while the authorized publication use case owns the bounded canonical
evidence capture and the repository revalidates the complete immutable candidate at its transaction
boundary. Creating the tables, indexes, foreign keys, and deferred completeness triggers still
takes heavyweight catalog locks and consumes WAL. Apply 0013 only under the mutation fence after
draining old processes, with a coordinated pre-0013 recovery set available. Verify scope-bound
membership, deferred membership completeness, forced RLS, exact runtime grants, migration ledger,
and valid indexes before releasing the fence. A binary that knows only 0012 must reject the newer
ledger; remediation is a 0016-or-later forward repair or restoration of the complete pre-0013
recovery set, never a partial catalog rollback.

Migration `0014_recorded_interaction_fixtures` extends fixture headers to the versioned
`recorded_interactions` form and adds the immutable capture manifest, unique artifact ownership,
and content-revocation tables. It also widens the artifact tombstone trigger vocabulary and adds
deferred transaction guards that require complete ownership at publication and complete matching
tombstones at revocation. Apply 0014 under the mutation fence after draining processes that know
only the evidence-only fixture schema. Retain a coordinated pre-0014 recovery set, verify forced
RLS and least-privilege grants, rehearse both complete and deliberately partial publication and
revocation transactions, and confirm the exact ownership and revocation records after restore
before releasing the fence. Repair defects with a new forward migration; never edit 0014 or restore
only the regression or artifact half of the installation.

Migration `0015_expand_artifact_tombstone_trigger` is the immediate forward repair that widens the
pre-existing artifact tombstone trigger column for the versioned `fixture_revocation` token. Treat
0014 and 0015 as one fenced rollout: do not enable recorded-fixture writes after applying only
0014. The repair takes an `ACCESS EXCLUSIVE` lock on the tombstone relation; monitor lock wait,
then run the complete publication, revocation, and recovery rehearsal before releasing the fence.
A defect after 0015 requires a new 0016-or-later migration.

## What the repository proves

The dedicated recovery CI job:

- creates a real PostgreSQL 16.15 custom dump and restores it into a separately named empty DB;
- fills and compares every authoritative `proofstack_*` table and sequence;
- publishes representative fixture and dataset roots and descendants through the normal use cases,
  then verifies exact event order, dataset membership order, definition digests, provenance,
  canonical outbox locators, and cross-scope hiding after restore;
- copies real encrypted S3-compatible bytes through isolated source, backup, and restore buckets;
- restores the matching test key version and decrypts content through the normal artifact read;
- reprovisions fresh runtime roles and proves evidence, artifact, recorded-fixture, and regression
  tenant isolation;
- proves purged content remains absent and new restored evidence and regression publications do not
  affect the source; and
- proves an older migration set rejects the newer ledger.

The separate PostgreSQL adversarial matrix discovers every public table with a `tenant_id` column,
requires enabled and forced RLS with policies and no public DML grant, and attacks the database
through a reused least-privilege pool.

## Unsupported claims and deployment responsibilities

This reference does not establish continuous backup, point-in-time recovery, cross-region
failover, zero downtime, an RPO, an RTO, arbitrary S3 compatibility, or a production external-key
integration. It also cannot guarantee deletion from provider backups: a backup may retain
ciphertext after live purge until its separately declared retention expires.

Each deployment owns provider-specific immutability, off-site retention, key escrow or recovery,
backup deletion, monitoring, access review, restore capacity, repeated rehearsals, and measured
object/database duration. Rehearse after a provider, schema, retention, key, topology, or scale
change and on the deployment's declared schedule. A successful repository CI run is evidence for
the reference profile, not a substitute for that rehearsal.
