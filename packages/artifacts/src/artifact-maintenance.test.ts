import type { ArtifactCatalogEntry, ArtifactCatalogRepository } from "./artifact-ports.js";
import type { ArtifactTombstone, PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import {
  ProcessAbandonedReservations,
  ProcessArtifactRetention,
  RetryArtifactPurges,
} from "./artifact-maintenance.js";
import { InvalidArtifactLifecycleInputError } from "./errors.js";
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
      credentialId: "svc_retention",
      method: "service_token",
    },
    capabilities: ["artifact:delete"],
    principalId: "svc_retention",
    principalType: "service",
    requestId: "req_artifact_maintenance",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: "ten_acme",
    ...overrides,
  };
}

function entry(
  artifactId: string,
  options: {
    readonly expiresAt?: string;
    readonly retention?: "expire" | "retain";
  } = {},
): ArtifactCatalogEntry {
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
        artifactId,
        classification: "confidential",
        mediaType: "application/json",
        sha256: "1".repeat(64),
        sizeBytes: 18,
      },
      createdAt: "2026-08-28T03:00:00.000Z",
      redaction: { status: "not_required" },
      retention:
        options.retention === "retain"
          ? { mode: "retain" }
          : {
              expiresAt: options.expiresAt ?? "2026-09-01T00:00:00.000Z",
              mode: "expire",
            },
      schemaVersion: "0.1",
      scope,
      state: "reserved",
    },
    objectKey: `objects/v1/aa/${artifactId}`,
  };
}

class RecordingCatalog extends MemoryArtifactCatalogRepository {
  concurrentTombstone = false;
  tombstones: ArtifactTombstone[] = [];

  override async listExpired(...parameters: Parameters<ArtifactCatalogRepository["listExpired"]>) {
    const entries = await super.listExpired(...parameters);
    const first = entries[0];
    if (this.concurrentTombstone && first) {
      this.concurrentTombstone = false;
      await super.tombstone(parameters[0], {
        actorPrincipalId: "svc_retention",
        artifactId: first.metadata.contentReference.artifactId,
        occurredAt: parameters[1],
        reason: "Configured artifact retention period expired",
        tombstoneId: "del_concurrent",
        trigger: "retention",
      });
    }
    return entries;
  }

  override async tombstone(...parameters: Parameters<ArtifactCatalogRepository["tombstone"]>) {
    const result = await super.tombstone(...parameters);
    if (result.created) this.tombstones.push(result.tombstone);
    return result;
  }
}

class FailOnceObjectStore extends MemoryArtifactObjectStore {
  failingKey: string | undefined;

  override async delete(objectKey: string) {
    if (objectKey === this.failingKey) {
      this.failingKey = undefined;
      throw new Error("object store unavailable");
    }
    return super.delete(objectKey);
  }
}

async function harness(options: { readonly clock?: Date } = {}) {
  const catalog = new RecordingCatalog();
  const objects = new FailOnceObjectStore();
  let id = 0;
  const identities = {
    generateLifecycleId: (kind: "purge" | "tombstone") => {
      id += 1;
      return `${kind === "tombstone" ? "del" : "pur"}_maintenance_${id}`;
    },
    generateObjectKey: () => "objects/unused",
  };
  const clock = { now: () => new Date(options.clock ?? "2026-09-02T00:00:00.000Z") };
  const purge = new PurgeArtifact({ catalog, clock, identities, objects });
  const abandoned = new ProcessAbandonedReservations({ catalog, clock, identities, purge });
  const retention = new ProcessArtifactRetention({ catalog, clock, identities, purge });
  const retryPurges = new RetryArtifactPurges({ catalog, purge });
  return { abandoned, catalog, objects, retention, retryPurges };
}

async function makeAvailable(
  value: Awaited<ReturnType<typeof harness>>,
  candidate: ArtifactCatalogEntry,
) {
  await value.catalog.reserve(candidate);
  await value.objects.putIfAbsent(candidate.objectKey, Uint8Array.from([1, 2, 3]));
  await value.catalog.activate(
    scope,
    candidate.metadata.contentReference.artifactId,
    { sha256: "2".repeat(64), sizeBytes: 3 },
    "2026-08-28T03:01:00.000Z",
  );
}

function command(overrides: Partial<Parameters<ProcessArtifactRetention["execute"]>[0]> = {}) {
  return {
    environmentId: "env_production",
    limit: 100,
    principal: principal(),
    projectId: "prj_agent",
    ...overrides,
  };
}

describe("artifact maintenance", () => {
  it("purges abandoned reservations and orphaned objects after a safe grace period", async () => {
    const value = await harness();
    const orphaned = entry("art_abandoned_orphan");
    const empty = entry("art_abandoned_empty");
    const recentBase = entry("art_recent");
    const recent = {
      ...recentBase,
      metadata: { ...recentBase.metadata, createdAt: "2026-09-01T12:00:00.000Z" },
    };
    await value.catalog.reserve(orphaned);
    await value.objects.putIfAbsent(orphaned.objectKey, Uint8Array.from([1, 2, 3]));
    await value.catalog.reserve(empty);
    await value.catalog.reserve(recent);

    await expect(
      value.abandoned.execute({
        ...command(),
        abandonedBefore: "2026-09-01T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      failedArtifactIds: [],
      inspected: 2,
      purged: 2,
      tombstoned: 2,
    });
    expect((await value.catalog.find(scope, "art_abandoned_orphan"))?.metadata.state).toBe(
      "purged",
    );
    expect((await value.catalog.find(scope, "art_abandoned_empty"))?.metadata.state).toBe("purged");
    expect((await value.catalog.find(scope, "art_recent"))?.metadata.state).toBe("reserved");
    await expect(value.objects.get(orphaned.objectKey)).resolves.toBeNull();
    expect(value.catalog.tombstones.slice(-2)).toEqual([
      expect.objectContaining({ trigger: "abandoned" }),
      expect.objectContaining({ trigger: "abandoned" }),
    ]);
  });

  it.each(["invalid", "2026-09-01T23:30:00.000Z"])(
    "rejects an unsafe abandoned threshold %s",
    async (abandonedBefore) => {
      const value = await harness();
      await expect(
        value.abandoned.execute({ ...command(), abandonedBefore }),
      ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
    },
  );

  it("normalizes an invalid abandoned cleanup clock", async () => {
    const value = await harness({ clock: new Date(Number.NaN) });
    await expect(
      value.abandoned.execute({
        ...command(),
        abandonedBefore: "2026-09-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
  });

  it("tombstones and purges only expired content in deterministic bounded batches", async () => {
    const value = await harness();
    await makeAvailable(value, entry("art_expired_b"));
    await makeAvailable(value, entry("art_expired_a"));
    await makeAvailable(value, entry("art_future", { expiresAt: "2026-10-01T00:00:00.000Z" }));
    await makeAvailable(value, entry("art_retained", { retention: "retain" }));

    const result = await value.retention.execute(command({ limit: 1 }));
    expect(result).toEqual({
      failedArtifactIds: [],
      inspected: 1,
      purged: 1,
      tombstoned: 1,
    });
    expect(value.catalog.tombstones[0]).toMatchObject({
      actorPrincipalId: "svc_retention",
      artifactId: "art_expired_a",
      reason: "Configured artifact retention period expired",
      trigger: "retention",
    });
    expect((await value.catalog.find(scope, "art_expired_a"))?.metadata.state).toBe("purged");
    expect((await value.catalog.find(scope, "art_expired_b"))?.metadata.state).toBe("available");
    expect((await value.catalog.find(scope, "art_future"))?.metadata.state).toBe("available");
    expect((await value.catalog.find(scope, "art_retained"))?.metadata.state).toBe("available");
  });

  it("continues the batch and leaves failed deletion safely pending", async () => {
    const value = await harness();
    const first = entry("art_expired_a");
    const second = entry("art_expired_b");
    await makeAvailable(value, first);
    await makeAvailable(value, second);
    value.objects.failingKey = first.objectKey;

    const result = await value.retention.execute(command());
    expect(result).toEqual({
      failedArtifactIds: ["art_expired_a"],
      inspected: 2,
      purged: 1,
      tombstoned: 2,
    });
    expect((await value.catalog.find(scope, "art_expired_a"))?.metadata.state).toBe("tombstoned");
    expect((await value.catalog.find(scope, "art_expired_b"))?.metadata.state).toBe("purged");

    await expect(value.retryPurges.execute(command())).resolves.toEqual({
      failedArtifactIds: [],
      inspected: 1,
      purged: 1,
      tombstoned: 0,
    });
    expect((await value.catalog.find(scope, "art_expired_a"))?.metadata.state).toBe("purged");
  });

  it("converges when another worker tombstones an item after listing it", async () => {
    const value = await harness();
    await makeAvailable(value, entry("art_concurrent"));
    value.catalog.concurrentTombstone = true;

    await expect(value.retention.execute(command())).resolves.toEqual({
      failedArtifactIds: [],
      inspected: 1,
      purged: 1,
      tombstoned: 0,
    });
    expect((await value.catalog.find(scope, "art_concurrent"))?.metadata.state).toBe("purged");
  });

  it("reports purge retry failures without reopening tombstoned content", async () => {
    const value = await harness();
    const candidate = entry("art_pending");
    await makeAvailable(value, candidate);
    await value.catalog.tombstone(scope, {
      actorPrincipalId: "svc_retention",
      artifactId: "art_pending",
      occurredAt: "2026-09-02T00:00:00.000Z",
      reason: "Configured artifact retention period expired",
      tombstoneId: "del_pending",
      trigger: "retention",
    });
    value.objects.failingKey = candidate.objectKey;

    await expect(value.retryPurges.execute(command())).resolves.toEqual({
      failedArtifactIds: ["art_pending"],
      inspected: 1,
      purged: 0,
      tombstoned: 0,
    });
    expect((await value.catalog.find(scope, "art_pending"))?.metadata.state).toBe("tombstoned");
  });

  it.each([
    command({ principal: principal({ capabilities: [] }) }),
    command({ environmentId: "bad-id" }),
  ])("rejects unauthorized or invalid maintenance scopes %#", async (invalidCommand) => {
    const value = await harness();
    await expect(value.retention.execute(invalidCommand)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForbiddenError || error instanceof InvalidArtifactLifecycleInputError,
    );
    await expect(value.retryPurges.execute(invalidCommand)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForbiddenError || error instanceof InvalidArtifactLifecycleInputError,
    );
  });

  it("normalizes an invalid retention clock before listing work", async () => {
    const value = await harness({ clock: new Date(Number.NaN) });
    await expect(value.retention.execute(command())).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
  });
});
