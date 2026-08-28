import type { ArtifactCatalogEntry } from "./artifact-ports.js";
import type { PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import {
  ArtifactConflictError,
  ArtifactStateTransitionError,
  InvalidArtifactLifecycleInputError,
} from "./errors.js";
import { MemoryArtifactCatalogRepository } from "./testing/index.js";
import { TombstoneArtifact } from "./tombstone-artifact.js";

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
    requestId: "req_tombstone_artifact",
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

async function harness(options: { readonly clock?: Date } = {}) {
  const catalog = new MemoryArtifactCatalogRepository();
  await catalog.reserve(entry());
  let id = 0;
  let now = options.clock ?? new Date("2026-08-28T03:02:00.000Z");
  const tombstone = new TombstoneArtifact({
    catalog,
    clock: { now: () => new Date(now) },
    identities: {
      generateLifecycleId: () => {
        id += 1;
        return `del_generated_${id}`;
      },
      generateObjectKey: () => "objects/unused",
    },
  });
  return {
    catalog,
    setClock(value: Date) {
      now = value;
    },
    tombstone,
  };
}

function command(overrides: Partial<Parameters<TombstoneArtifact["execute"]>[0]> = {}) {
  return {
    artifactId: "art_model_output",
    environmentId: "env_production",
    principal: principal(),
    projectId: "prj_agent",
    request: { reason: "User-requested removal" },
    ...overrides,
  };
}

describe("TombstoneArtifact", () => {
  it("attributes a manual tombstone and immediately blocks the available artifact", async () => {
    const value = await harness();
    await value.catalog.activate(
      scope,
      "art_model_output",
      { sha256: "2".repeat(64), sizeBytes: 38 },
      "2026-08-28T03:01:00.000Z",
    );

    const result = await value.tombstone.execute(command());
    expect(result).toEqual({
      created: true,
      metadata: expect.objectContaining({
        state: "tombstoned",
        tombstonedAt: "2026-08-28T03:02:00.000Z",
      }),
      tombstone: {
        actorPrincipalId: "usr_owner",
        artifactId: "art_model_output",
        occurredAt: "2026-08-28T03:02:00.000Z",
        reason: "User-requested removal",
        tombstoneId: "del_generated_1",
        trigger: "manual",
      },
    });
  });

  it("returns the first tombstone for an identical retry", async () => {
    const value = await harness();
    await value.catalog.activate(
      scope,
      "art_model_output",
      { sha256: "2".repeat(64), sizeBytes: 38 },
      "2026-08-28T03:01:00.000Z",
    );
    const first = await value.tombstone.execute(command());
    value.setClock(new Date("2026-08-28T03:03:00.000Z"));
    const retry = await value.tombstone.execute(command());

    expect(retry).toEqual({ ...first, created: false });
  });

  it("preserves tombstone attribution after purge", async () => {
    const value = await harness();
    await value.catalog.activate(
      scope,
      "art_model_output",
      { sha256: "2".repeat(64), sizeBytes: 38 },
      "2026-08-28T03:01:00.000Z",
    );
    const first = await value.tombstone.execute(command());
    await value.catalog.recordPurge(scope, {
      artifactId: "art_model_output",
      objectWasPresent: true,
      occurredAt: "2026-08-28T03:03:00.000Z",
      purgeId: "pur_model_output",
    });

    await expect(value.tombstone.execute(command())).resolves.toEqual({
      ...first,
      created: false,
      metadata: expect.objectContaining({ state: "purged" }),
    });
  });

  it("does not manually tombstone an incomplete reservation", async () => {
    await expect(
      harness().then(({ tombstone }) => tombstone.execute(command())),
    ).rejects.toBeInstanceOf(ArtifactStateTransitionError);
  });

  it("conflicts rather than rewriting an existing reason", async () => {
    const value = await harness();
    await value.catalog.activate(
      scope,
      "art_model_output",
      { sha256: "2".repeat(64), sizeBytes: 38 },
      "2026-08-28T03:01:00.000Z",
    );
    await value.tombstone.execute(command());
    await expect(
      value.tombstone.execute(command({ request: { reason: "A different decision" } })),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
  });

  it.each([
    command({ principal: principal({ capabilities: [] }) }),
    command({ artifactId: "bad-id" }),
    command({ request: { reason: " surrounding whitespace " } }),
    command({ environmentId: "bad-id" }),
  ])("rejects unauthorized or invalid deletion input %#", async (invalidCommand) => {
    const value = await harness();
    await expect(value.tombstone.execute(invalidCommand)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForbiddenError || error instanceof InvalidArtifactLifecycleInputError,
    );
  });

  it("normalizes an invalid deletion clock", async () => {
    const value = await harness({ clock: new Date(Number.NaN) });
    await expect(value.tombstone.execute(command())).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
  });
});
