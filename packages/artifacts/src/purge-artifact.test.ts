import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactPurgeReceipt,
} from "./artifact-ports.js";
import type { PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import {
  ArtifactNotFoundError,
  ArtifactStateTransitionError,
  InvalidArtifactLifecycleInputError,
} from "./errors.js";
import { PurgeArtifact } from "./purge-artifact.js";
import { MemoryArtifactCatalogRepository, MemoryArtifactObjectStore } from "./testing/index.js";

const scope = {
  environmentId: "env_production",
  projectId: "prj_agent",
  tenantId: "ten_acme",
};

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-08-28T02:00:00.000Z",
      credentialId: "ses_owner",
      method: "oidc",
    },
    capabilities: ["artifact:delete"],
    principalId: "usr_owner",
    principalType: "user",
    requestId: "req_purge_artifact",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_acme",
    ...overrides,
  };
}

function entry(): ArtifactCatalogEntry {
  return {
    createdByPrincipalId: "wrk_writer",
    encryption: {
      contentNonce: "AAAAAAAAAAAAAAAA",
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        keyId: "key_primary",
        nonce: "AAAAAAAAAAAAAAAA",
        tag: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
    metadata: {
      contentReference: {
        artifactId: "art_model_output",
        classification: "confidential",
        mediaType: "application/json",
        sha256: "1".repeat(64),
        sizeBytes: 18,
      },
      createdAt: "2026-08-28T03:00:00.000Z",
      redaction: { status: "not_required" },
      retention: { expiresAt: "2026-09-28T03:00:00.000Z", mode: "expire" },
      schemaVersion: "0.1",
      scope,
      state: "reserved",
    },
    objectKey: "objects/v1/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

class RecordingCatalog extends MemoryArtifactCatalogRepository {
  receipts: ArtifactPurgeReceipt[] = [];
  failNextReceipt = false;

  override async recordPurge(...parameters: Parameters<ArtifactCatalogRepository["recordPurge"]>) {
    if (this.failNextReceipt) {
      this.failNextReceipt = false;
      throw new Error("database unavailable");
    }
    this.receipts.push(parameters[1]);
    return super.recordPurge(...parameters);
  }
}

class FailingObjectStore extends MemoryArtifactObjectStore {
  override async delete(): Promise<{ readonly deleted: boolean }> {
    throw new Error("object store unavailable");
  }
}

async function harness(
  options: { readonly clock?: Date; readonly objects?: MemoryArtifactObjectStore } = {},
) {
  const catalog = new RecordingCatalog();
  const objects = options.objects ?? new MemoryArtifactObjectStore();
  const candidate = entry();
  await catalog.reserve(candidate);
  let idCalls = 0;
  const purge = new PurgeArtifact({
    catalog,
    clock: { now: () => new Date(options.clock ?? "2026-08-28T03:03:00.000Z") },
    identities: {
      generateLifecycleId: () => {
        idCalls += 1;
        return `pur_generated_${idCalls}`;
      },
      generateObjectKey: () => "objects/unused",
    },
    objects,
  });
  return { catalog, entry: candidate, idCalls: () => idCalls, objects, purge };
}

async function tombstone(value: Awaited<ReturnType<typeof harness>>, withObject = true) {
  await value.catalog.activate(
    scope,
    "art_model_output",
    { sha256: "2".repeat(64), sizeBytes: 38 },
    "2026-08-28T03:01:00.000Z",
  );
  if (withObject) {
    await value.objects.putIfAbsent(value.entry.objectKey, Uint8Array.from([1, 2, 3]));
  }
  await value.catalog.tombstone(scope, {
    actorPrincipalId: "usr_owner",
    artifactId: "art_model_output",
    occurredAt: "2026-08-28T03:02:00.000Z",
    reason: "User-requested removal",
    tombstoneId: "del_model_output",
    trigger: "manual",
  });
}

function command(overrides: Partial<Parameters<PurgeArtifact["execute"]>[0]> = {}) {
  return {
    artifactId: "art_model_output",
    environmentId: "env_production",
    principal: principal(),
    projectId: "prj_agent",
    ...overrides,
  };
}

describe("PurgeArtifact", () => {
  it("deletes only tombstoned content and records an attributed purge receipt", async () => {
    const value = await harness();
    await tombstone(value);

    const result = await value.purge.execute(command());
    expect(result).toEqual({
      metadata: expect.objectContaining({
        purgedAt: "2026-08-28T03:03:00.000Z",
        state: "purged",
      }),
    });
    await expect(value.objects.get(value.entry.objectKey)).resolves.toBeNull();
    expect(value.catalog.receipts).toEqual([
      {
        artifactId: "art_model_output",
        objectWasPresent: true,
        occurredAt: "2026-08-28T03:03:00.000Z",
        purgeId: "pur_generated_1",
      },
    ]);
  });

  it("records successful purge when an abandoned object is already absent", async () => {
    const value = await harness();
    await tombstone(value, false);
    await value.purge.execute(command());
    expect(value.catalog.receipts[0]?.objectWasPresent).toBe(false);
  });

  it("leaves deletion pending when object storage is unavailable", async () => {
    const value = await harness({ objects: new FailingObjectStore() });
    await tombstone(value, false);
    await expect(value.purge.execute(command())).rejects.toThrow("object store unavailable");
    expect((await value.catalog.find(scope, "art_model_output"))?.metadata.state).toBe(
      "tombstoned",
    );
    expect(value.catalog.receipts).toHaveLength(0);
  });

  it("repairs a database interruption after object deletion", async () => {
    const value = await harness();
    await tombstone(value);
    value.catalog.failNextReceipt = true;

    await expect(value.purge.execute(command())).rejects.toThrow("database unavailable");
    await expect(value.objects.get(value.entry.objectKey)).resolves.toBeNull();
    expect((await value.catalog.find(scope, "art_model_output"))?.metadata.state).toBe(
      "tombstoned",
    );

    await expect(value.purge.execute(command())).resolves.toMatchObject({
      metadata: { state: "purged" },
    });
    expect(value.catalog.receipts[0]?.objectWasPresent).toBe(false);
  });

  it("does not touch object storage again after purge completion", async () => {
    const value = await harness();
    await tombstone(value);
    const first = await value.purge.execute(command());
    const idCalls = value.idCalls();
    const retry = await value.purge.execute(command());

    expect(retry).toEqual(first);
    expect(value.idCalls()).toBe(idCalls);
    expect(value.catalog.receipts).toHaveLength(1);
  });

  it("rejects missing or non-tombstoned catalog entries before deletion", async () => {
    const value = await harness();
    await expect(value.purge.execute(command())).rejects.toBeInstanceOf(
      ArtifactStateTransitionError,
    );
    await expect(
      value.purge.execute(command({ artifactId: "art_missing" })),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it.each([
    command({ principal: principal({ capabilities: [] }) }),
    command({ artifactId: "bad-id" }),
    command({ environmentId: "bad-id" }),
  ])("rejects unauthorized or invalid purge input %#", async (invalidCommand) => {
    const value = await harness();
    await expect(value.purge.execute(invalidCommand)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForbiddenError || error instanceof InvalidArtifactLifecycleInputError,
    );
  });

  it("leaves the tombstone durable when the post-delete clock is invalid", async () => {
    const value = await harness({ clock: new Date(Number.NaN) });
    await tombstone(value);
    await expect(value.purge.execute(command())).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
    await expect(value.objects.get(value.entry.objectKey)).resolves.toBeNull();
    expect((await value.catalog.find(scope, "art_model_output"))?.metadata.state).toBe(
      "tombstoned",
    );
  });
});
