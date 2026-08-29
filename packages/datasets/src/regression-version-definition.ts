import {
  type RecordedInteractionFixtureVersion,
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
  type RegressionDatasetVersion,
  type RegressionDatasetVersionDefinition,
  RegressionDatasetVersionDefinitionSchema,
  RegressionDatasetVersionSchema,
  type RegressionFixtureVersion,
  type RegressionFixtureVersionDefinition,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import { InvalidRegressionVersionInputError } from "./errors.js";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  encodeRecordedInteractionFixtureVersionDefinition,
} from "./interaction-fixture-definition-digest.js";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
  encodeRegressionDatasetVersionDefinition,
  encodeRegressionFixtureVersionDefinition,
} from "./regression-definition-digest.js";

function parseFixtureVersion(input: unknown): RegressionFixtureVersion {
  const result = RegressionFixtureVersionSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidRegressionVersionInputError("Stored regression fixture version is invalid", {
      cause: result.error,
    });
  }
  return result.data;
}

function parseDatasetVersion(input: unknown): RegressionDatasetVersion {
  const result = RegressionDatasetVersionSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidRegressionVersionInputError("Stored regression dataset version is invalid", {
      cause: result.error,
    });
  }
  return result.data;
}

function parseRecordedInteractionFixtureVersion(input: unknown): RecordedInteractionFixtureVersion {
  const result = RecordedInteractionFixtureVersionSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidRegressionVersionInputError(
      "Stored recorded interaction fixture version is invalid",
      { cause: result.error },
    );
  }
  return result.data;
}

function parseFixtureDefinition(input: unknown): RegressionFixtureVersionDefinition {
  const result = RegressionFixtureVersionDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidRegressionVersionInputError(
      "Regression fixture version definition is invalid",
      { cause: result.error },
    );
  }
  return result.data;
}

function parseDatasetDefinition(input: unknown): RegressionDatasetVersionDefinition {
  const result = RegressionDatasetVersionDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidRegressionVersionInputError(
      "Regression dataset version definition is invalid",
      { cause: result.error },
    );
  }
  return result.data;
}

function parseRecordedInteractionFixtureDefinition(
  input: unknown,
): RecordedInteractionFixtureVersionDefinition {
  const result = RecordedInteractionFixtureVersionDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidRegressionVersionInputError(
      "Recorded interaction fixture version definition is invalid",
      { cause: result.error },
    );
  }
  return result.data;
}

export interface ValidatedRegressionFixtureVersionDefinition {
  readonly definition: RegressionFixtureVersionDefinition;
  readonly version: RegressionFixtureVersion;
}

export interface ValidatedRegressionDatasetVersionDefinition {
  readonly definition: RegressionDatasetVersionDefinition;
  readonly version: RegressionDatasetVersion;
}

export interface ValidatedRecordedInteractionFixtureVersionDefinition {
  readonly definition: RecordedInteractionFixtureVersionDefinition;
  readonly version: RecordedInteractionFixtureVersion;
}

/** Validates a fixture version once and returns its authoritative semantic projection. */
export function validateAndProjectRegressionFixtureVersion(
  input: unknown,
): ValidatedRegressionFixtureVersionDefinition {
  const version = parseFixtureVersion(input);
  const definition = RegressionFixtureVersionDefinitionSchema.parse({
    description: version.description,
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
    name: version.name,
    predecessor: version.predecessor,
    replayability: version.replayability,
    schemaVersion: version.schemaVersion,
    scope: version.scope,
    source: {
      eventIds: version.source.eventIds,
      kind: version.source.kind,
      observedEventCount: version.source.observedEventCount,
      sourceCompleteness: version.source.sourceCompleteness,
      traceId: version.source.traceId,
    },
  });

  if (digestRegressionFixtureVersionDefinition(definition) !== version.definitionSha256) {
    throw new InvalidRegressionVersionInputError(
      "Regression fixture version digest does not match its canonical definition bytes",
    );
  }
  return { definition, version };
}

/** Validates a dataset version once and returns its authoritative semantic projection. */
export function validateAndProjectRegressionDatasetVersion(
  input: unknown,
): ValidatedRegressionDatasetVersionDefinition {
  const version = parseDatasetVersion(input);
  const definition = RegressionDatasetVersionDefinitionSchema.parse({
    datasetId: version.datasetId,
    datasetVersionId: version.datasetVersionId,
    description: version.description,
    fixtureVersions: version.fixtureVersions,
    name: version.name,
    predecessor: version.predecessor,
    schemaVersion: version.schemaVersion,
    scope: version.scope,
  });

  if (digestRegressionDatasetVersionDefinition(definition) !== version.definitionSha256) {
    throw new InvalidRegressionVersionInputError(
      "Regression dataset version digest does not match its canonical definition bytes",
    );
  }
  return { definition, version };
}

/** Validates one interaction-complete fixture version and its authoritative definition digest. */
export function validateAndProjectRecordedInteractionFixtureVersion(
  input: unknown,
): ValidatedRecordedInteractionFixtureVersionDefinition {
  const version = parseRecordedInteractionFixtureVersion(input);
  const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse({
    description: version.description,
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
    interactionCapture: version.interactionCapture,
    name: version.name,
    predecessor: version.predecessor,
    replayability: version.replayability,
    schemaVersion: version.schemaVersion,
    scope: version.scope,
    source: {
      eventIds: version.source.eventIds,
      kind: version.source.kind,
      observedEventCount: version.source.observedEventCount,
      sourceCompleteness: version.source.sourceCompleteness,
      traceId: version.source.traceId,
    },
  });
  if (digestRecordedInteractionFixtureVersionDefinition(definition) !== version.definitionSha256) {
    throw new InvalidRegressionVersionInputError(
      "Recorded interaction fixture version digest does not match its canonical definition bytes",
    );
  }
  return { definition, version };
}

/**
 * Strictly validates a stored fixture version and projects only its semantic definition.
 * Provenance, the self digest, and the nested capture timestamp are intentionally excluded.
 */
export function projectRegressionFixtureVersionDefinition(
  input: unknown,
): RegressionFixtureVersionDefinition {
  return validateAndProjectRegressionFixtureVersion(input).definition;
}

/**
 * Strictly validates a stored dataset version and projects only its semantic definition.
 * Provenance and the self digest are intentionally excluded.
 */
export function projectRegressionDatasetVersionDefinition(
  input: unknown,
): RegressionDatasetVersionDefinition {
  return validateAndProjectRegressionDatasetVersion(input).definition;
}

/** Projects only immutable interaction fixture semantics, excluding stored provenance. */
export function projectRecordedInteractionFixtureVersionDefinition(
  input: unknown,
): RecordedInteractionFixtureVersionDefinition {
  return validateAndProjectRecordedInteractionFixtureVersion(input).definition;
}

/** Compares validated fixture semantics by canonical bytes, never by digest equality alone. */
export function areRegressionFixtureVersionDefinitionsEqual(
  left: unknown,
  right: unknown,
): boolean {
  const leftBytes = encodeRegressionFixtureVersionDefinition(parseFixtureDefinition(left));
  const rightBytes = encodeRegressionFixtureVersionDefinition(parseFixtureDefinition(right));
  return Buffer.from(leftBytes).equals(rightBytes);
}

/** Compares validated dataset semantics by canonical bytes, never by digest equality alone. */
export function areRegressionDatasetVersionDefinitionsEqual(
  left: unknown,
  right: unknown,
): boolean {
  const leftBytes = encodeRegressionDatasetVersionDefinition(parseDatasetDefinition(left));
  const rightBytes = encodeRegressionDatasetVersionDefinition(parseDatasetDefinition(right));
  return Buffer.from(leftBytes).equals(rightBytes);
}

/** Compares validated interaction fixture semantics by canonical bytes, never digest alone. */
export function areRecordedInteractionFixtureVersionDefinitionsEqual(
  left: unknown,
  right: unknown,
): boolean {
  const leftBytes = encodeRecordedInteractionFixtureVersionDefinition(
    parseRecordedInteractionFixtureDefinition(left),
  );
  const rightBytes = encodeRecordedInteractionFixtureVersionDefinition(
    parseRecordedInteractionFixtureDefinition(right),
  );
  return Buffer.from(leftBytes).equals(rightBytes);
}
