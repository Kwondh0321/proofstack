import type {
  ArtifactMetadata,
  PrincipalContext,
  ReserveArtifactRequest,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import type { ArtifactEncryptionPlanner } from "./artifact-ports.js";
import { ArtifactConflictError, InvalidArtifactLifecycleInputError } from "./errors.js";
import { ReserveArtifact } from "./reserve-artifact.js";
import { MemoryArtifactCatalogRepository } from "./testing/index.js";

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
    requestId: "req_reserve_artifact",
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: ["env_production"], projectId: "prj_agent" }],
    },
    roles: ["ingest"],
    tenantId: "ten_acme",
    ...overrides,
  };
}

function request(overrides: Partial<ReserveArtifactRequest> = {}): ReserveArtifactRequest {
  return {
    artifactId: "art_model_output",
    classification: "confidential",
    mediaType: "application/json",
    redaction: { status: "not_required" },
    retention: { expiresAt: "2026-09-28T03:00:00.000Z", mode: "expire" },
    sha256: "1".repeat(64),
    sizeBytes: 18,
    ...overrides,
  };
}

function harness(options: { readonly clock?: Date } = {}) {
  const catalog = new MemoryArtifactCatalogRepository();
  const planned: ArtifactMetadata[] = [];
  let objectKeyCalls = 0;
  let currentTime = options.clock ?? new Date("2026-08-28T03:00:00.000Z");
  const clock = { now: () => new Date(currentTime) };
  const encryption: ArtifactEncryptionPlanner = {
    createPlan: async (metadata) => {
      planned.push(metadata);
      return {
        contentNonce: "AAAAAAAAAAAAAAAA",
        version: "a256gcm-v1",
        wrappedDataKey: {
          algorithm: "A256GCM",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          keyId: "key_primary",
          nonce: "AAAAAAAAAAAAAAAA",
          tag: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      };
    },
  };
  const reserve = new ReserveArtifact({
    catalog,
    clock,
    encryption,
    identities: {
      generateLifecycleId: () => "del_unused",
      generateObjectKey: () => {
        objectKeyCalls += 1;
        return "objects/v1/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
    },
  });
  return {
    catalog,
    objectKeyCalls: () => objectKeyCalls,
    planned,
    reserve,
    setClock(value: Date) {
      currentTime = value;
    },
  };
}

function command(overrides: Partial<Parameters<ReserveArtifact["execute"]>[0]> = {}) {
  return {
    environmentId: "env_production",
    principal: principal(),
    projectId: "prj_agent",
    request: request(),
    ...overrides,
  };
}

describe("ReserveArtifact", () => {
  it("authorizes and persists a bounded public reservation without exposing storage details", async () => {
    const value = harness();
    const result = await value.reserve.execute(
      command({
        request: request({
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
        }),
      }),
    );

    expect(result).toMatchObject({
      created: true,
      metadata: {
        contentReference: { artifactId: "art_model_output", redactedAt: "source" },
        createdAt: "2026-08-28T03:00:00.000Z",
        scope: {
          environmentId: "env_production",
          projectId: "prj_agent",
          tenantId: "ten_acme",
        },
        state: "reserved",
      },
    });
    expect(Object.keys(result)).toEqual(["created", "metadata"]);
    expect(value.planned).toEqual([result.metadata]);
    expect(value.objectKeyCalls()).toBe(1);
  });

  it("reuses the first encryption plan and locator for an identical retry", async () => {
    const value = harness();
    const first = await value.reserve.execute(command());
    value.setClock(new Date("2026-10-28T03:00:00.000Z"));
    const retry = await value.reserve.execute(command());

    expect(retry).toEqual({ created: false, metadata: first.metadata });
    expect(value.planned).toHaveLength(1);
    expect(value.objectKeyCalls()).toBe(1);
  });

  it("returns the current lifecycle state for an identical late retry", async () => {
    const value = harness();
    await value.reserve.execute(command());
    await value.catalog.activate(
      { environmentId: "env_production", projectId: "prj_agent", tenantId: "ten_acme" },
      "art_model_output",
      { sha256: "2".repeat(64), sizeBytes: 38 },
      "2026-08-28T03:01:00.000Z",
    );

    const retry = await value.reserve.execute(command());
    expect(retry.created).toBe(false);
    expect(retry.metadata.state).toBe("available");
  });

  it("conflicts without rotating internal material when immutable metadata changes", async () => {
    const value = harness();
    await value.reserve.execute(command());

    await expect(
      value.reserve.execute(command({ request: request({ sha256: "2".repeat(64) }) })),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    expect(value.planned).toHaveLength(1);
    expect(value.objectKeyCalls()).toBe(1);
  });

  it.each([
    principal({ capabilities: [] }),
    principal({
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_other"], projectId: "prj_agent" }],
      },
    }),
  ])("rejects unauthorized reservation before generating storage material %#", async (actor) => {
    const value = harness();
    await expect(value.reserve.execute(command({ principal: actor }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(value.planned).toHaveLength(0);
    expect(value.objectKeyCalls()).toBe(0);
  });

  it.each([
    request({ mediaType: "INVALID" }),
    request({ retention: { expiresAt: "2026-08-28T03:00:00.000Z", mode: "expire" } }),
  ])("rejects an invalid public reservation %#", async (invalidRequest) => {
    await expect(
      harness().reserve.execute(command({ request: invalidRequest })),
    ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
  });

  it("accepts explicit retain policy and normalizes an invalid clock", async () => {
    await expect(
      harness().reserve.execute(command({ request: request({ retention: { mode: "retain" } }) })),
    ).resolves.toMatchObject({ metadata: { retention: { mode: "retain" } } });

    await expect(
      harness({ clock: new Date(Number.NaN) }).reserve.execute(command()),
    ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
  });

  it("rejects an invalid project or environment scope", async () => {
    const actor = principal({ resourceScope: { mode: "tenant" } });
    await expect(
      harness().reserve.execute(command({ environmentId: "bad-id", principal: actor })),
    ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
  });
});
