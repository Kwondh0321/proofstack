import { describe, expect, it } from "vitest";
import { generateApiKey } from "./api-key.js";
import {
  generateServiceToken,
  parseServiceToken,
  hashServiceTokenSecret,
  verifyServiceTokenSecret,
  ServiceTokenFormatError,
} from "./service-token.js";

describe("separate service token wire format and shared secret verification", () => {
  it("generates independent canonical public prefixes and 256-bit secrets", () => {
    const first = generateServiceToken(),
      second = generateServiceToken();
    expect(first.value).not.toBe(second.value);
    expect(parseServiceToken(first.value)).toEqual({ prefix: first.prefix, secret: first.secret });
    expect(Buffer.from(first.prefix, "base64url")).toHaveLength(16);
    expect(Buffer.from(first.secret, "base64url")).toHaveLength(32);
  });
  it.each([0, 47, 49])("refuses a random source returning %i bytes", (length) => {
    expect(() => generateServiceToken(() => new Uint8Array(length))).toThrow(
      ServiceTokenFormatError,
    );
  });
  it.each(["", "invalid", "pss_v2_", " ", "x".repeat(10000)])(
    "refuses malformed input %#",
    (value) => {
      expect(() => parseServiceToken(value)).toThrow(ServiceTokenFormatError);
    },
  );
  it("rejects API keys rather than relabeling their namespace", () => {
    expect(() => parseServiceToken(generateApiKey().value)).toThrow(ServiceTokenFormatError);
  });
  it.each(["prefix", "secret"] as const)("rejects noncanonical final bits in %s", (field) => {
    const token = generateServiceToken(() => new Uint8Array(48));
    const changed = { ...token, [field]: token[field].slice(0, -1) + "B" };
    expect(() => parseServiceToken(`pss_v1_${changed.prefix}_${changed.secret}`)).toThrow(
      ServiceTokenFormatError,
    );
  });
  it("reuses the existing bounded scrypt-v1 hash and constant-time secret verification", async () => {
    const token = generateServiceToken(),
      other = generateServiceToken();
    const hash = await hashServiceTokenSecret(token.secret);
    expect(hash.algorithm).toBe("scrypt-v1");
    expect(await verifyServiceTokenSecret(token.secret, hash)).toBe(true);
    expect(await verifyServiceTokenSecret(other.secret, hash)).toBe(false);
  });
});
