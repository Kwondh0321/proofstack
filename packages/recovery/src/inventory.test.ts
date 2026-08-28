import { createHash } from "node:crypto";
import type { RecoveryObjectInventoryEntry } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { RecoveryVerificationError } from "./errors.js";
import { encodeRecoveryObjectInventory, RecoveryObjectInventoryAccumulator } from "./inventory.js";

const ENTRY: RecoveryObjectInventoryEntry = {
  ciphertextSha256: "a".repeat(64),
  objectKey: "objects/v1/aa/object-a",
  sizeBytes: 128,
};

describe("recovery object inventory", () => {
  it("encodes ordered entries as canonical digestible JSON Lines", () => {
    const entries = [
      ENTRY,
      {
        ciphertextSha256: "b".repeat(64),
        objectKey: "objects/v1/bb/object-b",
        providerVersionId: "version-b",
        sizeBytes: 256,
      },
    ];
    const encoded = encodeRecoveryObjectInventory(entries);
    const expected = `${JSON.stringify(ENTRY)}\n${JSON.stringify(entries[1])}\n`;
    expect(Buffer.from(encoded.bytes).toString("utf8")).toBe(expected);
    expect(encoded.summary).toEqual({
      inventorySha256: createHash("sha256").update(expected).digest("hex"),
      objectCount: 2,
      totalCiphertextBytes: 384,
    });
  });

  it("produces the standard empty SHA-256 for an empty inventory", () => {
    expect(encodeRecoveryObjectInventory([]).summary).toEqual({
      inventorySha256: createHash("sha256").digest("hex"),
      objectCount: 0,
      totalCiphertextBytes: 0,
    });
  });

  it.each([
    [{ ...ENTRY, objectKey: "invalid" }, "inventory entry is invalid"],
    [[ENTRY, ENTRY], "object keys must be unique and strictly ordered"],
    [
      [ENTRY, { ...ENTRY, objectKey: "objects/v1/00/earlier" }],
      "object keys must be unique and strictly ordered",
    ],
  ])("rejects invalid or non-canonical entries %#", (value, reason) => {
    const entries = Array.isArray(value) ? value : [value];
    expect(() => encodeRecoveryObjectInventory(entries)).toThrow(
      expect.objectContaining({ component: "inventory", reason }),
    );
  });

  it("rejects mutation after finalization", () => {
    const accumulator = new RecoveryObjectInventoryAccumulator();
    accumulator.add(ENTRY);
    accumulator.finish();
    expect(() => accumulator.add(ENTRY)).toThrow(RecoveryVerificationError);
    expect(() => accumulator.finish()).toThrow(RecoveryVerificationError);
  });

  it("rejects a cumulative ciphertext size outside safe integer bounds", () => {
    const accumulator = new RecoveryObjectInventoryAccumulator();
    accumulator.add({ ...ENTRY, sizeBytes: Number.MAX_SAFE_INTEGER });
    expect(() =>
      accumulator.add({ ...ENTRY, objectKey: "objects/v1/zz/object-z", sizeBytes: 1 }),
    ).toThrow(expect.objectContaining({ reason: "ciphertext byte total exceeds safe bounds" }));
    expect(accumulator.finish()).toMatchObject({
      objectCount: 1,
      totalCiphertextBytes: Number.MAX_SAFE_INTEGER,
    });
  });
});
