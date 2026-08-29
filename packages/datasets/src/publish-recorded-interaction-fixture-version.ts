import { isDeepStrictEqual } from "node:util";
import {
  ArtifactOwnershipSchema,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type PublishInteractionFixtureVersionRequest,
  PublishInteractionFixtureVersionRequestSchema,
  RECORDED_INTERACTION_FIXTURE_VERSION_SCHEMA_VERSION,
  type RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
} from "./errors.js";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import {
  areRecordedInteractionFixtureVersionDefinitionsEqual,
  type ValidatedRecordedInteractionFixtureVersionDefinition,
  type ValidatedRegressionFixtureVersionDefinition,
  validateAndProjectRecordedInteractionFixtureVersion,
  validateAndProjectRegressionFixtureVersion,
} from "./regression-version-definition.js";
import type {
  InteractionFixtureVersionRepository,
  PublishRecordedInteractionFixtureVersionResult,
} from "./regression-version-repository.js";

export interface PublishRecordedInteractionFixtureVersionCommand {
  readonly environmentId: string;
  readonly fixtureId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: PublishInteractionFixtureVersionRequest;
}

export interface PublishRecordedInteractionFixtureVersionDependencies {
  readonly clock: Clock;
  readonly versionRepository: InteractionFixtureVersionRepository;
}

function detached<Value>(value: Value): Value {
  return structuredClone(value);
}

function invalidInput(message: string, cause: unknown): InvalidRegressionVersionInputError {
  return new InvalidRegressionVersionInputError(message, { cause });
}

function publicationPrincipal(input: unknown): PrincipalContext {
  const result = PrincipalContextSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput(
      "Recorded interaction fixture publication principal is invalid",
      result.error,
    );
  }
  return result.data;
}

function exactScope(
  principal: PrincipalContext,
  projectId: unknown,
  environmentId: unknown,
): ReturnType<typeof EvidenceScopeSchema.parse> {
  const result = EvidenceScopeSchema.safeParse({
    environmentId,
    projectId,
    tenantId: principal.tenantId,
  });
  if (!result.success) {
    throw invalidInput("Recorded interaction fixture publication scope is invalid", result.error);
  }
  return result.data;
}

function fixtureId(input: unknown): string {
  const result = OpaqueIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Recorded interaction fixture publication route is invalid", result.error);
  }
  return result.data;
}

function publicationRequest(input: unknown): PublishInteractionFixtureVersionRequest {
  const result = PublishInteractionFixtureVersionRequestSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Recorded interaction fixture publication request is invalid", result.error);
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

function exactKeys(input: object, expected: readonly string[], message: string): boolean {
  try {
    const keys = Reflect.ownKeys(input);
    return (
      keys.length === expected.length && expected.every((expectedKey) => keys.includes(expectedKey))
    );
  } catch (cause) {
    throw new RegressionRepositoryContractError(message, { cause });
  }
}

function properties(input: object, keys: readonly string[], message: string): readonly unknown[] {
  try {
    return keys.map((key) => Reflect.get(input, key));
  } catch (cause) {
    throw new RegressionRepositoryContractError(message, { cause });
  }
}

function validateEvidencePredecessor(
  input: unknown,
  scope: ReturnType<typeof EvidenceScopeSchema.parse>,
  expectedVersionId: string,
): ValidatedRegressionFixtureVersionDefinition {
  let validated: ValidatedRegressionFixtureVersionDefinition;
  try {
    validated = validateAndProjectRegressionFixtureVersion(input);
  } catch (cause) {
    throw new RegressionRepositoryContractError(
      "Stored interaction fixture predecessor violates the repository contract",
      { cause },
    );
  }
  if (
    validated.version.fixtureVersionId !== expectedVersionId ||
    !sameScope(validated.version.scope, scope)
  ) {
    throw new RegressionRepositoryContractError(
      "Stored interaction fixture predecessor violates the repository contract",
    );
  }
  return validated;
}

interface ValidatedRecordedFixtureRecord {
  readonly ownerships: ReturnType<typeof ArtifactOwnershipSchema.parse>[];
  readonly validated: ValidatedRecordedInteractionFixtureVersionDefinition;
}

function validateRecordedFixtureRecord(
  input: unknown,
  scope: ReturnType<typeof EvidenceScopeSchema.parse>,
  expectedVersionId: string,
  message: string,
): ValidatedRecordedFixtureRecord {
  if (
    typeof input !== "object" ||
    input === null ||
    !exactKeys(input, ["ownerships", "version"], message)
  ) {
    throw new RegressionRepositoryContractError(message);
  }
  const [ownershipsInput, versionInput] = properties(input, ["ownerships", "version"], message);
  let validated: ValidatedRecordedInteractionFixtureVersionDefinition;
  try {
    validated = validateAndProjectRecordedInteractionFixtureVersion(versionInput);
  } catch (cause) {
    throw new RegressionRepositoryContractError(message, { cause });
  }
  if (
    validated.version.fixtureVersionId !== expectedVersionId ||
    !sameScope(validated.version.scope, scope) ||
    !Array.isArray(ownershipsInput) ||
    ownershipsInput.length !== validated.version.interactionCapture.artifacts.length
  ) {
    throw new RegressionRepositoryContractError(message);
  }

  const ownerships = ownershipsInput.map((ownershipInput, index) => {
    const result = ArtifactOwnershipSchema.safeParse(ownershipInput);
    const artifact = validated.version.interactionCapture.artifacts[index];
    if (
      !result.success ||
      artifact === undefined ||
      result.data.artifactId !== artifact.contentReference.artifactId ||
      result.data.boundAt !== validated.version.createdAt ||
      result.data.boundByPrincipalId !== validated.version.createdByPrincipalId ||
      result.data.owner.fixtureId !== validated.version.fixtureId ||
      result.data.owner.fixtureVersionId !== validated.version.fixtureVersionId ||
      !sameScope(result.data.scope, validated.version.scope)
    ) {
      throw new RegressionRepositoryContractError(message, {
        ...(result.success ? {} : { cause: result.error }),
      });
    }
    return result.data;
  });
  return { ownerships, validated };
}

function validatePublicationResult(
  input: unknown,
  scope: ReturnType<typeof EvidenceScopeSchema.parse>,
  expectedVersionId: string,
): { readonly created: boolean; readonly record: ValidatedRecordedFixtureRecord } {
  const message = "Published interaction fixture version violates the repository contract";
  if (
    typeof input !== "object" ||
    input === null ||
    !exactKeys(input, ["created", "ownerships", "version"], message)
  ) {
    throw new RegressionRepositoryContractError(message);
  }
  const [created, ownerships, version] = properties(
    input,
    ["created", "ownerships", "version"],
    message,
  );
  if (typeof created !== "boolean") throw new RegressionRepositoryContractError(message);
  return {
    created,
    record: validateRecordedFixtureRecord(
      { ownerships, version },
      scope,
      expectedVersionId,
      message,
    ),
  };
}

function isEquivalentRetry(
  fixtureRouteId: string,
  request: PublishInteractionFixtureVersionRequest,
  stored: RecordedInteractionFixtureVersion,
): boolean {
  return (
    stored.fixtureId === fixtureRouteId &&
    stored.name === request.name &&
    stored.description === request.description &&
    stored.predecessor.fixtureVersionId === request.predecessorVersionId &&
    isDeepStrictEqual(stored.interactionCapture, request.interactionCapture)
  );
}

function requireExactRetryResult(
  result: ReturnType<typeof validatePublicationResult>,
  stored: ValidatedRecordedFixtureRecord,
): PublishRecordedInteractionFixtureVersionResult {
  if (
    result.created ||
    !isDeepStrictEqual(result.record.validated.version, stored.validated.version) ||
    !isDeepStrictEqual(result.record.ownerships, stored.ownerships)
  ) {
    throw new RegressionRepositoryContractError(
      "Interaction fixture publication retry violates the repository contract",
    );
  }
  return {
    created: false,
    ownerships: result.record.ownerships,
    version: result.record.validated.version,
  };
}

function requireNewPublicationResult(
  result: ReturnType<typeof validatePublicationResult>,
  candidate: RecordedInteractionFixtureVersion,
  candidateDefinition: ReturnType<typeof RecordedInteractionFixtureVersionDefinitionSchema.parse>,
): PublishRecordedInteractionFixtureVersionResult {
  if (
    !areRecordedInteractionFixtureVersionDefinitionsEqual(
      result.record.validated.definition,
      candidateDefinition,
    ) ||
    (result.created && !isDeepStrictEqual(result.record.validated.version, candidate))
  ) {
    throw new RegressionRepositoryContractError(
      "Published interaction fixture version violates the repository contract",
    );
  }
  return {
    created: result.created,
    ownerships: result.record.ownerships,
    version: result.record.validated.version,
  };
}

function publicationTimestamp(clock: Clock): string {
  let timestamp: string;
  try {
    timestamp = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Recorded interaction fixture publication clock is invalid", cause);
  }
  const result = UtcMillisecondTimestampSchema.safeParse(timestamp);
  if (!result.success) {
    throw invalidInput("Recorded interaction fixture publication clock is invalid", result.error);
  }
  return result.data;
}

/** Publishes one exact recorded-interaction successor without rereading trace or artifact content. */
export class PublishRecordedInteractionFixtureVersion {
  constructor(
    private readonly dependencies: PublishRecordedInteractionFixtureVersionDependencies,
  ) {}

  async execute(
    command: PublishRecordedInteractionFixtureVersionCommand,
  ): Promise<PublishRecordedInteractionFixtureVersionResult> {
    const principal = publicationPrincipal(command.principal);
    requireCapability(principal, "dataset:manage");
    const projectId = command.projectId;
    const environmentId = command.environmentId;
    requireEnvironmentAccess(principal, projectId, environmentId);

    const scope = exactScope(principal, projectId, environmentId);
    const logicalFixtureId = fixtureId(command.fixtureId);
    const request = publicationRequest(command.request);
    const existingInput =
      await this.dependencies.versionRepository.findRecordedInteractionFixtureVersion(
        detached(scope),
        request.fixtureVersionId,
      );

    if (existingInput !== null) {
      const existing = validateRecordedFixtureRecord(
        existingInput,
        scope,
        request.fixtureVersionId,
        "Stored interaction fixture version violates the repository contract",
      );
      if (!isEquivalentRetry(logicalFixtureId, request, existing.validated.version)) {
        throw new RegressionVersionConflictError();
      }
      const rawResult =
        await this.dependencies.versionRepository.publishRecordedInteractionFixtureVersion(
          detached(existing.validated.version),
        );
      return requireExactRetryResult(
        validatePublicationResult(rawResult, scope, request.fixtureVersionId),
        existing,
      );
    }

    const evidenceCollision = await this.dependencies.versionRepository.findFixtureVersion(
      detached(scope),
      request.fixtureVersionId,
    );
    if (evidenceCollision !== null) throw new RegressionVersionConflictError();

    const predecessorInput = await this.dependencies.versionRepository.findFixtureVersion(
      detached(scope),
      request.predecessorVersionId,
    );
    if (predecessorInput === null) throw new RegressionVersionLineageError();
    const predecessor = validateEvidencePredecessor(
      predecessorInput,
      scope,
      request.predecessorVersionId,
    );
    if (predecessor.version.fixtureId !== logicalFixtureId) {
      throw new RegressionVersionLineageError();
    }

    const createdAt = publicationTimestamp(this.dependencies.clock);
    const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse({
      ...(request.description === undefined ? {} : { description: request.description }),
      fixtureId: logicalFixtureId,
      fixtureVersionId: request.fixtureVersionId,
      interactionCapture: request.interactionCapture,
      name: request.name,
      predecessor: {
        definitionSha256: predecessor.version.definitionSha256,
        fixtureVersionId: predecessor.version.fixtureVersionId,
      },
      replayability: "recorded_interactions",
      schemaVersion: RECORDED_INTERACTION_FIXTURE_VERSION_SCHEMA_VERSION,
      scope,
      source: predecessor.definition.source,
    });
    const candidateResult = RecordedInteractionFixtureVersionSchema.safeParse({
      ...definition,
      createdAt,
      createdByPrincipalId: principal.principalId,
      definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
      source: predecessor.version.source,
    });
    if (!candidateResult.success) {
      throw invalidInput(
        "Recorded interaction fixture publication candidate is invalid",
        candidateResult.error,
      );
    }
    const candidate = candidateResult.data;
    const rawResult =
      await this.dependencies.versionRepository.publishRecordedInteractionFixtureVersion(
        detached(candidate),
      );
    return requireNewPublicationResult(
      validatePublicationResult(rawResult, scope, request.fixtureVersionId),
      candidate,
      definition,
    );
  }
}
