import type {
  RegressionDatasetVersion,
  RegressionDatasetVersionDefinition,
  RegressionFixtureVersion,
  RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
} from "../errors.js";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "../regression-definition-digest.js";
import {
  REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
  type RegressionVersionPublishedOutboxIntent,
} from "../regression-publication-outbox.js";
import { MemoryRegressionVersionRepository } from "./memory-regression-version-repository.js";
import {
  regressionVersionRepositoryConformanceCases,
  type RegressionVersionRepositoryTestFactory,
} from "./regression-version-repository-conformance.js";

const factory: RegressionVersionRepositoryTestFactory = () => {
  const repository = new MemoryRegressionVersionRepository();
  return {
    failNextPublicationIntent: (kind) => repository.failNextPublicationIntent(kind),
    publishedIntents: (tenantId) => repository.publishedIntents(tenantId),
    repository,
  };
};

function fixtureCandidate(): RegressionFixtureVersion {
  const definition: RegressionFixtureVersionDefinition = {
    fixtureId: "fix_internal_contract",
    fixtureVersionId: "fixv_internal_contract_001",
    name: "Internal contract fixture",
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_internal_contract",
      projectId: "prj_internal_contract",
      tenantId: "ten_internal_contract",
    },
    source: {
      eventIds: ["evt_internal_contract"],
      kind: "trace_snapshot",
      observedEventCount: 1,
      sourceCompleteness: "observed_snapshot",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    },
  };
  return {
    createdAt: "2026-08-29T01:01:00.000Z",
    createdByPrincipalId: "usr_internal_contract",
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
    ...definition,
    source: { capturedAt: "2026-08-29T01:00:30.000Z", ...definition.source },
  };
}

function datasetCandidate(fixture: RegressionFixtureVersion): RegressionDatasetVersion {
  const definition: RegressionDatasetVersionDefinition = {
    datasetId: "dat_internal_contract",
    datasetVersionId: "datv_internal_contract_001",
    fixtureVersions: [
      {
        definitionSha256: fixture.definitionSha256,
        fixtureId: fixture.fixtureId,
        fixtureVersionId: fixture.fixtureVersionId,
      },
    ],
    name: "Internal contract dataset",
    schemaVersion: "0.1",
    scope: fixture.scope,
  };
  return {
    createdAt: "2026-08-29T01:02:00.000Z",
    createdByPrincipalId: "usr_internal_contract",
    definitionSha256: digestRegressionDatasetVersionDefinition(definition),
    ...definition,
  };
}

describe("MemoryRegressionVersionRepository conformance", () => {
  for (const testCase of regressionVersionRepositoryConformanceCases) {
    it(testCase.name, async () => testCase.run(factory));
  }
});

describe("MemoryRegressionVersionRepository internal integrity", () => {
  it("translates malformed stored fixture and dataset state to a repository contract error", async () => {
    const repository = new MemoryRegressionVersionRepository();
    const fixture = fixtureCandidate();
    const dataset = datasetCandidate(fixture);
    await repository.publishFixtureVersion(fixture);
    await repository.publishDatasetVersion(dataset);

    interface UnsafeTenantState {
      readonly datasetVersions: Map<string, RegressionDatasetVersion>;
      readonly fixtureResources: Map<string, unknown>;
      readonly fixtureVersions: Map<string, RegressionFixtureVersion>;
      readonly publicationIntents: Map<string, RegressionVersionPublishedOutboxIntent>;
    }
    const tenants = (repository as unknown as { readonly tenants: Map<string, UnsafeTenantState> })
      .tenants;
    const state = tenants.get(fixture.scope.tenantId);
    expect(state).toBeDefined();
    if (!state) throw new Error("Expected memory repository tenant state");

    const originalFixtureBinding = state.fixtureResources.get(fixture.fixtureId);
    expect(originalFixtureBinding).toBeDefined();
    for (const malformedBinding of ["invalid", null, {}, { scope: "invalid" }, { scope: null }]) {
      state.fixtureResources.set(fixture.fixtureId, malformedBinding);
      await expect(
        repository.fixtureResourceExists(fixture.scope, fixture.fixtureId),
      ).resolves.toBe(false);
    }
    state.fixtureResources.set(fixture.fixtureId, originalFixtureBinding);

    state.fixtureVersions.set(fixture.fixtureVersionId, {
      ...fixture,
      definitionSha256: "f".repeat(64),
    });
    const hiddenScope = { ...fixture.scope, projectId: "prj_hidden_internal_contract" };
    await expect(
      repository.findFixtureVersion(hiddenScope, fixture.fixtureVersionId),
    ).resolves.toBeNull();
    await expect(
      repository.resolveFixtureVersionReferences(hiddenScope, [
        { fixtureId: fixture.fixtureId, fixtureVersionId: fixture.fixtureVersionId },
      ]),
    ).resolves.toBeNull();
    await expect(
      repository.findFixtureVersion(fixture.scope, fixture.fixtureVersionId),
    ).rejects.toMatchObject({
      cause: expect.any(InvalidRegressionVersionInputError),
      code: "regression_repository_contract_violation",
      name: RegressionRepositoryContractError.name,
    });

    state.datasetVersions.set(dataset.datasetVersionId, {
      ...dataset,
      definitionSha256: "f".repeat(64),
    });
    await expect(
      repository.findDatasetVersion(hiddenScope, dataset.datasetVersionId),
    ).resolves.toBeNull();
    await expect(
      repository.findDatasetVersion(dataset.scope, dataset.datasetVersionId),
    ).rejects.toMatchObject({
      cause: expect.any(InvalidRegressionVersionInputError),
      code: "regression_repository_contract_violation",
      name: RegressionRepositoryContractError.name,
    });
  });

  it("rejects retries when the stored canonical publication intent is missing or mismatched", async () => {
    const repository = new MemoryRegressionVersionRepository();
    const fixture = fixtureCandidate();
    await repository.publishFixtureVersion(fixture);

    interface UnsafeTenantState {
      readonly publicationIntents: Map<string, RegressionVersionPublishedOutboxIntent>;
    }
    const tenants = (repository as unknown as { readonly tenants: Map<string, UnsafeTenantState> })
      .tenants;
    const state = tenants.get(fixture.scope.tenantId);
    expect(state).toBeDefined();
    if (!state) throw new Error("Expected memory repository tenant state");
    const originalEntry = [...state.publicationIntents.entries()][0];
    expect(originalEntry).toBeDefined();
    if (!originalEntry) throw new Error("Expected memory repository publication intent");
    const [key, intent] = originalEntry;
    if (intent.eventType !== REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE) {
      throw new Error("Expected fixture publication intent");
    }

    state.publicationIntents.clear();
    await expect(repository.publishFixtureVersion(fixture)).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );

    state.publicationIntents.set(key, {
      ...intent,
      payload: { ...intent.payload, projectId: "prj_mismatched_intent" },
    });
    await expect(repository.publishFixtureVersion(fixture)).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });
});
