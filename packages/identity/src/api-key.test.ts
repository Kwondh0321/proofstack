import { describe, expect, it } from "vitest";
import {
  ApiKeyFormatError,
  ApiKeyHashError,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  verifyApiKeySecret,
} from "./api-key.js";

function bytes(value: number): (size: number) => Uint8Array {
  return (size) => new Uint8Array(size).fill(value);
}

describe("API key format", () => {
  it("generates a canonical prefix and 256-bit secret", () => {
    const issued = generateApiKey(bytes(7));

    expect(issued.prefix).toHaveLength(12);
    expect(issued.secret).toHaveLength(43);
    expect(issued.value).toBe(`psk_v1_${issued.prefix}_${issued.secret}`);
    expect(parseApiKey(issued.value)).toEqual({ prefix: issued.prefix, secret: issued.secret });
  });

  it("uses the operating-system random source by default", () => {
    const issued = generateApiKey();
    expect(parseApiKey(issued.value)).toEqual({ prefix: issued.prefix, secret: issued.secret });
  });

  it.each(["", "psk_v1_short_secret", "PSK_v1_prefix_secret", " psk_v1_x_y", "psk_v2_x_y"])(
    "rejects malformed value %j",
    (value) => {
      expect(() => parseApiKey(value)).toThrow(ApiKeyFormatError);
    },
  );

  it("fails closed when the random source returns the wrong size", () => {
    expect(() => generateApiKey(() => new Uint8Array(40))).toThrow("expected 41");
  });
});

describe("API key password hashing", () => {
  it("verifies the matching secret and rejects another secret", async () => {
    const issued = generateApiKey(bytes(3));
    const different = generateApiKey(bytes(4));
    const hash = await hashApiKeySecret(issued.secret, bytes(5));

    await expect(verifyApiKeySecret(issued.secret, hash)).resolves.toBe(true);
    await expect(verifyApiKeySecret(different.secret, hash)).resolves.toBe(false);
    expect(hash).toMatchObject({
      algorithm: "scrypt-v1",
      blockSize: 8,
      cost: 32_768,
      keyLength: 32,
      parallelization: 1,
    });
    expect(hash.salt).not.toContain(issued.secret);
    expect(hash.digest).not.toContain(issued.secret);
  });

  it("uses an independently generated salt", async () => {
    const issued = generateApiKey(bytes(6));
    const first = await hashApiKeySecret(issued.secret, bytes(7));
    const second = await hashApiKeySecret(issued.secret, bytes(8));

    expect(first.salt).not.toBe(second.salt);
    expect(first.digest).not.toBe(second.digest);
  });

  it("rejects malformed secrets before hashing", async () => {
    await expect(hashApiKeySecret("not-a-secret", bytes(1))).rejects.toBeInstanceOf(
      ApiKeyFormatError,
    );
    await expect(hashApiKeySecret("!".repeat(43), bytes(1))).rejects.toBeInstanceOf(
      ApiKeyFormatError,
    );
  });

  it("rejects unsupported or corrupt stored hashes", async () => {
    const issued = generateApiKey(bytes(9));
    const hash = await hashApiKeySecret(issued.secret, bytes(10));

    await expect(
      verifyApiKeySecret(issued.secret, { ...hash, algorithm: "future" as "scrypt-v1" }),
    ).rejects.toBeInstanceOf(ApiKeyHashError);
    await expect(
      verifyApiKeySecret(issued.secret, { ...hash, digest: "invalid" }),
    ).rejects.toBeInstanceOf(ApiKeyHashError);
  });
});
