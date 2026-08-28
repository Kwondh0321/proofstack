import { createHash } from "node:crypto";
import type {
  RecoveryManifest,
  RecoveryMigrationLedgerEntry,
  RecoveryObjectInventoryEntry,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { RecoveryVerificationError } from "./errors.js";
import { encodeRecoveryObjectInventory } from "./inventory.js";
import { type RecoverySetVerificationInput, verifyRecoverySet } from "./verification.js";

const DATABASE = Buffer.from("postgresql custom dump", "utf8");
const CONFIGURATION = Buffer.from('{"deployment":"primary"}\n', "utf8");
const LEDGER: readonly RecoveryMigrationLedgerEntry[] = [
  { checksum: "a".repeat(64), id: "0001_evidence_store" },
  { checksum: "b".repeat(64), id: "0002_outbox_delivery" },
];
const INVENTORY: readonly RecoveryObjectInventoryEntry[] = [
  {
    ciphertextSha256: "c".repeat(64),
    objectKey: "objects/v1/aa/object-a",
    sizeBytes: 512,
  },
];
const KEYS = ["key_archived", "key_primary"] as const;

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifest(): RecoveryManifest {
  const inventory = encodeRecoveryObjectInventory(INVENTORY).summary;
  return {
    capture: {
      completedAt: "2026-08-28T03:05:00.000Z",
      databaseCapturedAt: "2026-08-28T03:01:00.000Z",
      fencedAt: "2026-08-28T03:00:00.000Z",
      keySnapshotCapturedAt: "2026-08-28T03:04:00.000Z",
      objectSnapshotCapturedAt: "2026-08-28T03:03:00.000Z",
    },
    configurationSha256: digest(CONFIGURATION),
    database: {
      dumpFormat: "postgresql-custom",
      engineVersion: "16.15",
      migrationLedger: [...LEDGER],
      reference: "file:database.dump",
      sha256: digest(DATABASE),
      sizeBytes: DATABASE.byteLength,
    },
    deploymentId: "dep_primary",
    keyProvider: {
      provider: "test-keyring",
      reference: "provider:key-backup",
      referencedKeyIds: [...KEYS],
    },
    objectSnapshot: {
      bucketPolicySha256: "d".repeat(64),
      inventoryReference: "file:objects.ndjson",
      inventorySha256: inventory.inventorySha256,
      objectCount: inventory.objectCount,
      provider: "s3-compatible",
      reference: "s3:backup/recovery-set",
      totalCiphertextBytes: inventory.totalCiphertextBytes,
    },
    proofstackRevision: "e".repeat(40),
    recoverySetId: "rec_primary",
    schemaVersion: "0.1",
  };
}

function input(): RecoverySetVerificationInput {
  return {
    configuration: CONFIGURATION,
    databaseDump: DATABASE,
    databaseEngineVersion: "16.15",
    inventory: INVENTORY,
    manifest: manifest(),
    migrationLedger: LEDGER,
    referencedKeyIds: KEYS,
  };
}

function mutate(
  value: RecoverySetVerificationInput,
  override: Partial<RecoverySetVerificationInput>,
): RecoverySetVerificationInput {
  return { ...value, ...override };
}

describe("coordinated recovery verification", () => {
  it("verifies every portable recovery component", () => {
    expect(verifyRecoverySet(input())).toEqual({
      databaseBytes: DATABASE.byteLength,
      keyCount: 2,
      migrationCount: 2,
      objectCount: 1,
      recoverySetId: "rec_primary",
      totalCiphertextBytes: 512,
    });
  });

  it.each([
    ["manifest", { manifest: { invalid: true } }],
    ["database", { databaseDump: new Uint8Array() }],
    ["database", { databaseDump: Buffer.from("tampered") }],
    ["database", { databaseEngineVersion: "17.0" }],
    ["configuration", { configuration: new Uint8Array() }],
    ["configuration", { configuration: Buffer.from("tampered") }],
    ["inventory", { inventory: [{ ...INVENTORY[0]!, sizeBytes: 513 }] }],
    ["inventory", { inventory: [{ ...INVENTORY[0]!, objectKey: "invalid" }] }],
    ["migration-ledger", { migrationLedger: [] }],
    ["migration-ledger", { migrationLedger: [...LEDGER].reverse() }],
    [
      "migration-ledger",
      { migrationLedger: [{ ...LEDGER[0]!, checksum: "f".repeat(64) }, LEDGER[1]!] },
    ],
    ["key-provider", { referencedKeyIds: ["INVALID"] }],
    ["key-provider", { referencedKeyIds: [...KEYS].reverse() }],
    ["key-provider", { referencedKeyIds: ["key_archived"] }],
  ])("fails closed for a %s mismatch %#", (component, override) => {
    expect(() => verifyRecoverySet(mutate(input(), override))).toThrow(
      expect.objectContaining({
        code: "recovery_set_verification_failed",
        component,
      }),
    );
  });

  it("preserves the manifest validation cause without exposing component data", () => {
    try {
      verifyRecoverySet(mutate(input(), { manifest: null }));
      expect.fail("expected verification to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryVerificationError);
      expect((error as RecoveryVerificationError).cause).toBeDefined();
      expect((error as Error).message).toBe(
        "Recovery manifest verification failed: manifest contract is invalid",
      );
    }
  });
});
