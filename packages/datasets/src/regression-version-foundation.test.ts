import { readFileSync } from "node:fs";
import type {
  JsonObject,
  RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinition,
  RegressionDatasetVersion,
  RegressionDatasetVersionDefinition,
  RegressionFixtureVersion,
  RegressionFixtureVersionDefinition,
  RegressionFixtureVersionReference,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  areRecordedInteractionFixtureVersionDefinitionsEqual,
  areRegressionDatasetVersionDefinitionsEqual,
  areRegressionFixtureVersionDefinitionsEqual,
  buildRecordedInteractionFixtureVersionPublishedOutboxIntent,
  buildRegressionDatasetVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
  InvalidRegressionVersionInputError,
  projectRecordedInteractionFixtureVersionDefinition,
  projectRegressionDatasetVersionDefinition,
  projectRegressionFixtureVersionDefinition,
  REGRESSION_DATASET_VERSION_AGGREGATE_TYPE,
  REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
  REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
  REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
  REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
  RegressionVersionNotFoundError,
  type RegressionVersionRepository,
  type ResolveRegressionFixtureVersionReferencesResult,
} from "./index.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const recordedVectorDocument = JSON.parse(
  readFileSync(
    new URL("../vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly vectors: readonly {
    readonly input: RecordedInteractionFixtureVersionDefinition;
  }[];
};

function recordedInteractionDefinition(): RecordedInteractionFixtureVersionDefinition {
  const definition = recordedVectorDocument.vectors[0]?.input;
  if (!definition) throw new Error("The recorded interaction fixture vector is missing");
  return structuredClone(definition);
}

function recordedInteractionVersion(
  definition = recordedInteractionDefinition(),
  definitionSha256 = digestRecordedInteractionFixtureVersionDefinition(definition),
): RecordedInteractionFixtureVersion {
  return {
    createdAt: "2026-08-29T00:03:00.000Z",
    createdByPrincipalId: "usr_interaction_author",
    definitionSha256,
    ...definition,
    source: {
      capturedAt: "2026-08-29T00:00:30.000Z",
      ...definition.source,
    },
  };
}

function fixtureDefinition(): RegressionFixtureVersionDefinition {
  return {
    description: "Observed checkout failure before the candidate fix.",
    fixtureId: "fix_checkout_timeout",
    fixtureVersionId: "fixv_checkout_timeout_002",
    name: "Checkout timeout",
    predecessor: {
      definitionSha256: DIGEST_A,
      fixtureVersionId: "fixv_checkout_timeout_001",
    },
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_production",
      projectId: "prj_checkout_agent",
      tenantId: "ten_acme",
    },
    source: {
      eventIds: ["evt_agent_start", "evt_agent_failure"],
      kind: "trace_snapshot",
      observedEventCount: 2,
      sourceCompleteness: "observed_snapshot",
      traceId: TRACE_ID,
    },
  };
}

interface FixtureProvenanceOverrides {
  readonly capturedAt?: string;
  readonly createdAt?: string;
  readonly createdByPrincipalId?: string;
  readonly definitionSha256?: string;
}

function fixtureVersion(
  definition = fixtureDefinition(),
  overrides: FixtureProvenanceOverrides = {},
): RegressionFixtureVersion {
  return {
    createdAt: overrides.createdAt ?? "2026-08-29T00:01:00.000Z",
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_fixture_author",
    definitionSha256:
      overrides.definitionSha256 ?? digestRegressionFixtureVersionDefinition(definition),
    ...definition,
    source: {
      capturedAt: overrides.capturedAt ?? "2026-08-29T00:00:30.000Z",
      ...definition.source,
    },
  };
}

function datasetDefinition(): RegressionDatasetVersionDefinition {
  return {
    datasetId: "dat_checkout_regressions",
    datasetVersionId: "datv_checkout_regressions_002",
    description: "Pinned checkout incident versions.",
    fixtureVersions: [
      {
        definitionSha256: digestRegressionFixtureVersionDefinition(fixtureDefinition()),
        fixtureId: "fix_checkout_timeout",
        fixtureVersionId: "fixv_checkout_timeout_002",
      },
      {
        definitionSha256: DIGEST_B,
        fixtureId: "fix_checkout_decline",
        fixtureVersionId: "fixv_checkout_decline_001",
      },
    ],
    name: "Checkout regressions",
    predecessor: {
      datasetVersionId: "datv_checkout_regressions_001",
      definitionSha256: DIGEST_A,
    },
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_production",
      projectId: "prj_checkout_agent",
      tenantId: "ten_acme",
    },
  };
}

interface DatasetProvenanceOverrides {
  readonly createdAt?: string;
  readonly createdByPrincipalId?: string;
  readonly definitionSha256?: string;
}

function datasetVersion(
  definition = datasetDefinition(),
  overrides: DatasetProvenanceOverrides = {},
): RegressionDatasetVersion {
  return {
    createdAt: overrides.createdAt ?? "2026-08-29T00:02:00.000Z",
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_dataset_author",
    definitionSha256:
      overrides.definitionSha256 ?? digestRegressionDatasetVersionDefinition(definition),
    ...definition,
  };
}

describe("regression repository errors", () => {
  it("publishes stable identities without leaking not-found scope details", () => {
    const conflict = new RegressionVersionConflictError();
    const notFound = new RegressionVersionNotFoundError();
    const lineage = new RegressionVersionLineageError();

    expect(conflict).toMatchObject({
      code: "regression_version_conflict",
      name: "RegressionVersionConflictError",
    });
    expect(conflict).not.toHaveProperty("versionId");
    expect(conflict).not.toHaveProperty("versionKind");
    expect(conflict.message).toBe(
      "Regression version is already bound to a different immutable definition",
    );
    expect(notFound).toMatchObject({
      code: "regression_version_not_found",
      message: "Regression version was not found in the authorized scope",
      name: "RegressionVersionNotFoundError",
    });
    expect(lineage).toMatchObject({
      code: "regression_version_lineage_invalid",
      name: "RegressionVersionLineageError",
    });
  });

  it("retains causes on stable invalid-input and repository-contract errors", () => {
    const cause = new Error("low-level failure");
    const invalid = new InvalidRegressionVersionInputError("Invalid candidate", { cause });
    const contract = new RegressionRepositoryContractError("Invalid adapter result", { cause });

    expect(invalid).toMatchObject({
      cause,
      code: "regression_version_input_invalid",
      message: "Invalid candidate",
      name: "InvalidRegressionVersionInputError",
    });
    expect(invalid).toBeInstanceOf(TypeError);
    expect(contract).toMatchObject({
      cause,
      code: "regression_repository_contract_violation",
      message: "Invalid adapter result",
      name: "RegressionRepositoryContractError",
    });
  });
});

describe("stored regression semantic projections", () => {
  it("strictly projects fixture semantics and excludes every provenance field", () => {
    const definition = fixtureDefinition();
    const original = fixtureVersion(definition);
    const changedProvenance = {
      ...original,
      createdAt: "2026-08-29T00:03:00.000Z",
      createdByPrincipalId: "usr_retrying_author",
      source: { ...original.source, capturedAt: "2026-08-29T00:00:45.000Z" },
    };

    const projected = projectRegressionFixtureVersionDefinition(changedProvenance);

    expect(projected).toEqual(definition);
    expect(projected).not.toHaveProperty("createdAt");
    expect(projected).not.toHaveProperty("createdByPrincipalId");
    expect(projected).not.toHaveProperty("definitionSha256");
    expect(projected.source).not.toHaveProperty("capturedAt");
  });

  it("strictly projects dataset semantics and excludes its provenance and self digest", () => {
    const definition = datasetDefinition();
    const original = datasetVersion(definition);
    const changedProvenance = {
      ...original,
      createdAt: "2026-08-29T00:04:00.000Z",
      createdByPrincipalId: "usr_retrying_author",
    };

    const projected = projectRegressionDatasetVersionDefinition(changedProvenance);

    expect(projected).toEqual(definition);
    expect(projected).not.toHaveProperty("createdAt");
    expect(projected).not.toHaveProperty("createdByPrincipalId");
    expect(projected).not.toHaveProperty("definitionSha256");
  });

  it("strictly projects recorded interaction semantics without stored provenance", () => {
    const definition = recordedInteractionDefinition();
    const version = recordedInteractionVersion(definition);
    const projected = projectRecordedInteractionFixtureVersionDefinition(version);

    expect(projected).toEqual(definition);
    expect(projected).not.toHaveProperty("createdAt");
    expect(projected).not.toHaveProperty("createdByPrincipalId");
    expect(projected).not.toHaveProperty("definitionSha256");
    expect(projected.source).not.toHaveProperty("capturedAt");
  });

  it("rejects malformed stored versions and mismatched current digests", () => {
    expect(() =>
      projectRegressionFixtureVersionDefinition({ ...fixtureVersion(), unknown: true }),
    ).toThrowError(
      expect.objectContaining({
        code: "regression_version_input_invalid",
        message: "Stored regression fixture version is invalid",
      }),
    );
    expect(() =>
      projectRegressionDatasetVersionDefinition({ ...datasetVersion(), unknown: true }),
    ).toThrowError(
      expect.objectContaining({
        code: "regression_version_input_invalid",
        message: "Stored regression dataset version is invalid",
      }),
    );
    expect(() =>
      projectRegressionFixtureVersionDefinition(
        fixtureVersion(fixtureDefinition(), { definitionSha256: DIGEST_B }),
      ),
    ).toThrowError(
      "Regression fixture version digest does not match its canonical definition bytes",
    );
    expect(() =>
      projectRegressionDatasetVersionDefinition(
        datasetVersion(datasetDefinition(), { definitionSha256: DIGEST_B }),
      ),
    ).toThrowError(
      "Regression dataset version digest does not match its canonical definition bytes",
    );
    expect(() =>
      projectRecordedInteractionFixtureVersionDefinition({
        ...recordedInteractionVersion(),
        unknown: true,
      }),
    ).toThrowError("Stored recorded interaction fixture version is invalid");
    expect(() =>
      projectRecordedInteractionFixtureVersionDefinition(
        recordedInteractionVersion(recordedInteractionDefinition(), DIGEST_B),
      ),
    ).toThrowError(
      "Recorded interaction fixture version digest does not match its canonical definition bytes",
    );
  });
});

describe("canonical semantic definition equality", () => {
  it("compares fixture definitions by canonical bytes and preserves event order", () => {
    const definition = fixtureDefinition();
    const reorderedProperties: RegressionFixtureVersionDefinition = {
      source: definition.source,
      scope: definition.scope,
      schemaVersion: definition.schemaVersion,
      replayability: definition.replayability,
      predecessor: definition.predecessor,
      name: definition.name,
      fixtureVersionId: definition.fixtureVersionId,
      fixtureId: definition.fixtureId,
      description: definition.description,
    };
    const reversedEvents = {
      ...definition,
      source: { ...definition.source, eventIds: [...definition.source.eventIds].reverse() },
    };

    expect(areRegressionFixtureVersionDefinitionsEqual(definition, reorderedProperties)).toBe(true);
    expect(areRegressionFixtureVersionDefinitionsEqual(definition, reversedEvents)).toBe(false);
    expect(() =>
      areRegressionFixtureVersionDefinitionsEqual(definition, {
        ...definition,
        createdAt: "2026-08-29T00:00:00.000Z",
      }),
    ).toThrowError("Regression fixture version definition is invalid");
  });

  it("compares dataset definitions by canonical bytes and preserves membership order", () => {
    const definition = datasetDefinition();
    const reorderedProperties: RegressionDatasetVersionDefinition = {
      scope: definition.scope,
      schemaVersion: definition.schemaVersion,
      predecessor: definition.predecessor,
      name: definition.name,
      fixtureVersions: definition.fixtureVersions,
      description: definition.description,
      datasetVersionId: definition.datasetVersionId,
      datasetId: definition.datasetId,
    };
    const reversedMembers = {
      ...definition,
      fixtureVersions: [...definition.fixtureVersions].reverse(),
    };

    expect(areRegressionDatasetVersionDefinitionsEqual(definition, reorderedProperties)).toBe(true);
    expect(areRegressionDatasetVersionDefinitionsEqual(definition, reversedMembers)).toBe(false);
    expect(() =>
      areRegressionDatasetVersionDefinitionsEqual(definition, {
        ...definition,
        createdAt: "2026-08-29T00:00:00.000Z",
      }),
    ).toThrowError("Regression dataset version definition is invalid");
  });

  it("compares recorded interaction definitions by fixed bytes and preserves attempt order", () => {
    const definition = recordedInteractionDefinition();
    const reordered: RecordedInteractionFixtureVersionDefinition = {
      interactionCapture: definition.interactionCapture,
      source: definition.source,
      scope: definition.scope,
      schemaVersion: definition.schemaVersion,
      replayability: definition.replayability,
      predecessor: definition.predecessor,
      name: definition.name,
      fixtureVersionId: definition.fixtureVersionId,
      fixtureId: definition.fixtureId,
    };
    const model = definition.interactionCapture.interactions[0];
    if (model?.kind !== "model") throw new Error("Expected a model interaction vector");

    expect(areRecordedInteractionFixtureVersionDefinitionsEqual(definition, reordered)).toBe(true);
    expect(
      areRecordedInteractionFixtureVersionDefinitionsEqual(definition, {
        ...definition,
        interactionCapture: {
          ...definition.interactionCapture,
          interactions: [{ ...model, interactionId: "int_model_other" }],
        },
      }),
    ).toBe(false);
    expect(() =>
      areRecordedInteractionFixtureVersionDefinitionsEqual(definition, {
        ...definition,
        createdAt: "2026-08-29T00:00:00.000Z",
      }),
    ).toThrowError("Recorded interaction fixture version definition is invalid");
  });
});

describe("regression publication outbox intents", () => {
  it("builds a validated fixture locator without captured events or provenance", () => {
    const eventIds = Array.from(
      { length: 1_000 },
      (_, index) => `evt_${index.toString().padStart(4, "0")}`,
    );
    const definition: RegressionFixtureVersionDefinition = {
      ...fixtureDefinition(),
      source: { ...fixtureDefinition().source, eventIds, observedEventCount: eventIds.length },
    };
    const version = fixtureVersion(definition);
    const intent = buildRegressionFixtureVersionPublishedOutboxIntent(version);
    const jsonPayload: JsonObject = intent.payload;

    expect(intent).toEqual({
      aggregateId: "fixv_checkout_timeout_002",
      aggregateType: REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
      createdAt: version.createdAt,
      eventType: REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
      payload: {
        definitionSha256: version.definitionSha256,
        environmentId: "env_production",
        fixtureId: "fix_checkout_timeout",
        fixtureVersionId: "fixv_checkout_timeout_002",
        projectId: "prj_checkout_agent",
      },
      schemaVersion: REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
      tenantId: "ten_acme",
    });
    expect(Object.keys(jsonPayload)).toHaveLength(5);
    expect(JSON.stringify(jsonPayload)).not.toContain("eventIds");
    expect(JSON.stringify(jsonPayload)).not.toContain("capturedAt");
    expect(JSON.stringify(jsonPayload)).not.toContain("createdByPrincipalId");
  });

  it("builds a validated dataset locator without its ordered membership", () => {
    const fixtureVersions = Array.from({ length: 500 }, (_, index) => ({
      definitionSha256: index.toString(16).padStart(64, "0"),
      fixtureId: `fix_${index.toString().padStart(4, "0")}`,
      fixtureVersionId: `fixv_${index.toString().padStart(4, "0")}`,
    }));
    const definition: RegressionDatasetVersionDefinition = {
      ...datasetDefinition(),
      fixtureVersions,
    };
    const version = datasetVersion(definition);
    const intent = buildRegressionDatasetVersionPublishedOutboxIntent(version);
    const jsonPayload: JsonObject = intent.payload;

    expect(intent).toEqual({
      aggregateId: "datv_checkout_regressions_002",
      aggregateType: REGRESSION_DATASET_VERSION_AGGREGATE_TYPE,
      createdAt: version.createdAt,
      eventType: REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
      payload: {
        datasetId: "dat_checkout_regressions",
        datasetVersionId: "datv_checkout_regressions_002",
        definitionSha256: version.definitionSha256,
        environmentId: "env_production",
        projectId: "prj_checkout_agent",
      },
      schemaVersion: REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
      tenantId: "ten_acme",
    });
    expect(Object.keys(jsonPayload)).toHaveLength(5);
    expect(JSON.stringify(jsonPayload)).not.toContain("fixtureVersions");
  });

  it("builds the same bounded locator for recorded interaction fixtures", () => {
    const version = recordedInteractionVersion();
    const intent = buildRecordedInteractionFixtureVersionPublishedOutboxIntent(version);

    expect(intent).toEqual({
      aggregateId: version.fixtureVersionId,
      aggregateType: REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
      createdAt: version.createdAt,
      eventType: REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
      payload: {
        definitionSha256: version.definitionSha256,
        environmentId: version.scope.environmentId,
        fixtureId: version.fixtureId,
        fixtureVersionId: version.fixtureVersionId,
        projectId: version.scope.projectId,
      },
      schemaVersion: REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
      tenantId: version.scope.tenantId,
    });
    expect(JSON.stringify(intent)).not.toContain("interactionCapture");
  });

  it("keeps aggregate, event, and intent schema identifiers stable", () => {
    expect({
      datasetAggregate: REGRESSION_DATASET_VERSION_AGGREGATE_TYPE,
      datasetEvent: REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
      fixtureAggregate: REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
      fixtureEvent: REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
      schemaVersion: REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
    }).toEqual({
      datasetAggregate: "regression.dataset-version",
      datasetEvent: "regression.dataset-version.published",
      fixtureAggregate: "regression.fixture-version",
      fixtureEvent: "regression.fixture-version.published",
      schemaVersion: "0.1",
    });
  });

  it("rejects a stored version whose canonical digest is forged", () => {
    expect(() =>
      buildRegressionFixtureVersionPublishedOutboxIntent(
        fixtureVersion(fixtureDefinition(), { definitionSha256: DIGEST_B }),
      ),
    ).toThrow(InvalidRegressionVersionInputError);
    expect(() =>
      buildRegressionDatasetVersionPublishedOutboxIntent(
        datasetVersion(datasetDefinition(), { definitionSha256: DIGEST_B }),
      ),
    ).toThrow(InvalidRegressionVersionInputError);
  });
});

describe("RegressionVersionRepository port", () => {
  it("supports scoped exact reads, ordered all-or-nothing resolution, and atomic results", async () => {
    const fixture = fixtureVersion();
    const dataset = datasetVersion();
    const references: readonly RegressionFixtureVersionReference[] = dataset.fixtureVersions.slice(
      0,
      1,
    );
    const resolved: ResolveRegressionFixtureVersionReferencesResult = references;
    const repository: RegressionVersionRepository = {
      datasetResourceExists: () => Promise.resolve(true),
      findDatasetVersion: () => Promise.resolve(dataset),
      findFixtureVersion: () => Promise.resolve(fixture),
      fixtureResourceExists: () => Promise.resolve(true),
      publishDatasetVersion: () => Promise.resolve({ created: false, version: dataset }),
      publishFixtureVersion: () => Promise.resolve({ created: true, version: fixture }),
      resolveFixtureVersionReferences: () => Promise.resolve(resolved),
    };

    expect(await repository.datasetResourceExists(dataset.scope, dataset.datasetId)).toBe(true);
    expect(await repository.findDatasetVersion(dataset.scope, dataset.datasetVersionId)).toBe(
      dataset,
    );
    expect(await repository.findFixtureVersion(fixture.scope, fixture.fixtureVersionId)).toBe(
      fixture,
    );
    expect(await repository.fixtureResourceExists(fixture.scope, fixture.fixtureId)).toBe(true);
    expect(await repository.publishDatasetVersion(dataset)).toEqual({
      created: false,
      version: dataset,
    });
    expect(await repository.publishFixtureVersion(fixture)).toEqual({
      created: true,
      version: fixture,
    });
    expect(
      await repository.resolveFixtureVersionReferences(fixture.scope, [
        { fixtureId: fixture.fixtureId, fixtureVersionId: fixture.fixtureVersionId },
      ]),
    ).toEqual(references);
  });
});
