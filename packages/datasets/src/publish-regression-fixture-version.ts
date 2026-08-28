import { isDeepStrictEqual } from "node:util";
import {
  EvidenceScopeSchema,
  MAX_FIXTURE_SOURCE_EVENTS,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type PublishRegressionFixtureVersionRequest,
  PublishRegressionFixtureVersionRequestSchema,
  REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION,
  type RegressionFixtureVersion,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
  TimestampSchema,
} from "@proofstack/contracts";
import {
  type Clock,
  type EvidenceRepository,
  readBoundedTraceSnapshot,
  requireCapability,
  requireEnvironmentAccess,
  TraceNotFoundError,
} from "@proofstack/core";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
} from "./errors.js";
import { digestRegressionFixtureVersionDefinition } from "./regression-definition-digest.js";
import {
  areRegressionFixtureVersionDefinitionsEqual,
  type ValidatedRegressionFixtureVersionDefinition,
  validateAndProjectRegressionFixtureVersion,
} from "./regression-version-definition.js";
import type {
  PublishRegressionVersionResult,
  RegressionVersionRepository,
} from "./regression-version-repository.js";

export interface PublishRegressionFixtureVersionCommand {
  readonly environmentId: string;
  readonly fixtureId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: PublishRegressionFixtureVersionRequest;
}

export interface PublishRegressionFixtureVersionResult {
  readonly created: boolean;
  readonly version: RegressionFixtureVersion;
}

export interface PublishRegressionFixtureVersionDependencies {
  readonly clock: Clock;
  readonly evidenceRepository: EvidenceRepository;
  readonly versionRepository: RegressionVersionRepository;
}

function detached<Value>(value: Value): Value {
  return structuredClone(value);
}

function invalidInput(message: string, cause?: unknown): InvalidRegressionVersionInputError {
  return new InvalidRegressionVersionInputError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function publicationPrincipal(input: unknown): PrincipalContext {
  try {
    return PrincipalContextSchema.parse(input);
  } catch (cause) {
    throw invalidInput("Regression fixture publication principal is invalid", cause);
  }
}

function exactScope(
  principal: PrincipalContext,
  projectId: unknown,
  environmentId: unknown,
): ReturnType<typeof EvidenceScopeSchema.parse> {
  const scope = EvidenceScopeSchema.safeParse({
    environmentId,
    projectId,
    tenantId: principal.tenantId,
  });
  if (!scope.success)
    throw invalidInput("Regression fixture publication scope is invalid", scope.error);
  return scope.data;
}

function fixtureId(input: unknown): string {
  const result = OpaqueIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Regression fixture publication route is invalid", result.error);
  }
  return result.data;
}

function publicationRequest(input: unknown): PublishRegressionFixtureVersionRequest {
  const result = PublishRegressionFixtureVersionRequestSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Regression fixture publication request is invalid", result.error);
  }
  return result.data;
}

function sameScope(
  left: ReturnType<typeof EvidenceScopeSchema.parse>,
  right: ReturnType<typeof EvidenceScopeSchema.parse>,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function validateRepositoryVersion(
  input: unknown,
  scope: ReturnType<typeof EvidenceScopeSchema.parse>,
  expectedVersionId: string,
  message: string,
): ValidatedRegressionFixtureVersionDefinition {
  let validated: ValidatedRegressionFixtureVersionDefinition;
  try {
    validated = validateAndProjectRegressionFixtureVersion(input);
  } catch (cause) {
    throw new RegressionRepositoryContractError(message, { cause });
  }
  if (
    validated.version.fixtureVersionId !== expectedVersionId ||
    !sameScope(validated.version.scope, scope)
  ) {
    throw new RegressionRepositoryContractError(message);
  }
  return validated;
}

function isEquivalentRetry(
  fixtureRouteId: string,
  request: PublishRegressionFixtureVersionRequest,
  stored: RegressionFixtureVersion,
): boolean {
  return (
    stored.fixtureId === fixtureRouteId &&
    stored.name === request.name &&
    stored.description === request.description &&
    stored.predecessor?.fixtureVersionId === request.predecessorVersionId &&
    stored.source.kind === request.source.kind &&
    stored.source.traceId === request.source.traceId
  );
}

function hasExactResultKeys(input: object): boolean {
  try {
    const keys = Reflect.ownKeys(input);
    return keys.length === 2 && keys.includes("created") && keys.includes("version");
  } catch (cause) {
    throw new RegressionRepositoryContractError(
      "Fixture publication result violates the repository contract",
      { cause },
    );
  }
}

function validatePublicationResult(
  input: unknown,
  scope: ReturnType<typeof EvidenceScopeSchema.parse>,
  expectedVersionId: string,
): {
  readonly created: boolean;
  readonly validated: ValidatedRegressionFixtureVersionDefinition;
} {
  if (typeof input !== "object" || input === null || !hasExactResultKeys(input)) {
    throw new RegressionRepositoryContractError(
      "Fixture publication result violates the repository contract",
    );
  }

  let created: unknown;
  let version: unknown;
  try {
    created = Reflect.get(input, "created");
    version = Reflect.get(input, "version");
  } catch (cause) {
    throw new RegressionRepositoryContractError(
      "Fixture publication result violates the repository contract",
      { cause },
    );
  }
  if (typeof created !== "boolean") {
    throw new RegressionRepositoryContractError(
      "Fixture publication result violates the repository contract",
    );
  }
  return {
    created,
    validated: validateRepositoryVersion(
      version,
      scope,
      expectedVersionId,
      "Published fixture version violates the repository contract",
    ),
  };
}

function requireExactRetryResult(
  result: {
    readonly created: boolean;
    readonly validated: ValidatedRegressionFixtureVersionDefinition;
  },
  stored: RegressionFixtureVersion,
): PublishRegressionFixtureVersionResult {
  if (result.created || !isDeepStrictEqual(result.validated.version, stored)) {
    throw new RegressionRepositoryContractError(
      "Fixture publication retry violates the repository contract",
    );
  }
  return { created: false, version: result.validated.version };
}

function requireNewPublicationResult(
  result: {
    readonly created: boolean;
    readonly validated: ValidatedRegressionFixtureVersionDefinition;
  },
  candidate: RegressionFixtureVersion,
  candidateDefinition: ReturnType<typeof RegressionFixtureVersionDefinitionSchema.parse>,
): PublishRegressionFixtureVersionResult {
  const semanticallyEqual = areRegressionFixtureVersionDefinitionsEqual(
    result.validated.definition,
    candidateDefinition,
  );
  if (
    !semanticallyEqual ||
    (result.created && !isDeepStrictEqual(result.validated.version, candidate))
  ) {
    throw new RegressionRepositoryContractError(
      "Published fixture version violates the repository contract",
    );
  }
  return { created: result.created, version: result.validated.version };
}

function publicationTimestamp(clock: Clock): string {
  let timestamp: string;
  try {
    timestamp = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Regression fixture publication clock is invalid", cause);
  }
  const result = TimestampSchema.safeParse(timestamp);
  if (!result.success) {
    throw invalidInput("Regression fixture publication clock is invalid", result.error);
  }
  return result.data;
}

/** Publishes one immutable evidence-only fixture version in an authenticated scope. */
export class PublishRegressionFixtureVersion {
  constructor(private readonly dependencies: PublishRegressionFixtureVersionDependencies) {}

  async execute(
    command: PublishRegressionFixtureVersionCommand,
  ): Promise<PublishRegressionFixtureVersionResult> {
    const principal = publicationPrincipal(command.principal);
    requireCapability(principal, "dataset:manage");
    requireCapability(principal, "evidence:read");
    const projectId = command.projectId;
    const environmentId = command.environmentId;
    requireEnvironmentAccess(principal, projectId, environmentId);

    const scope = exactScope(principal, projectId, environmentId);
    const logicalFixtureId = fixtureId(command.fixtureId);
    const request = publicationRequest(command.request);
    const createdByPrincipalId = principal.principalId;
    const existingInput = await this.dependencies.versionRepository.findFixtureVersion(
      detached(scope),
      request.fixtureVersionId,
    );

    if (existingInput !== null) {
      const existing = validateRepositoryVersion(
        existingInput,
        scope,
        request.fixtureVersionId,
        "Stored fixture version violates the repository contract",
      );
      if (!isEquivalentRetry(logicalFixtureId, request, existing.version)) {
        throw new RegressionVersionConflictError();
      }
      const rawResult = await this.dependencies.versionRepository.publishFixtureVersion(
        detached(existing.version),
      );
      const result = validatePublicationResult(rawResult, scope, request.fixtureVersionId);
      return requireExactRetryResult(result, existing.version);
    }

    let predecessor:
      | { readonly definitionSha256: string; readonly fixtureVersionId: string }
      | undefined;
    if (request.predecessorVersionId) {
      const predecessorInput = await this.dependencies.versionRepository.findFixtureVersion(
        detached(scope),
        request.predecessorVersionId,
      );
      if (predecessorInput === null) throw new RegressionVersionLineageError();
      const authoritative = validateRepositoryVersion(
        predecessorInput,
        scope,
        request.predecessorVersionId,
        "Stored fixture predecessor violates the repository contract",
      );
      if (authoritative.version.fixtureId !== logicalFixtureId) {
        throw new RegressionVersionLineageError();
      }
      predecessor = {
        definitionSha256: authoritative.version.definitionSha256,
        fixtureVersionId: authoritative.version.fixtureVersionId,
      };
    } else {
      const resourceExists = await this.dependencies.versionRepository.fixtureResourceExists(
        detached(scope),
        logicalFixtureId,
      );
      if (typeof resourceExists !== "boolean") {
        throw new RegressionRepositoryContractError(
          "Fixture resource existence result violates the repository contract",
        );
      }
      if (resourceExists) throw new RegressionVersionLineageError();
    }

    const snapshot = await readBoundedTraceSnapshot(this.dependencies.evidenceRepository, {
      maximumEvents: MAX_FIXTURE_SOURCE_EVENTS,
      scope: detached(scope),
      traceId: request.source.traceId,
    });
    if (snapshot.status === "not_found") throw new TraceNotFoundError(request.source.traceId);
    if (snapshot.status === "too_large") {
      throw invalidInput(
        `Regression fixture trace snapshot exceeds the ${MAX_FIXTURE_SOURCE_EVENTS}-event limit`,
      );
    }

    const createdAt = publicationTimestamp(this.dependencies.clock);
    const definition = RegressionFixtureVersionDefinitionSchema.parse({
      ...(request.description === undefined ? {} : { description: request.description }),
      fixtureId: logicalFixtureId,
      fixtureVersionId: request.fixtureVersionId,
      name: request.name,
      ...(predecessor === undefined ? {} : { predecessor }),
      replayability: "evidence_only",
      schemaVersion: REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION,
      scope,
      source: {
        eventIds: snapshot.events.map((event) => event.evidence.eventId),
        kind: "trace_snapshot",
        observedEventCount: snapshot.events.length,
        sourceCompleteness: "observed_snapshot",
        traceId: request.source.traceId,
      },
    });
    const candidate = RegressionFixtureVersionSchema.parse({
      ...definition,
      createdAt,
      createdByPrincipalId,
      definitionSha256: digestRegressionFixtureVersionDefinition(definition),
      source: { ...definition.source, capturedAt: createdAt },
    });
    const rawResult: PublishRegressionVersionResult<RegressionFixtureVersion> =
      await this.dependencies.versionRepository.publishFixtureVersion(detached(candidate));
    const result = validatePublicationResult(rawResult, scope, request.fixtureVersionId);
    return requireNewPublicationResult(result, candidate, definition);
  }
}
