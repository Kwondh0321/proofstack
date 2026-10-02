# Artifact timestamp integrity audit

[English](artifact-timestamp-integrity-audit.md) |
[한국어](artifact-timestamp-integrity-audit.ko.md)

Status: **correction implemented; real database and native restore regressions verified**.
Full repository and exact-commit remote acceptance remain release gates.
Inspected baseline: `d4b375fcc56413cad2cca1ca76d99a3bf0a576fc`.
This finding blocks treating catalog reinspection as an exact database observation cut. It does
not close Workflow 2 checkpoint 3 or add an accepted checkpoint.

## Observed failures

At the inspected baseline, the public reservation use case accepts the following expiry values. Its encryption planner binds
the original retention text into authenticated data. The PostgreSQL catalog stores `timestamptz`
and reads it through `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`. That returned value is not
necessarily the text used to wrap the data key.

| Accepted reservation expiry | Returned catalog expiry | Encryption with the retained plan |
| --- | --- | --- |
| `2026-09-28T03:00:00.000Z` | `2026-09-28T03:00:00.000Z` | Succeeds; decrypts the original bytes |
| `2026-09-28T03:00:00Z` | `2026-09-28T03:00:00.000Z` | `ArtifactProtectionError` |
| `2026-09-28T12:00:00.000+09:00` | `2026-09-28T03:00:00.000Z` | `ArtifactProtectionError` |
| `2026-09-28T03:00:00.000001Z` | `2026-09-28T03:00:00.000Z` | `ArtifactProtectionError`; the retained instant also changes |

A separate actual-adapter case reserves an artifact, encrypts valid bytes, and activates it at
`2026-08-28T03:01:00.000001Z`. Reading it for semantic evaluation time
`2026-08-28T03:01:00.000Z` incorrectly returns `verified`, rather than `not_yet_available`, because
the catalog projection removes the one-microsecond difference before domain inspection. The
domain inspector's exact comparison cannot recover precision already lost by the adapter.

These results came from the existing reservation, catalog, keyring, cipher, and policy artifact
reader, using a disposable UTF-8 PostgreSQL 16 cluster and unique test tenants. No production
database, retained ciphertext, migration, or runtime encryption format was changed by diagnosis.
The test server was stopped afterward.

## Reproduction and evidence boundary

The focused integration group in
[`postgres-artifact-catalog-repository.integration.test.ts`](../../packages/postgres/src/postgres-artifact-catalog-repository.integration.test.ts)
is named `artifact timestamp integrity`:

```sh
# PROOFSTACK_TEST_DATABASE_URL must identify an isolated, disposable integration database.
pnpm --filter @proofstack/postgres exec vitest run \
  --config vitest.integration.config.ts \
  src/postgres-artifact-catalog-repository.integration.test.ts \
  -t 'artifact timestamp integrity'
```

Before correction, **six selected tests ran: one passed and five failed**. Eight unrelated cases
were skipped only by the explicit test-name filter, not removed or disabled. The three encryption
failures, retained-expiry failure, and false temporal acceptance are expected assertions against
the defect, not evidence that the feature is fixed. The added test code passes TypeScript checking.

The baseline's existing repository and remote acceptance suites passed before these cases were
added. Their success does not cover or override these newly reproduced failures. Do not weaken
assertions, remove these cases from integration discovery, or report the current worktree as fully
green while the defects remain.

## Required correction and compatibility review

The following requirements define the correction's acceptance boundary:

1. Preserve authenticated retention meaning across reservation, catalog persistence, a fresh
   connection, encryption, and decryption for supported timestamp representations. Do not change
   the old authenticated-data format in place or make key unwrapping ignore a mismatch.
2. Preserve exact instants needed by policy capture. Activation after the semantic cut must not
   become eligible through timestamp formatting. Receipt chronology, expiry equality, and
   lifecycle reads must agree with the same supported precision contract.
3. Review the complete retention path, including `artifactReservationIdentity`, new-reservation
   expiry validation, memory-adapter comparisons, PostgreSQL projections, and maintenance queries.
   Different submillisecond expiry instants must not silently become an idempotent reservation.
4. Distinguish original authenticated text, exact semantic time, and the database's scheduling/index
   projection. PostgreSQL 16 has microsecond resolution and does not preserve input timezone text;
   a `timestamptz` alone cannot retain all lexical or higher-precision inputs. Any derived projection
   must not cause content to be retired before the admitted exact expiry.
5. If persisted representation changes, use a forward migration with consistent typed projections,
   bounded validation, immutability, tenant isolation, source-lock participation, and recovery ACL
   coverage. Do not edit already-applied migrations or disable runtime guards to pass tests.
6. Prove compatibility for existing valid ciphertext and canonical-millisecond records. An original
   offset, omitted fraction, or discarded fractional suffix cannot be inferred uniquely from the
   current column. Do not fabricate a successful repair of previously broken records. Identify and
   document any required operator-assisted recovery or re-ingestion separately.
7. Re-run the focused regressions, actual adapter and maintenance tests, migration/restore and
   isolation gates, full repository checks, and exact-commit remote CI/Security before proceeding
   with guarded policy publication. A pure inspector or a database lock is not the repair.

## Forward correction and supported precision

Migration `0051_artifact_timestamp_integrity` keeps the original `expires_at_lexical` text and an
exact `numeric(50, 0)` instant key alongside the existing native `expires_at` projection. The key
uses integer seconds plus all admitted fractional digits, at 10^30 units per second. A private,
fixed-search-path trigger checks projection consistency, derives the key, and rejects later changes
to either immutable field. **New expiring rows must provide the original text**; an old writer that
omits it is rejected instead of silently generating a different encryption context.

Reservation identity and expiry validation, the memory adapter, and the PostgreSQL expiration
query now use exact instant comparisons. Equal instants with different spelling reuse the first
record and encryption plan; different fractions conflict. Maintenance uses the exact key, not the
rounded native timestamp, including when expiry is only 10^-30 seconds after creation. The shared
artifact schema enforces the same timestamp bounds and exact lifecycle chronology; the policy
reader reuses that validation instead of retaining duplicate checks.

Retention timestamps admit positive four-digit ISO years, `Z` or offsets through `+/-15:59`, and
at most 30 fractional digits. Native creation, activation and tombstone receipts retain their
microseconds on read; adapter writes that require finer native precision reject before database
I/O rather than round. Existing lossless millisecond receipts keep their old spelling. Purge
receipts retain their existing canonical UTC-millisecond contract. Server clock outputs remain
UTC milliseconds; this correction does not turn a server clock into a 30-digit measurement device.

The migration holds the catalog table's exclusive DDL lock until commit. It temporarily disables
only the old forward-lifecycle guard for the historical backfill, leaves source-lock participation
in place, and reenables the guard in the same transaction. A failure rolls back both schema/data
and trigger state. The new trigger is private, not `SECURITY DEFINER`, and is included in runtime
role reprovisioning's revocation inventory, including after a `--no-acl` restore.

## Upgrade and recovery limits

Use a coordinated upgrade: quiesce old application writers, take the existing coordinated database,
object and key backups, apply the bundled forward migrations with the migration principal, then
start the matching application version and run its readiness checks. Do not advertise mixed-version
rolling writes: the old adapter neither supplies original expiry text nor reads exact receipts.
DDL/backfill can block concurrent catalog work; schedule it for the deployment's actual data volume.

The backfill derives canonical text only from the already-stored native instant. Existing valid
canonical-millisecond ciphertext and retain-mode ciphertext remain compatible, with no envelope or
object rewrite. Previously discarded spelling or fractional digits cannot be uniquely reconstructed.
An older offset or omitted-fraction envelope can therefore still fail authentication after upgrade;
the regression suite preserves that failure rather than introducing an unwrap fallback. Recovery of
such an artifact requires authoritative original metadata and retained key/object material, or
authorized re-ingestion under a new identity. Do not rewrite immutable records, guess timestamps,
or bypass authentication to make a record appear repaired. No automatic legacy salvage is included.

Permanent coverage is in the actual catalog integration group, the
[forward migration tests](../../packages/postgres/src/artifact-timestamp-migration.integration.test.ts),
the shared schema and reservation/maintenance suites, and the
[coordinated recovery rehearsal](../../services/recovery/src/postgres-recovery.integration.test.ts).
The rehearsal includes encrypted content with a 30-digit offset expiry and checks restored exact
metadata, decryption, and private trigger privileges. These tests must actually pass for the release
commit; their presence alone is not acceptance evidence.

Local correction evidence: the complete PostgreSQL package integration suite passed **263/263**
cases across 34 files in a fresh UTF-8 PostgreSQL 16.15 cluster. A separate native custom-format
`--no-owner --no-acl` dump/restore preserved all **43** catalog rows exactly; role reprovisioning
left zero PUBLIC execution grants on platform functions and no timestamp-trigger grant to any of
the ten managed roles. A restored artifact-role read retained the exact 30-digit expiry and its
restored encryption plan decrypted the original plaintext. This local check used supplied key
material and in-memory bytes; it is not the complete S3/key-backup recovery rehearsal or an
observation of a deployed database. The temporary server was stopped after each run.

PostgreSQL reference: [date/time types and precision](https://www.postgresql.org/docs/16/datatype-datetime.html)
and [formatting patterns](https://www.postgresql.org/docs/16/functions-formatting.html).
