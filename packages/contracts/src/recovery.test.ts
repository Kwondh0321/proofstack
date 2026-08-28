import { describe, expect, it } from "vitest";
import {
  PostgreSqlMigrationIdSchema,
  ProofStackRevisionSchema,
  RecoveryComponentReferenceSchema,
  RecoveryManifestSchema,
  RecoveryObjectInventoryEntrySchema,
} from "./recovery.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function manifest() {
  return {
    capture: {
      completedAt: "2026-08-28T03:05:00.000Z",
      databaseCapturedAt: "2026-08-28T03:01:00.000Z",
      fencedAt: "2026-08-28T03:00:00.000Z",
      keySnapshotCapturedAt: "2026-08-28T03:04:00.000Z",
      objectSnapshotCapturedAt: "2026-08-28T03:03:00.000Z",
    },
    configurationSha256: DIGEST_A,
    database: {
      dumpFormat: "postgresql-custom",
      engineVersion: "16.15",
      migrationLedger: [
        { checksum: DIGEST_A, id: "0001_evidence_store" },
        { checksum: DIGEST_B, id: "0002_outbox_delivery" },
      ],
      reference: "file:database.dump",
      sha256: DIGEST_B,
      sizeBytes: 4_096,
    },
    deploymentId: "dep_primary",
    keyProvider: {
      provider: "test-keyring",
      reference: "provider:key-backup-20260828",
      referencedKeyIds: ["key_archived", "key_primary"],
    },
    objectSnapshot: {
      bucketPolicySha256: DIGEST_A,
      inventoryReference: "file:objects.ndjson",
      inventorySha256: DIGEST_B,
      objectCount: 2,
      provider: "s3-compatible",
      reference: "s3:proofstack-backup/recovery-set",
      totalCiphertextBytes: 2_048,
    },
    proofstackRevision: "c".repeat(40),
    recoverySetId: "rec_20260828_primary",
    schemaVersion: "0.1",
  };
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mergeManifestOverride(override: Record<string, unknown>): unknown {
  const value: Record<string, unknown> = manifest();
  const [section, replacement] = Object.entries(override)[0]!;
  const current = value[section];
  return {
    ...value,
    [section]:
      objectRecord(current) && objectRecord(replacement)
        ? { ...current, ...replacement }
        : replacement,
  };
}

describe("recovery contracts", () => {
  it("accepts a bounded canonical coordinated recovery manifest", () => {
    expect(RecoveryManifestSchema.parse(manifest())).toEqual(manifest());
  });

  it.each([
    { database: { migrationLedger: [{ checksum: DIGEST_A, id: "not-ordered" }] } },
    { database: { reference: "https://user:password@example.test/dump" } },
    { proofstackRevision: "A".repeat(40) },
    { capture: { completedAt: "2026-08-28T02:00:00.000Z" } },
    {
      database: {
        migrationLedger: [
          { checksum: DIGEST_B, id: "0002_outbox_delivery" },
          { checksum: DIGEST_A, id: "0001_evidence_store" },
        ],
      },
    },
    { keyProvider: { referencedKeyIds: ["key_primary", "key_archived"] } },
    { objectSnapshot: { objectCount: 0, totalCiphertextBytes: 1 } },
    { objectSnapshot: { objectCount: 1, totalCiphertextBytes: 0 } },
    { unexpected: true },
  ])("rejects a non-canonical or inconsistent manifest %#", (override) => {
    expect(RecoveryManifestSchema.safeParse(mergeManifestOverride(override)).success).toBe(false);
  });

  it("accepts an empty object inventory only with zero bytes", () => {
    const value = manifest();
    value.objectSnapshot.objectCount = 0;
    value.objectSnapshot.totalCiphertextBytes = 0;
    expect(RecoveryManifestSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    { objectKey: "other/v1/object" },
    { objectKey: " objects/v1/object" },
    { objectKey: "objects/v1/object\n" },
    { sizeBytes: 0 },
    { providerVersionId: "" },
    { extra: true },
  ])("rejects an invalid object inventory entry %#", (override) => {
    expect(
      RecoveryObjectInventoryEntrySchema.safeParse({
        ciphertextSha256: DIGEST_A,
        objectKey: "objects/v1/ab/object",
        providerVersionId: "version-1",
        sizeBytes: 128,
        ...override,
      }).success,
    ).toBe(false);
  });

  it("accepts an exact-key ciphertext inventory entry", () => {
    expect(
      RecoveryObjectInventoryEntrySchema.parse({
        ciphertextSha256: DIGEST_A,
        objectKey: "objects/v1/ab/object",
        sizeBytes: 128,
      }),
    ).toEqual({
      ciphertextSha256: DIGEST_A,
      objectKey: "objects/v1/ab/object",
      sizeBytes: 128,
    });
  });

  it.each([
    [RecoveryComponentReferenceSchema, "file:database.dump", true],
    [RecoveryComponentReferenceSchema, "file:dump?token=secret", false],
    [ProofStackRevisionSchema, "d".repeat(64), true],
    [ProofStackRevisionSchema, "d".repeat(41), false],
    [PostgreSqlMigrationIdSchema, "0010_recovery_gate", true],
    [PostgreSqlMigrationIdSchema, "10-recovery", false],
  ])("validates primitive recovery contract %#", (schema, value, accepted) => {
    expect(schema.safeParse(value).success).toBe(accepted);
  });
});
