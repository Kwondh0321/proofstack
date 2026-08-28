import { z } from "zod";
import { OpaqueIdSchema, Sha256Schema, TimestampSchema } from "./primitives.js";

export const RECOVERY_MANIFEST_SCHEMA_VERSION = "0.1" as const;
export const RECOVERY_OBJECT_INVENTORY_SCHEMA_VERSION = "0.1" as const;

export const RecoveryComponentReferenceSchema = z
  .string()
  .min(3)
  .max(1_056)
  .regex(/^[a-z][a-z0-9+.-]{1,31}:[^\s?&#@]{1,1024}$/);

export const ProofStackRevisionSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export const PostgreSqlMigrationIdSchema = z.string().regex(/^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/);

export const RecoveryMigrationLedgerEntrySchema = z
  .object({
    checksum: Sha256Schema,
    id: PostgreSqlMigrationIdSchema,
  })
  .strict();

const RecoveryMigrationLedgerSchema = z
  .array(RecoveryMigrationLedgerEntrySchema)
  .min(1)
  .max(1_024)
  .refine(
    (entries) =>
      entries.every((entry, index) => {
        const previous = entries[index - 1];
        return previous === undefined || previous.id < entry.id;
      }),
    { message: "Migration ledger entries must be unique and ordered by id" },
  );

const ReferencedKeyIdsSchema = z
  .array(OpaqueIdSchema)
  .max(1_024)
  .refine(
    (keyIds) =>
      keyIds.every((keyId, index) => {
        const previous = keyIds[index - 1];
        return previous === undefined || previous < keyId;
      }),
    {
      message: "Referenced key identifiers must be unique and ordered",
    },
  );

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

export const RecoveryObjectInventoryEntrySchema = z
  .object({
    ciphertextSha256: Sha256Schema,
    objectKey: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          value.trim() === value &&
          !containsControlCharacter(value) &&
          value.startsWith("objects/v1/"),
        { message: "Object key must be a canonical ProofStack object locator" },
      ),
    providerVersionId: z.string().min(1).max(1_024).optional(),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const RecoveryCaptureSchema = z
  .object({
    completedAt: TimestampSchema,
    databaseCapturedAt: TimestampSchema,
    fencedAt: TimestampSchema,
    keySnapshotCapturedAt: TimestampSchema,
    objectSnapshotCapturedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (capture) => {
      const timestamps = [
        capture.fencedAt,
        capture.databaseCapturedAt,
        capture.objectSnapshotCapturedAt,
        capture.keySnapshotCapturedAt,
        capture.completedAt,
      ];
      return timestamps.every((timestamp, index) => {
        const previous = timestamps[index - 1];
        return previous === undefined || Date.parse(previous) <= Date.parse(timestamp);
      });
    },
    { message: "Recovery capture timestamps must follow the fenced capture order" },
  );

export const RecoveryManifestSchema = z
  .object({
    capture: RecoveryCaptureSchema,
    configurationSha256: Sha256Schema,
    database: z
      .object({
        dumpFormat: z.literal("postgresql-custom"),
        engineVersion: z.string().min(1).max(64),
        migrationLedger: RecoveryMigrationLedgerSchema,
        reference: RecoveryComponentReferenceSchema,
        sha256: Sha256Schema,
        sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    deploymentId: OpaqueIdSchema,
    keyProvider: z
      .object({
        provider: z.string().min(1).max(128),
        reference: RecoveryComponentReferenceSchema,
        referencedKeyIds: ReferencedKeyIdsSchema,
      })
      .strict(),
    objectSnapshot: z
      .object({
        bucketPolicySha256: Sha256Schema,
        inventoryReference: RecoveryComponentReferenceSchema,
        inventorySha256: Sha256Schema,
        objectCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        provider: z.string().min(1).max(128),
        reference: RecoveryComponentReferenceSchema,
        totalCiphertextBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .superRefine((snapshot, context) => {
        if (snapshot.objectCount === 0 && snapshot.totalCiphertextBytes !== 0) {
          context.addIssue({
            code: "custom",
            message: "An empty object inventory cannot contain ciphertext bytes",
            path: ["totalCiphertextBytes"],
          });
        }
        if (snapshot.objectCount > 0 && snapshot.totalCiphertextBytes === 0) {
          context.addIssue({
            code: "custom",
            message: "A non-empty object inventory must contain ciphertext bytes",
            path: ["totalCiphertextBytes"],
          });
        }
      }),
    proofstackRevision: ProofStackRevisionSchema,
    recoverySetId: OpaqueIdSchema,
    schemaVersion: z.literal(RECOVERY_MANIFEST_SCHEMA_VERSION),
  })
  .strict();

export type RecoveryManifest = z.infer<typeof RecoveryManifestSchema>;
export type RecoveryMigrationLedgerEntry = z.infer<typeof RecoveryMigrationLedgerEntrySchema>;
export type RecoveryObjectInventoryEntry = z.infer<typeof RecoveryObjectInventoryEntrySchema>;
