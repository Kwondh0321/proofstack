import { createHash } from "node:crypto";
import {
  OpaqueIdSchema,
  RecoveryManifestSchema,
  RecoveryMigrationLedgerEntrySchema,
  type RecoveryManifest,
  type RecoveryMigrationLedgerEntry,
  type RecoveryObjectInventoryEntry,
} from "@proofstack/contracts";
import { RecoveryVerificationError } from "./errors.js";
import { encodeRecoveryObjectInventory } from "./inventory.js";

export interface RecoverySetVerificationInput {
  readonly configuration: Uint8Array;
  readonly databaseDump: Uint8Array;
  readonly databaseEngineVersion: string;
  readonly inventory: readonly RecoveryObjectInventoryEntry[];
  readonly manifest: unknown;
  readonly migrationLedger: readonly RecoveryMigrationLedgerEntry[];
  readonly referencedKeyIds: readonly string[];
}

export interface RecoverySetVerificationReport {
  readonly databaseBytes: number;
  readonly keyCount: number;
  readonly migrationCount: number;
  readonly objectCount: number;
  readonly recoverySetId: string;
  readonly totalCiphertextBytes: number;
}

function fail(
  component: ConstructorParameters<typeof RecoveryVerificationError>[0],
  reason: string,
  cause?: unknown,
): never {
  throw new RecoveryVerificationError(
    component,
    reason,
    cause === undefined ? undefined : { cause },
  );
}

function validBytes(value: unknown, component: "configuration" | "database"): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    fail(component, "component bytes are missing or empty");
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseManifest(input: unknown): RecoveryManifest {
  const parsed = RecoveryManifestSchema.safeParse(input);
  if (!parsed.success) fail("manifest", "manifest contract is invalid", parsed.error);
  return parsed.data;
}

function parseLedger(
  entries: readonly RecoveryMigrationLedgerEntry[],
): readonly RecoveryMigrationLedgerEntry[] {
  const parsed = RecoveryMigrationLedgerEntrySchema.array().min(1).max(1_024).safeParse(entries);
  if (!parsed.success)
    fail("migration-ledger", "restored migration ledger is invalid", parsed.error);
  if (!parsed.data.every((entry, index) => index === 0 || parsed.data[index - 1]!.id < entry.id)) {
    fail("migration-ledger", "restored migration ledger is not strictly ordered");
  }
  return parsed.data;
}

function parseKeyIds(keyIds: readonly string[]): readonly string[] {
  const parsed = OpaqueIdSchema.array().max(1_024).safeParse(keyIds);
  if (!parsed.success) fail("key-provider", "restored key references are invalid", parsed.error);
  if (!parsed.data.every((keyId, index) => index === 0 || parsed.data[index - 1]! < keyId)) {
    fail("key-provider", "restored key references are not strictly ordered");
  }
  return parsed.data;
}

export function verifyRecoverySet(
  input: RecoverySetVerificationInput,
): RecoverySetVerificationReport {
  const manifest = parseManifest(input.manifest);
  const databaseDump = validBytes(input.databaseDump, "database");
  const configuration = validBytes(input.configuration, "configuration");

  if (
    databaseDump.byteLength !== manifest.database.sizeBytes ||
    sha256(databaseDump) !== manifest.database.sha256
  ) {
    fail("database", "dump size or SHA-256 does not match the manifest");
  }
  if (input.databaseEngineVersion !== manifest.database.engineVersion) {
    fail("database", "database engine version does not match the manifest");
  }
  if (sha256(configuration) !== manifest.configurationSha256) {
    fail("configuration", "configuration SHA-256 does not match the manifest");
  }

  const inventory = encodeRecoveryObjectInventory(input.inventory);
  if (
    inventory.summary.inventorySha256 !== manifest.objectSnapshot.inventorySha256 ||
    inventory.summary.objectCount !== manifest.objectSnapshot.objectCount ||
    inventory.summary.totalCiphertextBytes !== manifest.objectSnapshot.totalCiphertextBytes
  ) {
    fail("inventory", "inventory digest or totals do not match the manifest");
  }

  const migrationLedger = parseLedger(input.migrationLedger);
  if (exactJson(migrationLedger) !== exactJson(manifest.database.migrationLedger)) {
    fail("migration-ledger", "restored migration ledger does not match the manifest");
  }
  const keyIds = parseKeyIds(input.referencedKeyIds);
  if (exactJson(keyIds) !== exactJson(manifest.keyProvider.referencedKeyIds)) {
    fail("key-provider", "restored key references do not match the manifest");
  }

  return {
    databaseBytes: databaseDump.byteLength,
    keyCount: keyIds.length,
    migrationCount: migrationLedger.length,
    objectCount: inventory.summary.objectCount,
    recoverySetId: manifest.recoverySetId,
    totalCiphertextBytes: inventory.summary.totalCiphertextBytes,
  };
}
