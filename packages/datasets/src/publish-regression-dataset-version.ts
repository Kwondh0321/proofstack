import { isDeepStrictEqual } from "node:util";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type PublishRegressionDatasetVersionRequest,
  PublishRegressionDatasetVersionRequestSchema,
  REGRESSION_DATASET_VERSION_SCHEMA_VERSION,
  type RegressionDatasetVersion,
  type RegressionDatasetVersionDefinition,
  RegressionDatasetVersionDefinitionSchema,
  RegressionDatasetVersionSchema,
  type RegressionFixtureVersionReference,
  RegressionFixtureVersionReferenceSchema,
  type RequestedRegressionFixtureVersionReference,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { digestRegressionDatasetVersionDefinition } from "./regression-definition-digest.js";
import {
  areRegressionDatasetVersionDefinitionsEqual,
  validateAndProjectRegressionDatasetVersion,
} from "./regression-version-definition.js";
import type {
  PublishRegressionVersionResult,
  RegressionVersionRepository,
} from "./regression-version-repository.js";

export interface PublishRegressionDatasetVersionCommand {
  readonly datasetId: string;
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: PublishRegressionDatasetVersionRequest;
}

export interface PublishRegressionDatasetVersionDependencies {
  readonly clock: Clock;
  readonly versionRepository: RegressionVersionRepository;
}

export type PublishRegressionDatasetVersionResult =
  PublishRegressionVersionResult<RegressionDatasetVersion>;

interface ValidatedPublicationResult {
  readonly created: boolean;
  readonly definition: RegressionDatasetVersionDefinition;
  readonly version: RegressionDatasetVersion;
}

function scopesEqual(
  left: RegressionDatasetVersion["scope"],
  right: RegressionDatasetVersion["scope"],
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function repositoryContract(message: string, cause?: unknown): RegressionRepositoryContractError {
  return new RegressionRepositoryContractError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function publicationPrincipal(input: unknown): PrincipalContext {
  try {
    return PrincipalContextSchema.parse(input);
  } catch (cause) {
    throw new InvalidRegressionVersionInputError(
      "Regression dataset publication principal is invalid",
      { cause },
    );
  }
}

function validateRepositoryVersion(
  input: unknown,
  scope: RegressionDatasetVersion["scope"],
  datasetVersionId: string,
): ReturnType<typeof validateAndProjectRegressionDatasetVersion> {
  let validated: ReturnType<typeof validateAndProjectRegressionDatasetVersion>;
  try {
    validated = validateAndProjectRegressionDatasetVersion(input);
  } catch (cause) {
    throw repositoryContract(
      "The regression repository returned an invalid dataset version",
      cause,
    );
  }

  if (
    validated.version.datasetVersionId !== datasetVersionId ||
    !scopesEqual(validated.version.scope, scope)
  ) {
    throw repositoryContract(
      "The regression repository substituted a dataset version outside the exact query",
    );
  }
  return validated;
}

function hasExactResultShape(input: object): boolean {
  try {
    const keys = Reflect.ownKeys(input);
    return keys.length === 2 && keys.includes("created") && keys.includes("version");
  } catch {
    return false;
  }
}

function validatePublicationResult(
  input: unknown,
  scope: RegressionDatasetVersion["scope"],
  datasetVersionId: string,
): ValidatedPublicationResult {
  if (typeof input !== "object" || input === null || !hasExactResultShape(input)) {
    throw repositoryContract("The regression repository returned an invalid publication result");
  }

  let created: unknown;
  let version: unknown;
  try {
    created = Reflect.get(input, "created");
    version = Reflect.get(input, "version");
  } catch (cause) {
    throw repositoryContract(
      "The regression repository returned an unreadable publication result",
      cause,
    );
  }
  if (typeof created !== "boolean") {
    throw repositoryContract("The regression repository returned an invalid creation marker");
  }

  const validated = validateRepositoryVersion(version, scope, datasetVersionId);
  return { created, ...validated };
}

function requestMatchesExistingVersion(
  request: PublishRegressionDatasetVersionRequest,
  version: RegressionDatasetVersion,
): boolean {
  if (
    request.name !== version.name ||
    request.description !== version.description ||
    request.predecessorVersionId !== version.predecessor?.datasetVersionId ||
    request.fixtureVersions.length !== version.fixtureVersions.length
  ) {
    return false;
  }
  return request.fixtureVersions.every((reference, index) => {
    const stored = version.fixtureVersions[index];
    return (
      stored !== undefined &&
      reference.fixtureId === stored.fixtureId &&
      reference.fixtureVersionId === stored.fixtureVersionId
    );
  });
}

function validateResolvedReferences(
  input: unknown,
  requested: readonly RequestedRegressionFixtureVersionReference[],
): readonly RegressionFixtureVersionReference[] {
  try {
    if (!Array.isArray(input) || input.length !== requested.length) {
      throw repositoryContract(
        "The regression repository returned an incomplete fixture reference resolution",
      );
    }

    const resolved: RegressionFixtureVersionReference[] = [];
    for (let index = 0; index < requested.length; index += 1) {
      const value = Reflect.get(input, index);
      const parsed = RegressionFixtureVersionReferenceSchema.safeParse(value);
      if (!parsed.success) {
        throw repositoryContract(
          "The regression repository returned an invalid fixture version reference",
          parsed.error,
        );
      }
      const expected = requested[index] as RequestedRegressionFixtureVersionReference;
      if (
        parsed.data.fixtureId !== expected.fixtureId ||
        parsed.data.fixtureVersionId !== expected.fixtureVersionId
      ) {
        throw repositoryContract(
          "The regression repository reordered or substituted a fixture version reference",
        );
      }
      resolved.push(parsed.data);
    }
    return resolved;
  } catch (cause) {
    if (cause instanceof RegressionRepositoryContractError) throw cause;
    throw repositoryContract(
      "The regression repository returned an unreadable fixture reference resolution",
      cause,
    );
  }
}

function publicationTimestamp(clock: Clock): string {
  try {
    return clock.now().toISOString();
  } catch (cause) {
    throw new InvalidRegressionVersionInputError(
      "Regression dataset publication clock is invalid",
      { cause },
    );
  }
}

function buildCandidate(
  datasetId: string,
  createdByPrincipalId: string,
  scope: RegressionDatasetVersion["scope"],
  request: PublishRegressionDatasetVersionRequest,
  fixtureVersions: readonly RegressionFixtureVersionReference[],
  predecessor: RegressionDatasetVersion["predecessor"],
  createdAt: string,
): RegressionDatasetVersion {
  try {
    const definition = RegressionDatasetVersionDefinitionSchema.parse({
      datasetId,
      datasetVersionId: request.datasetVersionId,
      ...(request.description === undefined ? {} : { description: request.description }),
      fixtureVersions,
      name: request.name,
      ...(predecessor === undefined ? {} : { predecessor }),
      schemaVersion: REGRESSION_DATASET_VERSION_SCHEMA_VERSION,
      scope,
    });
    return RegressionDatasetVersionSchema.parse({
      createdAt,
      createdByPrincipalId,
      definitionSha256: digestRegressionDatasetVersionDefinition(definition),
      ...definition,
    });
  } catch (cause) {
    throw new InvalidRegressionVersionInputError("Regression dataset version is invalid", {
      cause,
    });
  }
}

export class PublishRegressionDatasetVersion {
  constructor(private readonly dependencies: PublishRegressionDatasetVersionDependencies) {}

  async execute(
    command: PublishRegressionDatasetVersionCommand,
  ): Promise<PublishRegressionDatasetVersionResult> {
    const principal = publicationPrincipal(command.principal);
    requireCapability(principal, "dataset:manage");
    const projectId = command.projectId;
    const environmentId = command.environmentId;
    requireEnvironmentAccess(principal, projectId, environmentId);

    const datasetId = OpaqueIdSchema.safeParse(command.datasetId);
    const request = PublishRegressionDatasetVersionRequestSchema.safeParse(command.request);
    const scope = EvidenceScopeSchema.safeParse({
      environmentId,
      projectId,
      tenantId: principal.tenantId,
    });
    if (!datasetId.success || !request.success || !scope.success) {
      throw new InvalidRegressionVersionInputError(
        "Regression dataset publication request is invalid",
        request.success && scope.success
          ? undefined
          : { cause: request.success ? scope.error : request.error },
      );
    }
    const authorizedScope = structuredClone(scope.data);
    const createdByPrincipalId = principal.principalId;

    const existingInput = await this.dependencies.versionRepository.findDatasetVersion(
      structuredClone(authorizedScope),
      request.data.datasetVersionId,
    );
    if (existingInput !== null) {
      const existing = validateRepositoryVersion(
        existingInput,
        authorizedScope,
        request.data.datasetVersionId,
      );
      if (
        existing.version.datasetId !== datasetId.data ||
        !requestMatchesExistingVersion(request.data, existing.version)
      ) {
        throw new RegressionVersionConflictError();
      }

      const retryInput = structuredClone(existing.version);
      const retryOutput =
        await this.dependencies.versionRepository.publishDatasetVersion(retryInput);
      const retry = validatePublicationResult(
        retryOutput,
        authorizedScope,
        request.data.datasetVersionId,
      );
      if (retry.created || !isDeepStrictEqual(retry.version, existing.version)) {
        throw repositoryContract(
          "An identical dataset publication retry did not return the original stored version",
        );
      }
      return { created: false, version: retry.version };
    }

    let predecessor: RegressionDatasetVersion["predecessor"];
    if (request.data.predecessorVersionId !== undefined) {
      const predecessorInput = await this.dependencies.versionRepository.findDatasetVersion(
        structuredClone(authorizedScope),
        request.data.predecessorVersionId,
      );
      if (predecessorInput === null) throw new RegressionVersionLineageError();
      const authoritative = validateRepositoryVersion(
        predecessorInput,
        authorizedScope,
        request.data.predecessorVersionId,
      ).version;
      if (authoritative.datasetId !== datasetId.data) {
        throw new RegressionVersionLineageError();
      }
      predecessor = {
        datasetVersionId: authoritative.datasetVersionId,
        definitionSha256: authoritative.definitionSha256,
      };
    } else {
      const resourceExists = await this.dependencies.versionRepository.datasetResourceExists(
        structuredClone(authorizedScope),
        datasetId.data,
      );
      if (typeof resourceExists !== "boolean") {
        throw repositoryContract(
          "The regression repository returned an invalid dataset resource existence result",
        );
      }
      if (resourceExists) throw new RegressionVersionLineageError();
    }

    const requestedFixtureVersions = request.data.fixtureVersions.map((reference) => ({
      ...reference,
    }));
    const resolution = await this.dependencies.versionRepository.resolveFixtureVersionReferences(
      structuredClone(authorizedScope),
      structuredClone(requestedFixtureVersions),
    );
    if (resolution === null) throw new RegressionVersionNotFoundError();
    const fixtureVersions = validateResolvedReferences(resolution, requestedFixtureVersions);
    const createdAt = publicationTimestamp(this.dependencies.clock);
    const candidate = buildCandidate(
      datasetId.data,
      createdByPrincipalId,
      authorizedScope,
      request.data,
      fixtureVersions,
      predecessor,
      createdAt,
    );

    const candidateDefinition = validateAndProjectRegressionDatasetVersion(candidate).definition;
    const output = await this.dependencies.versionRepository.publishDatasetVersion(
      structuredClone(candidate),
    );
    const publication = validatePublicationResult(
      output,
      authorizedScope,
      request.data.datasetVersionId,
    );
    if (
      publication.version.datasetId !== datasetId.data ||
      !areRegressionDatasetVersionDefinitionsEqual(publication.definition, candidateDefinition) ||
      (publication.created && !isDeepStrictEqual(publication.version, candidate))
    ) {
      throw repositoryContract(
        "The regression repository returned a dataset publication outside the requested definition",
      );
    }
    return { created: publication.created, version: publication.version };
  }
}
