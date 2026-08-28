import { createHash } from "node:crypto";
import {
  type RegressionDatasetVersionDefinition,
  RegressionDatasetVersionDefinitionSchema,
  type RegressionFixtureVersionDefinition,
  RegressionFixtureVersionDefinitionSchema,
} from "@proofstack/contracts";
import {
  concatenateBytes,
  encodeOptional,
  encodeSequence,
  encodeString,
} from "./binary-encoding.js";

export const REGRESSION_FIXTURE_DEFINITION_DOMAIN = "proofstack.fixture-version.v1" as const;
export const REGRESSION_DATASET_DEFINITION_DOMAIN = "proofstack.dataset-version.v1" as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function encodeRegressionFixtureVersionDefinition(
  input: RegressionFixtureVersionDefinition,
): Uint8Array {
  const definition = RegressionFixtureVersionDefinitionSchema.parse(input);

  return concatenateBytes([
    encodeString(REGRESSION_FIXTURE_DEFINITION_DOMAIN),
    encodeString(definition.schemaVersion),
    encodeString(definition.scope.tenantId),
    encodeString(definition.scope.projectId),
    encodeString(definition.scope.environmentId),
    encodeString(definition.fixtureId),
    encodeString(definition.fixtureVersionId),
    encodeString(definition.name),
    encodeOptional(definition.description, encodeString),
    encodeOptional(definition.predecessor, (predecessor) =>
      concatenateBytes([
        encodeString(predecessor.fixtureVersionId),
        encodeString(predecessor.definitionSha256),
      ]),
    ),
    encodeString(definition.source.traceId),
    encodeSequence(definition.source.eventIds, encodeString),
    encodeString(definition.source.sourceCompleteness),
    encodeString(definition.replayability),
  ]);
}

export function digestRegressionFixtureVersionDefinition(
  input: RegressionFixtureVersionDefinition,
): string {
  return sha256(encodeRegressionFixtureVersionDefinition(input));
}

export function encodeRegressionDatasetVersionDefinition(
  input: RegressionDatasetVersionDefinition,
): Uint8Array {
  const definition = RegressionDatasetVersionDefinitionSchema.parse(input);

  return concatenateBytes([
    encodeString(REGRESSION_DATASET_DEFINITION_DOMAIN),
    encodeString(definition.schemaVersion),
    encodeString(definition.scope.tenantId),
    encodeString(definition.scope.projectId),
    encodeString(definition.scope.environmentId),
    encodeString(definition.datasetId),
    encodeString(definition.datasetVersionId),
    encodeString(definition.name),
    encodeOptional(definition.description, encodeString),
    encodeOptional(definition.predecessor, (predecessor) =>
      concatenateBytes([
        encodeString(predecessor.datasetVersionId),
        encodeString(predecessor.definitionSha256),
      ]),
    ),
    encodeSequence(definition.fixtureVersions, (fixtureVersion) =>
      concatenateBytes([
        encodeString(fixtureVersion.fixtureId),
        encodeString(fixtureVersion.fixtureVersionId),
        encodeString(fixtureVersion.definitionSha256),
      ]),
    ),
  ]);
}

export function digestRegressionDatasetVersionDefinition(
  input: RegressionDatasetVersionDefinition,
): string {
  return sha256(encodeRegressionDatasetVersionDefinition(input));
}
