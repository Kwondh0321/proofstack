import { createHash, type Hash } from "node:crypto";
import {
  RecoveryObjectInventoryEntrySchema,
  type RecoveryObjectInventoryEntry,
} from "@proofstack/contracts/recovery";
import { RecoveryVerificationError } from "./errors.js";

export interface RecoveryObjectInventorySummary {
  readonly inventorySha256: string;
  readonly objectCount: number;
  readonly totalCiphertextBytes: number;
}

function canonicalInventoryLine(entry: RecoveryObjectInventoryEntry): string {
  return `${JSON.stringify({
    ciphertextSha256: entry.ciphertextSha256,
    objectKey: entry.objectKey,
    ...(entry.providerVersionId === undefined
      ? {}
      : { providerVersionId: entry.providerVersionId }),
    sizeBytes: entry.sizeBytes,
  })}\n`;
}

export class RecoveryObjectInventoryAccumulator {
  readonly #digest: Hash = createHash("sha256");
  #finished = false;
  #lastObjectKey: string | undefined;
  #objectCount = 0;
  #totalCiphertextBytes = 0;

  add(input: RecoveryObjectInventoryEntry): string {
    if (this.#finished) {
      throw new RecoveryVerificationError("inventory", "inventory is already finalized");
    }
    const parsed = RecoveryObjectInventoryEntrySchema.safeParse(input);
    if (!parsed.success) {
      throw new RecoveryVerificationError("inventory", "inventory entry is invalid", {
        cause: parsed.error,
      });
    }
    const entry = parsed.data;
    if (this.#lastObjectKey !== undefined && this.#lastObjectKey >= entry.objectKey) {
      throw new RecoveryVerificationError(
        "inventory",
        "object keys must be unique and strictly ordered",
      );
    }
    const nextTotalCiphertextBytes = this.#totalCiphertextBytes + entry.sizeBytes;
    if (!Number.isSafeInteger(nextTotalCiphertextBytes)) {
      throw new RecoveryVerificationError("inventory", "ciphertext byte total exceeds safe bounds");
    }
    const line = canonicalInventoryLine(entry);
    this.#digest.update(line, "utf8");
    this.#lastObjectKey = entry.objectKey;
    this.#objectCount += 1;
    this.#totalCiphertextBytes = nextTotalCiphertextBytes;
    return line;
  }

  finish(): RecoveryObjectInventorySummary {
    if (this.#finished) {
      throw new RecoveryVerificationError("inventory", "inventory is already finalized");
    }
    this.#finished = true;
    return {
      inventorySha256: this.#digest.digest("hex"),
      objectCount: this.#objectCount,
      totalCiphertextBytes: this.#totalCiphertextBytes,
    };
  }
}

export function encodeRecoveryObjectInventory(entries: readonly RecoveryObjectInventoryEntry[]): {
  readonly bytes: Uint8Array;
  readonly summary: RecoveryObjectInventorySummary;
} {
  const accumulator = new RecoveryObjectInventoryAccumulator();
  const lines = entries.map((entry) => accumulator.add(entry));
  return {
    bytes: Buffer.from(lines.join(""), "utf8"),
    summary: accumulator.finish(),
  };
}
