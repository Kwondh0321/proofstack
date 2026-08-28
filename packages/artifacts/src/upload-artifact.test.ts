import { createHash } from "node:crypto";
import type { ArtifactCatalogEntry, ArtifactCatalogRepository } from "./artifact-ports.js";
import type { PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import { ArtifactCipher, LocalArtifactKeyring } from "./artifact-crypto.js";
import {
  ArtifactContentMismatchError,
  ArtifactNotFoundError,
  ArtifactObjectConflictError,
  ArtifactStateTransitionError,
  InvalidArtifactLifecycleInputError,
} from "./errors.js";
import { MemoryArtifactCatalogRepository, MemoryArtifactObjectStore } from "./testing/index.js";
import { UploadArtifact } from "./upload-artifact.js";

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
      credentialId: "key_writer",
      method: "api_key",
    },
    capabilities: ["artifact:write"],
    principalId: "wrk_writer",
    principalType: "workload",
    requestId: "req_upload_artifact",
    resourceScope: { mode: "tenant" },
    roles: ["ingest"],
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

async function reservedEntry(
  cipher: ArtifactCipher,
  overrides: Partial<ArtifactCatalogEntry> = {},
): Promise<ArtifactCatalogEntry> {
  const metadata = {
    contentReference: {
      artifactId: "art_model_output",
      classification: "confidential" as const,
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
    ...overrides,
  };
}

class FailingActivationCatalog extends MemoryArtifactCatalogRepository {
  failNextActivation = true;

  override async activate(...parameters: Parameters<ArtifactCatalogRepository["activate"]>) {
    if (this.failNextActivation) {
      this.failNextActivation = false;
      throw new Error("database unavailable");
    }
    return super.activate(...parameters);
  }
}

async function harness(
  options: {
    readonly catalog?: MemoryArtifactCatalogRepository;
    readonly clock?: Date;
    readonly objects?: MemoryArtifactObjectStore;
  } = {},
) {
  const catalog = options.catalog ?? new MemoryArtifactCatalogRepository();
  const objects = options.objects ?? new MemoryArtifactObjectStore();
  const cipher = new ArtifactCipher(keyring(), (size) =>
    Uint8Array.from({ length: size }, (_, index) => index + 32),
  );
  const entry = await reservedEntry(cipher);
  await catalog.reserve(entry);
  const upload = new UploadArtifact({
    catalog,
    clock: { now: () => new Date(options.clock ?? "2026-08-28T03:01:00.000Z") },
    encryption: cipher,
    objects,
  });
  return { catalog, cipher, entry, objects, upload };
}

function command(overrides: Partial<Parameters<UploadArtifact["execute"]>[0]> = {}) {
  return {
    artifactId: "art_model_output",
    content,
    environmentId: "env_production",
    principal: principal(),
    projectId: "prj_agent",
    ...overrides,
  };
}

describe("UploadArtifact", () => {
  it("stores ciphertext and activates metadata only after an exact object receipt", async () => {
    const value = await harness();
    const result = await value.upload.execute(command());
    const encrypted = await value.objects.get(value.entry.objectKey);

    expect(result).toEqual({
      metadata: expect.objectContaining({
        availableAt: "2026-08-28T03:01:00.000Z",
        state: "available",
      }),
    });
    expect(encrypted).not.toBeNull();
    expect(encrypted).not.toEqual(Uint8Array.from(content));
    await expect(
      value.cipher.decrypt(value.entry.metadata, value.entry.encryption, encrypted as Uint8Array),
    ).resolves.toEqual(Uint8Array.from(content));
  });

  it("repairs interruption between immutable object creation and catalog activation", async () => {
    const catalog = new FailingActivationCatalog();
    const value = await harness({ catalog });

    await expect(value.upload.execute(command())).rejects.toThrow("database unavailable");
    expect((await catalog.find(scope, "art_model_output"))?.metadata.state).toBe("reserved");
    const firstObject = await value.objects.get(value.entry.objectKey);
    expect(firstObject).not.toBeNull();

    await expect(value.upload.execute(command())).resolves.toMatchObject({
      metadata: { state: "available" },
    });
    expect(await value.objects.get(value.entry.objectKey)).toEqual(firstObject);
  });

  it("keeps an identical retry available without replacing ciphertext", async () => {
    const value = await harness();
    const first = await value.upload.execute(command());
    const encrypted = await value.objects.get(value.entry.objectKey);
    const retry = await value.upload.execute(command());

    expect(retry).toEqual(first);
    expect(await value.objects.get(value.entry.objectKey)).toEqual(encrypted);
  });

  it.each([Buffer.from("short"), Buffer.from('{"answer":"evil"}', "utf8")])(
    "rejects content that does not match the reservation %#",
    async (invalidContent) => {
      const value = await harness();
      await expect(
        value.upload.execute(command({ content: invalidContent })),
      ).rejects.toBeInstanceOf(ArtifactContentMismatchError);
      await expect(value.objects.get(value.entry.objectKey)).resolves.toBeNull();
    },
  );

  it("detects an immutable object-key collision and leaves the reservation repairable", async () => {
    const objects = new MemoryArtifactObjectStore();
    const value = await harness({ objects });
    await objects.putIfAbsent(value.entry.objectKey, Uint8Array.from([1, 2, 3]));

    await expect(value.upload.execute(command())).rejects.toBeInstanceOf(
      ArtifactObjectConflictError,
    );
    expect((await value.catalog.find(scope, "art_model_output"))?.metadata.state).toBe("reserved");
  });

  it("rejects missing and non-readable lifecycle states before object access", async () => {
    const value = await harness();
    await expect(
      value.upload.execute(command({ artifactId: "art_missing" })),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await value.catalog.tombstone(scope, {
      actorPrincipalId: "usr_maintainer",
      artifactId: "art_model_output",
      occurredAt: "2026-08-28T03:02:00.000Z",
      reason: "Abandoned upload",
      tombstoneId: "del_model_output",
      trigger: "abandoned",
    });
    await expect(value.upload.execute(command())).rejects.toBeInstanceOf(
      ArtifactStateTransitionError,
    );
    await expect(value.objects.get(value.entry.objectKey)).resolves.toBeNull();
  });

  it.each([
    command({ principal: principal({ capabilities: [] }) }),
    command({ content: {} as Uint8Array }),
    command({ artifactId: "bad-id" }),
    command({ environmentId: "bad-id" }),
  ])("rejects unauthorized or invalid upload input %#", async (invalidCommand) => {
    const value = await harness();
    await expect(value.upload.execute(invalidCommand)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForbiddenError || error instanceof InvalidArtifactLifecycleInputError,
    );
    await expect(value.objects.get(value.entry.objectKey)).resolves.toBeNull();
  });

  it("keeps a created object reserved when the activation clock is invalid", async () => {
    const value = await harness({ clock: new Date(Number.NaN) });
    await expect(value.upload.execute(command())).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
    expect(await value.objects.get(value.entry.objectKey)).not.toBeNull();
    expect((await value.catalog.find(scope, "art_model_output"))?.metadata.state).toBe("reserved");
  });
});
