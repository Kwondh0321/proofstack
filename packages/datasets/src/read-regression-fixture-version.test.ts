import type {
  EvidenceScope,
  PrincipalContext,
  RegressionFixtureVersion,
  RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { ReadRegressionFixtureVersion } from "./read-regression-fixture-version.js";
import { digestRegressionFixtureVersionDefinition } from "./regression-definition-digest.js";
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
      credentialId: "ses_fixture_reader",
      method: "oidc",
    },
    capabilities: ["dataset:read"],
    principalId: "usr_fixture_reader",
    principalType: "user",
    requestId: "req_read_fixture",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: scope.tenantId,
    ...overrides,
  };
}

function version(overrides: Partial<RegressionFixtureVersion> = {}): RegressionFixtureVersion {
  const fixtureId = overrides.fixtureId ?? "fix_checkout_timeout";
  const fixtureVersionId = overrides.fixtureVersionId ?? "fixv_checkout_timeout_001";
  const eventIds = overrides.source?.eventIds ?? ["evt_checkout_a", "evt_checkout_b"];
  const definition: RegressionFixtureVersionDefinition = {
    description: overrides.description ?? "Observed checkout timeout.",
    fixtureId,
    fixtureVersionId,
    name: overrides.name ?? "Checkout timeout",
    ...(overrides.predecessor ? { predecessor: overrides.predecessor } : {}),
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: overrides.scope ?? scope,
    source: {
      eventIds: [...eventIds],
      kind: "trace_snapshot",
      observedEventCount: eventIds.length,
      sourceCompleteness: "observed_snapshot",
      traceId: overrides.source?.traceId ?? "4bf92f3577b34da6a3ce929d0e0e4736",
    },
  };
  return {
    createdAt: overrides.createdAt ?? "2026-08-29T02:01:00.123Z",
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_fixture_author",
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
    ...definition,
    source: {
      capturedAt: overrides.source?.capturedAt ?? "2026-08-29T02:00:59.999999Z",
      ...definition.source,
    },
  };
}

function harness(stored: unknown = version()) {
  const findFixtureVersion = vi.fn(
    async (
      _scope: EvidenceScope,
      _fixtureVersionId: string,
    ): Promise<RegressionFixtureVersion | null> => stored as RegressionFixtureVersion | null,
  );
  const unexpected = vi.fn(async () => {
    throw new Error("Unexpected repository call");
  });
  const repository: RegressionVersionRepository = {
    datasetResourceExists: unexpected,
    findDatasetVersion: unexpected,
    findFixtureVersion,
    fixtureResourceExists: unexpected,
    publishDatasetVersion: unexpected,
    publishFixtureVersion: unexpected,
    resolveFixtureVersionReferences: unexpected,
  };
  return {
    findFixtureVersion,
    reader: new ReadRegressionFixtureVersion(repository),
  };
}

function command(overrides: Partial<Parameters<ReadRegressionFixtureVersion["execute"]>[0]> = {}) {
  return {
    environmentId: scope.environmentId,
    fixtureId: "fix_checkout_timeout",
    fixtureVersionId: "fixv_checkout_timeout_001",
    principal: principal(),
    projectId: scope.projectId,
    ...overrides,
  };
}

describe("ReadRegressionFixtureVersion", () => {
  it("returns a detached exact version from a detached authorized scope", async () => {
    const stored = version();
    const value = harness(stored);
    value.findFixtureVersion.mockImplementation(async (repositoryScope, versionId) => {
      expect(repositoryScope).toEqual(scope);
      expect(versionId).toBe(stored.fixtureVersionId);
      (repositoryScope as { environmentId: string }).environmentId = "env_mutated";
      return stored;
    });

    const result = await value.reader.execute(command());

    expect(result).toEqual(stored);
    expect(result).not.toBe(stored);
    (result.source.eventIds as string[])[0] = "evt_mutated";
    expect(stored.source.eventIds[0]).toBe("evt_checkout_a");
  });

  it("requires read capability before repository access", async () => {
    const value = harness();
    await expect(
      value.reader.execute(command({ principal: principal({ capabilities: ["dataset:manage"] }) })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findFixtureVersion).not.toHaveBeenCalled();
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
    expect(value.findFixtureVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["principal", command({ principal: principal({ principalId: "bad-id" }) })],
    ["scope", command({ projectId: "bad-id" })],
    ["fixture id", command({ fixtureId: "bad-id" })],
    ["version id", command({ fixtureVersionId: "bad-id" })],
  ])("rejects invalid %s input before repository access", async (_label, input) => {
    const value = harness();
    await expect(value.reader.execute(input)).rejects.toBeInstanceOf(
      InvalidRegressionVersionInputError,
    );
    expect(value.findFixtureVersion).not.toHaveBeenCalled();
  });

  it("hides missing and cross-resource versions with the same not-found error", async () => {
    const missing = harness(null);
    await expect(missing.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionNotFoundError,
    );

    const otherResource = harness(version({ fixtureId: "fix_other" }));
    await expect(otherResource.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionNotFoundError,
    );
  });

  it.each([
    ["invalid version", {}],
    ["substituted version", version({ fixtureVersionId: "fixv_other_001" })],
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
    value.findFixtureVersion.mockRejectedValue(failure);
    await expect(value.reader.execute(command())).rejects.toBe(failure);
  });
});
