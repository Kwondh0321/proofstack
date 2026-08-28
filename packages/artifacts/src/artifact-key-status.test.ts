import type { PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import { InspectArtifactKeyReferences } from "./artifact-key-status.js";
import type {
  ArtifactCatalogRepository,
  ArtifactKeyInventory,
  ArtifactKeyReferenceSummary,
} from "./artifact-ports.js";
import { InvalidArtifactLifecycleInputError } from "./errors.js";

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
    requestId: "req_key_status",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: "ten_acme",
    ...overrides,
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "env_production",
    principal: principal(),
    projectId: "prj_agent",
    ...overrides,
  };
}

const counts = {
  available: 1,
  purged: 2,
  reserved: 3,
  tombstoned: 4,
  total: 10,
};

function subject(
  options: {
    readonly activeKeyId?: unknown;
    readonly configuredKeyIds?: unknown;
    readonly references?: unknown;
  } = {},
) {
  const keys = {
    activeKeyId: async () => options.activeKeyId ?? "key_primary",
    configuredKeyIds: async () => options.configuredKeyIds ?? ["key_primary", "key_archived"],
  } as ArtifactKeyInventory;
  const catalog = {
    listKeyReferences: async () =>
      options.references ??
      ([
        { counts, keyId: "key_archived" },
        {
          counts: { available: 0, purged: 0, reserved: 1, tombstoned: 0, total: 1 },
          keyId: "key_missing",
        },
      ] satisfies readonly ArtifactKeyReferenceSummary[]),
  } as unknown as ArtifactCatalogRepository;
  return new InspectArtifactKeyReferences({ catalog, keys });
}

describe("InspectArtifactKeyReferences", () => {
  it("combines configured and referenced keys without exposing key material", async () => {
    await expect(subject().execute(command())).resolves.toEqual({
      activeKeyId: "key_primary",
      keys: [
        { active: false, configured: true, counts, keyId: "key_archived" },
        {
          active: false,
          configured: false,
          counts: { available: 0, purged: 0, reserved: 1, tombstoned: 0, total: 1 },
          keyId: "key_missing",
        },
        {
          active: true,
          configured: true,
          counts: { available: 0, purged: 0, reserved: 0, tombstoned: 0, total: 0 },
          keyId: "key_primary",
        },
      ],
    });
  });

  it.each([
    { activeKeyId: "bad-id" },
    { configuredKeyIds: "key_primary" },
    { configuredKeyIds: ["key_primary", "bad-id"] },
    { configuredKeyIds: ["key_primary", "key_primary"] },
    { activeKeyId: "key_unconfigured" },
    { references: "invalid" },
  ])("rejects invalid key inventories %#", async (options) => {
    await expect(subject(options).execute(command())).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
  });

  it.each([
    { references: [null] },
    { references: [{ counts, keyId: "bad-id" }] },
    { references: [{ counts: null, keyId: "key_archived" }] },
    { references: [{ counts: { ...counts, available: -1 }, keyId: "key_archived" }] },
    { references: [{ counts: { ...counts, purged: 1.5 }, keyId: "key_archived" }] },
    {
      references: [
        { counts: { ...counts, reserved: Number.MAX_SAFE_INTEGER + 1 }, keyId: "key_archived" },
      ],
    },
    { references: [{ counts: { ...counts, tombstoned: "4" }, keyId: "key_archived" }] },
    { references: [{ counts: { ...counts, total: 9 }, keyId: "key_archived" }] },
    {
      references: [
        { counts, keyId: "key_archived" },
        { counts, keyId: "key_archived" },
      ],
    },
  ])("rejects malformed catalog key-reference summaries %#", async ({ references }) => {
    await expect(subject({ references }).execute(command())).rejects.toBeInstanceOf(
      InvalidArtifactLifecycleInputError,
    );
  });

  it.each([
    command({ principal: principal({ capabilities: [] }) }),
    command({ environmentId: "bad-id" }),
  ])("rejects unauthorized or invalid scopes %#", async (invalidCommand) => {
    await expect(subject().execute(invalidCommand)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForbiddenError || error instanceof InvalidArtifactLifecycleInputError,
    );
  });
});
