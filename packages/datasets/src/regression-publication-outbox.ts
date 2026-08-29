import type { JsonObject } from "@proofstack/contracts";
import {
  validateAndProjectRecordedInteractionFixtureVersion,
  validateAndProjectRegressionDatasetVersion,
  validateAndProjectRegressionFixtureVersion,
} from "./regression-version-definition.js";

export const REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION = "0.1" as const;

export const REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE = "regression.fixture-version" as const;
export const REGRESSION_DATASET_VERSION_AGGREGATE_TYPE = "regression.dataset-version" as const;
export const REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE =
  "regression.fixture-version.published" as const;
export const REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE =
  "regression.dataset-version.published" as const;

export type RegressionVersionAggregateType =
  | typeof REGRESSION_DATASET_VERSION_AGGREGATE_TYPE
  | typeof REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE;

export type RegressionVersionPublishedEventType =
  | typeof REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE
  | typeof REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE;

export type RegressionFixtureVersionPublishedPayload = {
  readonly definitionSha256: string;
  readonly environmentId: string;
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
  readonly projectId: string;
};

export type RegressionDatasetVersionPublishedPayload = {
  readonly datasetId: string;
  readonly datasetVersionId: string;
  readonly definitionSha256: string;
  readonly environmentId: string;
  readonly projectId: string;
};

export interface RegressionVersionPublicationOutboxIntent<
  AggregateType extends RegressionVersionAggregateType = RegressionVersionAggregateType,
  EventType extends RegressionVersionPublishedEventType = RegressionVersionPublishedEventType,
  Payload extends JsonObject = JsonObject,
> {
  readonly aggregateId: string;
  readonly aggregateType: AggregateType;
  readonly createdAt: string;
  readonly eventType: EventType;
  readonly payload: Payload;
  readonly schemaVersion: typeof REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION;
  readonly tenantId: string;
}

export type RegressionFixtureVersionPublishedOutboxIntent =
  RegressionVersionPublicationOutboxIntent<
    typeof REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
    typeof REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
    RegressionFixtureVersionPublishedPayload
  >;

export type RegressionDatasetVersionPublishedOutboxIntent =
  RegressionVersionPublicationOutboxIntent<
    typeof REGRESSION_DATASET_VERSION_AGGREGATE_TYPE,
    typeof REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
    RegressionDatasetVersionPublishedPayload
  >;

export type RegressionVersionPublishedOutboxIntent =
  | RegressionDatasetVersionPublishedOutboxIntent
  | RegressionFixtureVersionPublishedOutboxIntent;

/** Builds the one small exact-read locator intent written with a new fixture version. */
export function buildRegressionFixtureVersionPublishedOutboxIntent(
  input: unknown,
): RegressionFixtureVersionPublishedOutboxIntent {
  const { definition, version } = validateAndProjectRegressionFixtureVersion(input);

  return {
    aggregateId: definition.fixtureVersionId,
    aggregateType: REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
    createdAt: version.createdAt,
    eventType: REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
    payload: {
      definitionSha256: version.definitionSha256,
      environmentId: definition.scope.environmentId,
      fixtureId: definition.fixtureId,
      fixtureVersionId: definition.fixtureVersionId,
      projectId: definition.scope.projectId,
    },
    schemaVersion: REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
    tenantId: definition.scope.tenantId,
  };
}

/** Builds the same small exact-read locator for an interaction-complete fixture version. */
export function buildRecordedInteractionFixtureVersionPublishedOutboxIntent(
  input: unknown,
): RegressionFixtureVersionPublishedOutboxIntent {
  const { definition, version } = validateAndProjectRecordedInteractionFixtureVersion(input);
  return {
    aggregateId: definition.fixtureVersionId,
    aggregateType: REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
    createdAt: version.createdAt,
    eventType: REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
    payload: {
      definitionSha256: version.definitionSha256,
      environmentId: definition.scope.environmentId,
      fixtureId: definition.fixtureId,
      fixtureVersionId: definition.fixtureVersionId,
      projectId: definition.scope.projectId,
    },
    schemaVersion: REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
    tenantId: definition.scope.tenantId,
  };
}

/** Builds the one small exact-read locator intent written with a new dataset version. */
export function buildRegressionDatasetVersionPublishedOutboxIntent(
  input: unknown,
): RegressionDatasetVersionPublishedOutboxIntent {
  const { definition, version } = validateAndProjectRegressionDatasetVersion(input);

  return {
    aggregateId: definition.datasetVersionId,
    aggregateType: REGRESSION_DATASET_VERSION_AGGREGATE_TYPE,
    createdAt: version.createdAt,
    eventType: REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
    payload: {
      datasetId: definition.datasetId,
      datasetVersionId: definition.datasetVersionId,
      definitionSha256: version.definitionSha256,
      environmentId: definition.scope.environmentId,
      projectId: definition.scope.projectId,
    },
    schemaVersion: REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
    tenantId: definition.scope.tenantId,
  };
}
