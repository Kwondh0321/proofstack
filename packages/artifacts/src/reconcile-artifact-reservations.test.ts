import { createHash } from "node:crypto";
import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactObjectReceipt,
} from "./artifact-ports.js";
import type { PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import { ArtifactCipher, LocalArtifactKeyring } from "./artifact-crypto.js";
import { InvalidArtifactLifecycleInputError } from "./errors.js";
import { ReconcileArtifactReservations } from "./reconcile-artifact-reservations.js";
import { MemoryArtifactCatalogRepository, MemoryArtifactObjectStore } from "./testing/index.js";

const content = Buffer.from('{"answer":"recoverable"}', "utf8");
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
      credentialId: "svc_maintenance",
      method: "service_token",
    },
    capabilities: ["artifact:delete"],
    principalId: "svc_maintenance",
    principalType: "service",
    requestId: "req_reconcile_artifacts",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: "ten_acme",
    ...overrides,
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    abandonedBefore: "2026-09-01T00:00:00.000Z",
    environmentId: "env_production",
    limit: 100,
    principal: principal(),
    projectId: "prj_agent",
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
  artifactId: string,
  createdAt = "2026-08-28T03:00:00.000Z",
): Promise<ArtifactCatalogEntry> {
  const metadata = {
    contentReference: {
      artifactId,
      classification: "confidential" as const,
      mediaType: "application/json",
      sha256: sha256(content),
      sizeBytes: content.byteLength,
    },
    createdAt,
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
    objectKey: `objects/v1/aa/${artifactId}`,
  };
}

class ConcurrentActivationCatalog extends MemoryArtifactCatalogRepository {
  concurrentActivation:
    | { readonly entry: ArtifactCatalogEntry; readonly receipt: ArtifactObjectReceipt }
    | undefined;

  override async listAbandoned(
    ...parameters: Parameters<ArtifactCatalogRepository["listAbandoned"]>
  ) {
    const candidates = await super.listAbandoned(...parameters);
    const concurrent = this.concurrentActivation;
    if (concurrent) {
      this.concurrentActivation = undefined;
      await super.activate(
        concurrent.entry.metadata.scope,
        concurrent.entry.metadata.contentReference.artifactId,
        concurrent.receipt,
        "2026-09-02T00:00:00.000Z",
      );
    }
    return candidates;
  }
}

class FailingActivationCatalog extends MemoryArtifactCatalogRepository {
  failingArtifactId: string | undefined;

  override async activate(...parameters: Parameters<ArtifactCatalogRepository["activate"]>) {
    if (parameters[1] === this.failingArtifactId) {
      this.failingArtifactId = undefined;
      throw new Error("database unavailable");
    }
    return super.activate(...parameters);
  }
}

async function harness(
  options: { readonly catalog?: MemoryArtifactCatalogRepository; readonly clock?: Date } = {},
) {
  const catalog = options.catalog ?? new MemoryArtifactCatalogRepository();
  const objects = new MemoryArtifactObjectStore();
  const cipher = new ArtifactCipher(keyring(), (size) =>
    Uint8Array.from({ length: size }, (_, index) => index + 32),
  );
  const reconciliation = new ReconcileArtifactReservations({
    catalog,
    clock: { now: () => new Date(options.clock ?? "2026-09-02T00:00:00.000Z") },
    encryption: cipher,
    objects,
  });
  return { catalog, cipher, objects, reconciliation };
}

describe("ReconcileArtifactReservations", () => {
  it("activates only cryptographically verified stale objects and continues past damage", async () => {
    const value = await harness();
    const recoverable = await reservedEntry(value.cipher, "art_recoverable");
    const missing = await reservedEntry(value.cipher, "art_missing_object");
    const damaged = await reservedEntry(value.cipher, "art_damaged");
    const recent = await reservedEntry(value.cipher, "art_recent", "2026-09-01T12:00:00.000Z");
    for (const entry of [recoverable, missing, damaged, recent]) {
      await value.catalog.reserve(entry);
    }
    const recoverableObject = await value.cipher.encrypt(
      recoverable.metadata,
      recoverable.encryption,
      content,
    );
    const damagedObject = await value.cipher.encrypt(damaged.metadata, damaged.encryption, content);
    const finalByteIndex = damagedObject.bytes.length - 1;
    damagedObject.bytes[finalByteIndex] = (damagedObject.bytes[finalByteIndex] ?? 0) ^ 1;
    await value.objects.putIfAbsent(recoverable.objectKey, recoverableObject.bytes);
    await value.objects.putIfAbsent(damaged.objectKey, damagedObject.bytes);

    await expect(value.reconciliation.execute(command())).resolves.toEqual({
      activated: 1,
      failedArtifactIds: ["art_damaged"],
      inspected: 3,
      missingObjects: 1,
    });
    expect((await value.catalog.find(scope, "art_recoverable"))?.metadata).toMatchObject({
      availableAt: "2026-09-02T00:00:00.000Z",
      state: "available",
    });
    expect((await value.catalog.find(scope, "art_missing_object"))?.metadata.state).toBe(
      "reserved",
    );
    expect((await value.catalog.find(scope, "art_damaged"))?.metadata.state).toBe("reserved");
    expect((await value.catalog.find(scope, "art_recent"))?.metadata.state).toBe("reserved");
  });

  it("continues after one catalog activation fails and leaves it repairable", async () => {
    const catalog = new FailingActivationCatalog();
    const value = await harness({ catalog });
    const failed = await reservedEntry(value.cipher, "art_activation_a");
    const recovered = await reservedEntry(value.cipher, "art_activation_b");
    for (const entry of [failed, recovered]) {
      await catalog.reserve(entry);
      const encrypted = await value.cipher.encrypt(entry.metadata, entry.encryption, content);
      await value.objects.putIfAbsent(entry.objectKey, encrypted.bytes);
    }
    catalog.failingArtifactId = "art_activation_a";

    await expect(value.reconciliation.execute(command())).resolves.toEqual({
      activated: 1,
      failedArtifactIds: ["art_activation_a"],
      inspected: 2,
      missingObjects: 0,
    });
    expect((await catalog.find(scope, "art_activation_a"))?.metadata.state).toBe("reserved");
    expect((await catalog.find(scope, "art_activation_b"))?.metadata.state).toBe("available");
  });

  it("converges when another worker activates the same immutable object", async () => {
    const catalog = new ConcurrentActivationCatalog();
    const objects = new MemoryArtifactObjectStore();
    const cipher = new ArtifactCipher(keyring(), (size) =>
      Uint8Array.from({ length: size }, (_, index) => index + 64),
    );
    const entry = await reservedEntry(cipher, "art_concurrent");
    const encrypted = await cipher.encrypt(entry.metadata, entry.encryption, content);
    await catalog.reserve(entry);
    await objects.putIfAbsent(entry.objectKey, encrypted.bytes);
    catalog.concurrentActivation = { entry, receipt: encrypted.receipt };
    const reconciliation = new ReconcileArtifactReservations({
      catalog,
      clock: { now: () => new Date("2026-09-02T00:00:00.000Z") },
      encryption: cipher,
      objects,
    });

    await expect(reconciliation.execute(command())).resolves.toEqual({
      activated: 1,
      failedArtifactIds: [],
      inspected: 1,
      missingObjects: 0,
    });
  });

  it.each(["invalid", "2026-09-01T23:30:00.000Z"])(
    "rejects an unsafe reconciliation threshold %s",
    async (abandonedBefore) => {
      const value = await harness();
      await expect(
        value.reconciliation.execute(command({ abandonedBefore })),
      ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
    },
  );

  it("normalizes an invalid reconciliation clock", async () => {
    const value = await harness({ clock: new Date(Number.NaN) });
    await expect(value.reconciliation.execute(command())).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
  });

  it.each([
    command({ principal: principal({ capabilities: [] }) }),
    command({ environmentId: "bad-id" }),
  ])("rejects unauthorized or invalid scopes %#", async (invalidCommand) => {
    const value = await harness();
    await expect(value.reconciliation.execute(invalidCommand)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForbiddenError || error instanceof InvalidArtifactLifecycleInputError,
    );
  });
});
