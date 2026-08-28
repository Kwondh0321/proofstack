import { createCipheriv, createHash } from "node:crypto";
import type { ArtifactMetadata } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  ArtifactCipher,
  type ArtifactRandomSource,
  artifactAuthenticatedData,
  LocalArtifactKeyring,
} from "./artifact-crypto.js";
import {
  ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES,
  type ArtifactKeyProvider,
  type WrappedArtifactDataKey,
} from "./artifact-ports.js";
import {
  ArtifactContentMismatchError,
  ArtifactKeyringConfigurationError,
  ArtifactProtectionError,
} from "./errors.js";

const plaintext = Buffer.from('{"answer":"safe"}', "utf8");

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function metadata(overrides: Partial<ArtifactMetadata> = {}): ArtifactMetadata {
  return {
    contentReference: {
      artifactId: "art_model_output",
      classification: "confidential",
      mediaType: "application/json",
      sha256: sha256(plaintext),
      sizeBytes: plaintext.byteLength,
    },
    createdAt: "2026-08-28T00:00:00.000Z",
    redaction: { status: "not_required" },
    retention: { expiresAt: "2026-09-28T00:00:00.000Z", mode: "expire" },
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_production",
      projectId: "prj_agent",
      tenantId: "ten_acme",
    },
    state: "reserved",
    ...overrides,
  };
}

function sequenceSource(): ArtifactRandomSource {
  let offset = 0;
  return (size) => {
    const value = Uint8Array.from({ length: size }, (_, index) => (offset + index) % 256);
    offset += size;
    return value;
  };
}

function key(byte: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => byte);
}

function encryptionPlan(dataKeyId = "key_test", nonce = Uint8Array.from({ length: 12 }, () => 5)) {
  return {
    contentNonce: Buffer.from(nonce).toString("base64url"),
    version: "a256gcm-v1" as const,
    wrappedDataKey: {
      algorithm: "A256GCM" as const,
      ciphertext: Buffer.alloc(32).toString("base64url"),
      keyId: dataKeyId,
      nonce: Buffer.alloc(12).toString("base64url"),
      tag: Buffer.alloc(16).toString("base64url"),
    },
  };
}

function keyring(
  options: {
    readonly activeKeyId?: string;
    readonly keyByte?: number;
    readonly keyId?: string;
    readonly randomSource?: ArtifactRandomSource;
  } = {},
): LocalArtifactKeyring {
  const keyId = options.keyId ?? "key_primary";
  return new LocalArtifactKeyring({
    activeKeyId: options.activeKeyId ?? keyId,
    keys: { [keyId]: key(options.keyByte ?? 7) },
    randomSource: options.randomSource ?? sequenceSource(),
  });
}

describe("ArtifactCipher", () => {
  it("round trips authenticated content without storing plaintext", async () => {
    const provider = keyring();
    const cipher = new ArtifactCipher(provider, sequenceSource());
    const value = metadata();
    const plan = await cipher.createPlan(value);
    const encrypted = await cipher.encrypt(value, plan, plaintext);

    expect(plan).toMatchObject({
      version: "a256gcm-v1",
      wrappedDataKey: { algorithm: "A256GCM", keyId: "key_primary" },
    });
    expect(encrypted.bytes.subarray(0, 4)).toEqual(Buffer.from("PSA1"));
    expect(Buffer.from(encrypted.bytes).includes(plaintext)).toBe(false);
    expect(encrypted.receipt).toEqual({
      sha256: sha256(encrypted.bytes),
      sizeBytes: plaintext.byteLength + ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES,
    });
    await expect(cipher.decrypt(value, plan, encrypted.bytes)).resolves.toEqual(
      Uint8Array.from(plaintext),
    );
    await expect(provider.activeKeyId()).resolves.toBe("key_primary");
  });

  it("produces identical ciphertext when retrying one stored plan", async () => {
    const cipher = new ArtifactCipher(keyring(), sequenceSource());
    const value = metadata();
    const plan = await cipher.createPlan(value);

    const first = await cipher.encrypt(value, plan, plaintext);
    const second = await cipher.encrypt(value, plan, plaintext);
    expect(second).toEqual(first);
  });

  it("binds ciphertext and wrapped keys to immutable tenant metadata", async () => {
    const cipher = new ArtifactCipher(keyring(), sequenceSource());
    const value = metadata();
    const plan = await cipher.createPlan(value);
    const encrypted = await cipher.encrypt(value, plan, plaintext);
    const moved = metadata({ scope: { ...value.scope, tenantId: "ten_other" } });

    await expect(cipher.decrypt(moved, plan, encrypted.bytes)).rejects.toBeInstanceOf(
      ArtifactProtectionError,
    );
  });

  it("binds applied redaction and retain policy into canonical authenticated data", () => {
    const value = metadata({
      contentReference: { ...metadata().contentReference, redactedAt: "source" },
      redaction: {
        records: [
          {
            changedPaths: ["/secret"],
            matchCount: 1,
            rulesetId: "redact_source",
            rulesetVersion: "1",
            stage: "source",
          },
        ],
        status: "applied",
      },
      retention: { mode: "retain" },
    });
    const decoded = JSON.parse(Buffer.from(artifactAuthenticatedData(value)).toString("utf8"));

    expect(decoded).toMatchObject({
      artifactId: "art_model_output",
      redaction: { records: [{ changedPaths: ["/secret"] }], status: "applied" },
      retention: { mode: "retain" },
      tenantId: "ten_acme",
      version: "proofstack-artifact-aad-v1",
    });
  });

  it.each([Uint8Array.from([0]), Uint8Array.from([...Buffer.from("BAD!"), ...new Uint8Array(17)])])(
    "rejects malformed encrypted objects %#",
    async (encrypted) => {
      const cipher = new ArtifactCipher(keyring(), sequenceSource());
      const value = metadata();
      const plan = await cipher.createPlan(value);
      await expect(cipher.decrypt(value, plan, encrypted)).rejects.toBeInstanceOf(
        ArtifactProtectionError,
      );
    },
  );

  it("rejects ciphertext and authentication-tag tampering", async () => {
    const cipher = new ArtifactCipher(keyring(), sequenceSource());
    const value = metadata();
    const plan = await cipher.createPlan(value);
    const encrypted = await cipher.encrypt(value, plan, plaintext);

    for (const index of [4, encrypted.bytes.length - 1]) {
      const tampered = Uint8Array.from(encrypted.bytes);
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      await expect(cipher.decrypt(value, plan, tampered)).rejects.toBeInstanceOf(
        ArtifactProtectionError,
      );
    }
  });

  it("rejects plaintext with a mismatched digest or length before encryption", async () => {
    const cipher = new ArtifactCipher(keyring(), sequenceSource());
    const wrongLength = metadata({
      contentReference: { ...metadata().contentReference, sizeBytes: plaintext.byteLength + 1 },
    });
    const wrongDigest = metadata({
      contentReference: { ...metadata().contentReference, sha256: "0".repeat(64) },
    });

    await expect(
      cipher.encrypt(wrongLength, await cipher.createPlan(wrongLength), plaintext),
    ).rejects.toBeInstanceOf(ArtifactContentMismatchError);
    await expect(
      cipher.encrypt(wrongDigest, await cipher.createPlan(wrongDigest), plaintext),
    ).rejects.toBeInstanceOf(ArtifactContentMismatchError);
  });

  it("normalizes invalid plans, providers, randomness, and metadata", async () => {
    const badProvider: ArtifactKeyProvider = {
      activeKeyId: async () => "key_bad",
      unwrapDataKey: async () => new Uint8Array(31),
      wrapDataKey: async () => {
        throw new Error("provider detail");
      },
    };
    const badRandom = new ArtifactCipher(keyring(), () => new Uint8Array(1));
    await expect(badRandom.createPlan(metadata())).rejects.toBeInstanceOf(ArtifactProtectionError);
    await expect(new ArtifactCipher(badProvider).createPlan(metadata())).rejects.toBeInstanceOf(
      ArtifactProtectionError,
    );
    expect(() =>
      artifactAuthenticatedData({ ...metadata(), state: "available" } as ArtifactMetadata),
    ).toThrow(ArtifactProtectionError);

    const cipher = new ArtifactCipher(keyring(), sequenceSource());
    const plan = await cipher.createPlan(metadata());
    const encrypted = await cipher.encrypt(metadata(), plan, plaintext);
    await expect(
      cipher.decrypt(
        metadata(),
        { ...plan, version: "bad" as typeof plan.version },
        encrypted.bytes,
      ),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);
    await expect(
      new ArtifactCipher(badProvider).encrypt(metadata(), plan, plaintext),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);

    const protectedProvider: ArtifactKeyProvider = {
      ...badProvider,
      wrapDataKey: async () => {
        throw new ArtifactProtectionError();
      },
    };
    await expect(
      new ArtifactCipher(protectedProvider).createPlan(metadata()),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);

    const throwingProvider: ArtifactKeyProvider = {
      ...badProvider,
      unwrapDataKey: async () => {
        throw new Error("provider detail");
      },
    };
    await expect(
      new ArtifactCipher(throwingProvider).encrypt(metadata(), plan, plaintext),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);
  });

  it("verifies the decrypted digest after successful authentication", async () => {
    const declared = metadata({
      contentReference: { ...metadata().contentReference, sha256: "0".repeat(64) },
    });
    const dataKey = key(3);
    const plan = encryptionPlan();
    const nonce = Buffer.from(plan.contentNonce, "base64url");
    const authenticatedData = artifactAuthenticatedData(declared);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    cipher.setAAD(authenticatedData, { plaintextLength: plaintext.byteLength });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const encrypted = Buffer.concat([Buffer.from("PSA1"), cipher.getAuthTag(), ciphertext]);
    const provider: ArtifactKeyProvider = {
      activeKeyId: async () => "key_test",
      unwrapDataKey: async () => dataKey,
      wrapDataKey: async () => plan.wrappedDataKey,
    };

    await expect(
      new ArtifactCipher(provider).decrypt(declared, plan, encrypted),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);
  });
});

describe("LocalArtifactKeyring", () => {
  it("keeps older key versions readable after active-key rotation", async () => {
    const source = sequenceSource();
    const old = new LocalArtifactKeyring({
      activeKeyId: "key_old",
      keys: { key_old: key(1) },
      randomSource: source,
    });
    const cipher = new ArtifactCipher(old, source);
    const plan = await cipher.createPlan(metadata());
    const encrypted = await cipher.encrypt(metadata(), plan, plaintext);
    const rotated = new LocalArtifactKeyring({
      activeKeyId: "key_new",
      keys: { key_new: key(2), key_old: key(1) },
      randomSource: sequenceSource(),
    });

    await expect(
      new ArtifactCipher(rotated).decrypt(metadata(), plan, encrypted.bytes),
    ).resolves.toEqual(Uint8Array.from(plaintext));
    await expect(rotated.activeKeyId()).resolves.toBe("key_new");
  });

  it.each([
    { activeKeyId: "bad-id", keys: { key_valid: key(1) } },
    { activeKeyId: "key_missing", keys: { key_valid: key(1) } },
    { activeKeyId: "key_valid", keys: {} },
    {
      activeKeyId: "key_0",
      keys: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`key_${index}`, key(index)]),
      ),
    },
    { activeKeyId: "key_valid", keys: { "bad-id": key(1), key_valid: key(2) } },
    { activeKeyId: "key_valid", keys: { key_valid: new Uint8Array(31) } },
    { activeKeyId: "key_one", keys: { key_one: key(1), key_two: key(1) } },
  ])("rejects invalid keyring configuration %#", (options) => {
    expect(() => new LocalArtifactKeyring(options)).toThrow(ArtifactKeyringConfigurationError);
  });

  it("rejects wrong data-key sizes and unknown or corrupt wrapped keys", async () => {
    const provider = keyring();
    const context = {
      artifactId: "art_model_output",
      authenticatedData: artifactAuthenticatedData(metadata()),
      tenantId: "ten_acme",
    };
    await expect(provider.wrapDataKey(new Uint8Array(31), context)).rejects.toBeInstanceOf(
      ArtifactProtectionError,
    );
    const wrapped = await provider.wrapDataKey(key(9), context);
    const values: WrappedArtifactDataKey[] = [
      { ...wrapped, algorithm: "bad" as "A256GCM" },
      { ...wrapped, keyId: "key_missing" },
      { ...wrapped, nonce: "bad*" },
      { ...wrapped, tag: wrapped.tag.slice(1) },
      { ...wrapped, ciphertext: wrapped.ciphertext.slice(1) },
    ];
    for (const value of values) {
      await expect(provider.unwrapDataKey(value, context)).rejects.toBeInstanceOf(
        ArtifactProtectionError,
      );
    }
    await expect(
      provider.unwrapDataKey(wrapped, { ...context, authenticatedData: new Uint8Array() }),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);
  });

  it("normalizes random-source and cryptographic authentication failures", async () => {
    const throwingSource = keyring({
      randomSource: () => {
        throw new Error("random detail");
      },
    });
    const context = {
      artifactId: "art_model_output",
      authenticatedData: artifactAuthenticatedData(metadata()),
      tenantId: "ten_acme",
    };
    await expect(throwingSource.wrapDataKey(key(9), context)).rejects.toBeInstanceOf(
      ArtifactProtectionError,
    );

    const provider = keyring();
    const wrapped = await provider.wrapDataKey(key(9), context);
    const replacement = wrapped.tag.endsWith("A") ? "B" : "A";
    await expect(
      provider.unwrapDataKey(
        { ...wrapped, tag: `${wrapped.tag.slice(0, -1)}${replacement}` },
        context,
      ),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);
  });

  it("normalizes invalid and unexpected wrapping contexts", async () => {
    const provider = keyring();
    const authenticatedData = artifactAuthenticatedData(metadata());
    await expect(
      provider.wrapDataKey(key(9), {
        artifactId: "art_model_output",
        authenticatedData,
        tenantId: "bad-id",
      }),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);

    const throwingData = new Proxy(authenticatedData, {});
    await expect(
      provider.wrapDataKey(key(9), {
        artifactId: "art_model_output",
        authenticatedData: throwingData,
        tenantId: "ten_acme",
      }),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);
  });

  it("supports the secure default random source", async () => {
    const provider = new LocalArtifactKeyring({
      activeKeyId: "key_primary",
      keys: { key_primary: key(7) },
    });
    expect(await provider.activeKeyId()).toBe("key_primary");
  });
});
