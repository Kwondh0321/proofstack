import { createHash } from "node:crypto";
import type { ArtifactCatalogEntry } from "./artifact-ports.js";
import type { PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import { ArtifactCipher, LocalArtifactKeyring } from "./artifact-crypto.js";
import {
  ArtifactNotFoundError,
  ArtifactObjectMissingError,
  ArtifactProtectionError,
  ArtifactUnavailableError,
  InvalidArtifactLifecycleInputError,
} from "./errors.js";
import { ReadArtifact } from "./read-artifact.js";
import { MemoryArtifactCatalogRepository, MemoryArtifactObjectStore } from "./testing/index.js";

const content = Buffer.from('{"answer":"safe"}', "utf8");
const scope = {
  environmentId: "env_production",
  projectId: "prj_agent",
  tenantId: "ten_acme",
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-08-28T02:00:00.000Z",
      credentialId: "key_reader",
      method: "api_key",
    },
    capabilities: ["artifact:read"],
    principalId: "wrk_reader",
    principalType: "workload",
    requestId: "req_read_artifact",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: "ten_acme",
    ...overrides,
  };
}

function keyring() {
  return new LocalArtifactKeyring({
    activeKeyId: "key_primary",
    keys: { key_primary: Uint8Array.from({ length: 32 }, () => 7) },
    randomSource: (size) => Uint8Array.from({ length: size }, (_, index) => index),
  });
}

async function entry(
  cipher: ArtifactCipher,
  classification: ArtifactCatalogEntry["metadata"]["contentReference"]["classification"] = "confidential",
): Promise<ArtifactCatalogEntry> {
  const metadata = {
    contentReference: {
      artifactId: "art_model_output",
      classification,
      mediaType: "application/json",
      sha256: sha256(content),
      sizeBytes: content.byteLength,
    },
    createdAt: "2026-08-28T03:00:00.000Z",
    redaction: { status: "not_required" as const },
    retention: { expiresAt: "2026-09-28T03:00:00.000Z", mode: "expire" as const },
    schemaVersion: "0.1" as const,
    scope,
    state: "reserved" as const,
  };
  return {
    createdByPrincipalId: "wrk_writer",
    encryption: await cipher.createPlan(metadata),
    metadata,
    objectKey: "objects/v1/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

async function harness(options: { readonly classification?: "confidential" | "restricted" } = {}) {
  const catalog = new MemoryArtifactCatalogRepository();
  const objects = new MemoryArtifactObjectStore();
  const cipher = new ArtifactCipher(keyring(), (size) =>
    Uint8Array.from({ length: size }, (_, index) => index + 32),
  );
  const value = await entry(cipher, options.classification);
  await catalog.reserve(value);
  const encrypted = await cipher.encrypt(value.metadata, value.encryption, content);
  await objects.putIfAbsent(value.objectKey, encrypted.bytes);
  const read = new ReadArtifact({ catalog, encryption: cipher, objects });
  return { catalog, cipher, encrypted, entry: value, objects, read };
}

async function activate(value: Awaited<ReturnType<typeof harness>>) {
  await value.catalog.activate(
    scope,
    "art_model_output",
    value.encrypted.receipt,
    "2026-08-28T03:01:00.000Z",
  );
}

function command(overrides: Partial<Parameters<ReadArtifact["execute"]>[0]> = {}) {
  return {
    artifactId: "art_model_output",
    environmentId: "env_production",
    principal: principal(),
    projectId: "prj_agent",
    ...overrides,
  };
}

describe("ReadArtifact", () => {
  it("verifies ciphertext and returns only decrypted content with public metadata", async () => {
    const value = await harness();
    await activate(value);

    const result = await value.read.execute(command());
    expect(result).toEqual({
      content: Uint8Array.from(content),
      metadata: expect.objectContaining({ state: "available" }),
    });
    expect(Object.keys(result)).toEqual(["content", "metadata"]);
  });

  it("requires the non-delegable restricted-content capability", async () => {
    const value = await harness({ classification: "restricted" });
    await activate(value);
    await expect(value.read.execute(command())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      value.read.execute(
        command({
          principal: principal({ capabilities: ["artifact:read", "artifact:read:restricted"] }),
        }),
      ),
    ).resolves.toMatchObject({ content: Uint8Array.from(content) });
  });

  it("blocks non-available states before reading object storage", async () => {
    const value = await harness();
    await value.objects.delete(value.entry.objectKey);
    await expect(value.read.execute(command())).rejects.toBeInstanceOf(ArtifactUnavailableError);
  });

  it("reports a missing object separately from cryptographic corruption", async () => {
    const value = await harness();
    await activate(value);
    await value.objects.delete(value.entry.objectKey);
    await expect(value.read.execute(command())).rejects.toBeInstanceOf(ArtifactObjectMissingError);
  });

  it("rejects ciphertext whose receipt differs from the activated catalog", async () => {
    const value = await harness();
    await activate(value);
    await value.objects.delete(value.entry.objectKey);
    await value.objects.putIfAbsent(value.entry.objectKey, Uint8Array.from([1, 2, 3]));
    await expect(value.read.execute(command())).rejects.toBeInstanceOf(ArtifactProtectionError);
  });

  it("rejects available metadata without an activation receipt", async () => {
    const value = await harness();
    const catalog = new Proxy(value.catalog, {
      get(target, property) {
        if (property === "find") {
          return async () => ({
            ...value.entry,
            metadata: {
              ...value.entry.metadata,
              availableAt: "2026-08-28T03:01:00.000Z",
              state: "available" as const,
            },
          });
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const read = new ReadArtifact({ catalog, encryption: value.cipher, objects: value.objects });
    await expect(read.execute(command())).rejects.toBeInstanceOf(ArtifactProtectionError);
  });

  it("isolates missing and invalid reads without exposing storage details", async () => {
    const value = await harness();
    await expect(value.read.execute(command({ artifactId: "art_missing" }))).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    await expect(
      value.read.execute(command({ principal: principal({ capabilities: [] }) })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(value.read.execute(command({ artifactId: "bad-id" }))).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
    await expect(value.read.execute(command({ environmentId: "bad-id" }))).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
  });
});
