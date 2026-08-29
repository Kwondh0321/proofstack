import type {
  EvidenceScope,
  PrincipalContext,
  RegressionDatasetVersion,
  RegressionDatasetVersionDefinition,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { ReadRegressionDatasetVersion } from "./read-regression-dataset-version.js";
import { digestRegressionDatasetVersionDefinition } from "./regression-definition-digest.js";
import type { RegressionVersionRepository } from "./regression-version-repository.js";

const scope: EvidenceScope = {
  environmentId: "env_production",
  projectId: "prj_agent",
  tenantId: "ten_acme",
};

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-08-29T02:00:00.000Z",
      credentialId: "ses_dataset_reader",
      method: "oidc",
    },
    capabilities: ["dataset:read"],
    principalId: "usr_dataset_reader",
    principalType: "user",
    requestId: "req_read_dataset",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: scope.tenantId,
    ...overrides,
  };
}

function version(overrides: Partial<RegressionDatasetVersion> = {}): RegressionDatasetVersion {
  const definition: RegressionDatasetVersionDefinition = {
    datasetId: overrides.datasetId ?? "dat_checkout",
    datasetVersionId: overrides.datasetVersionId ?? "datv_checkout_001",
    description: overrides.description ?? "Pinned checkout incidents.",
    fixtureVersions: overrides.fixtureVersions ?? [
      {
        definitionSha256: "a".repeat(64),
        fixtureId: "fix_checkout_timeout",
        fixtureVersionId: "fixv_checkout_timeout_001",
      },
    ],
    name: overrides.name ?? "Checkout regressions",
    ...(overrides.predecessor ? { predecessor: overrides.predecessor } : {}),
    schemaVersion: "0.1",
    scope: overrides.scope ?? scope,
  };
  return {
    createdAt: overrides.createdAt ?? "2026-08-29T02:01:00.123Z",
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_dataset_author",
    definitionSha256: digestRegressionDatasetVersionDefinition(definition),
    ...definition,
  };
}

function harness(stored: unknown = version()) {
  const findDatasetVersion = vi.fn(
    async (
      _scope: EvidenceScope,
      _datasetVersionId: string,
    ): Promise<RegressionDatasetVersion | null> => stored as RegressionDatasetVersion | null,
  );
  const unexpected = vi.fn(async () => {
    throw new Error("Unexpected repository call");
  });
  const repository: RegressionVersionRepository = {
    datasetResourceExists: unexpected,
    findDatasetVersion,
    findFixtureVersion: unexpected,
    fixtureResourceExists: unexpected,
    publishDatasetVersion: unexpected,
    publishFixtureVersion: unexpected,
    resolveFixtureVersionReferences: unexpected,
  };
  return {
    findDatasetVersion,
    reader: new ReadRegressionDatasetVersion(repository),
  };
}

function command(overrides: Partial<Parameters<ReadRegressionDatasetVersion["execute"]>[0]> = {}) {
  return {
    datasetId: "dat_checkout",
    datasetVersionId: "datv_checkout_001",
    environmentId: scope.environmentId,
    principal: principal(),
    projectId: scope.projectId,
    ...overrides,
  };
}

describe("ReadRegressionDatasetVersion", () => {
  it("returns a detached exact version from a detached authorized scope", async () => {
    const stored = version();
    const value = harness(stored);
    value.findDatasetVersion.mockImplementation(async (repositoryScope, versionId) => {
      expect(repositoryScope).toEqual(scope);
      expect(versionId).toBe(stored.datasetVersionId);
      (repositoryScope as { tenantId: string }).tenantId = "ten_mutated";
      return stored;
    });

    const result = await value.reader.execute(command());

    expect(result).toEqual(stored);
    expect(result).not.toBe(stored);
    (result.fixtureVersions[0] as { fixtureId: string }).fixtureId = "fix_mutated";
    expect(stored.fixtureVersions[0]?.fixtureId).toBe("fix_checkout_timeout");
  });

  it("requires read capability before repository access", async () => {
    const value = harness();
    await expect(
      value.reader.execute(command({ principal: principal({ capabilities: ["dataset:manage"] }) })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findDatasetVersion).not.toHaveBeenCalled();
  });

  it("requires access to the exact project and environment before repository access", async () => {
    const value = harness();
    const restricted = principal({
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_staging"], projectId: scope.projectId }],
      },
    });
    await expect(value.reader.execute(command({ principal: restricted }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      value.reader.execute(command({ projectId: "prj_other", principal: restricted })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findDatasetVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["principal", command({ principal: principal({ principalId: "bad-id" }) })],
    ["scope", command({ environmentId: "bad-id" })],
    ["dataset id", command({ datasetId: "bad-id" })],
    ["version id", command({ datasetVersionId: "bad-id" })],
  ])("rejects invalid %s input before repository access", async (_label, input) => {
    const value = harness();
    await expect(value.reader.execute(input)).rejects.toBeInstanceOf(
      InvalidRegressionVersionInputError,
    );
    expect(value.findDatasetVersion).not.toHaveBeenCalled();
  });

  it("hides missing and cross-resource versions with the same not-found error", async () => {
    const missing = harness(null);
    await expect(missing.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionNotFoundError,
    );

    const otherResource = harness(version({ datasetId: "dat_other" }));
    await expect(otherResource.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionNotFoundError,
    );
  });

  it.each([
    ["invalid version", {}],
    ["substituted version", version({ datasetVersionId: "datv_other_001" })],
    ["substituted tenant", version({ scope: { ...scope, tenantId: "ten_other" } })],
    ["substituted project", version({ scope: { ...scope, projectId: "prj_other" } })],
    ["substituted environment", version({ scope: { ...scope, environmentId: "env_other" } })],
  ])("rejects a repository %s as a contract violation", async (_label, stored) => {
    const value = harness(stored);
    await expect(value.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("normalizes unreadable repository values as contract violations", async () => {
    const value = harness(
      new Proxy(version(), {
        ownKeys: () => {
          throw new Error("unreadable version");
        },
      }),
    );
    await expect(value.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("preserves adapter failures", async () => {
    const value = harness();
    const failure = new Error("database unavailable");
    value.findDatasetVersion.mockRejectedValue(failure);
    await expect(value.reader.execute(command())).rejects.toBe(failure);
  });
});
