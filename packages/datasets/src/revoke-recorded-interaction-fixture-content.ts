import { isDeepStrictEqual } from "node:util";
import {
  ArtifactTombstoneSchema,
  EvidenceScopeSchema,
  InteractionFixtureContentRevocationSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type RevokeInteractionFixtureContentRequest,
  RevokeInteractionFixtureContentRequestSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import {
  InvalidRegressionVersionInputError,
  RegressionFixtureContentRevocationConflictError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { validateStoredInteractionFixtureContent } from "./recorded-interaction-fixture-content.js";
import type {
  InteractionFixtureVersionRepository,
  RevokeInteractionFixtureContentCandidate,
  RevokeInteractionFixtureContentResult,
} from "./regression-version-repository.js";

export interface RevokeRecordedInteractionFixtureContentCommand {
  readonly environmentId: string;
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: RevokeInteractionFixtureContentRequest;
}

export interface InteractionFixtureRevocationIdentityGenerator {
  generateArtifactTombstoneId(artifactId: string): string;
  generateRevocationId(): string;
}

export interface RevokeRecordedInteractionFixtureContentDependencies {
  readonly clock: Clock;
  readonly identities: InteractionFixtureRevocationIdentityGenerator;
  readonly versionRepository: InteractionFixtureVersionRepository;
}

function invalidInput(message: string, cause: unknown): InvalidRegressionVersionInputError {
  return new InvalidRegressionVersionInputError(message, { cause });
}

function detached<Value>(value: Value): Value {
  return structuredClone(value);
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
    throw invalidInput("Interaction fixture content revocation scope is invalid", result.error);
  }
  return result.data;
}

function routeId(input: unknown, message: string): string {
  const result = OpaqueIdSchema.safeParse(input);
  if (!result.success) throw invalidInput(message, result.error);
  return result.data;
}

function exactKeys(input: object, expected: readonly string[], message: string): boolean {
  try {
    const keys = Reflect.ownKeys(input);
    return keys.length === expected.length && expected.every((key) => keys.includes(key));
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

function validateRevocationResult(
  input: unknown,
  scope: ReturnType<typeof EvidenceScopeSchema.parse>,
  expectedVersionId: string,
): RevokeInteractionFixtureContentResult {
  const message = "Revoked interaction fixture content violates the repository contract";
  const keys = [
    "contentAvailability",
    "created",
    "ownerships",
    "revocation",
    "tombstones",
    "version",
  ];
  if (typeof input !== "object" || input === null || !exactKeys(input, keys, message)) {
    throw new RegressionRepositoryContractError(message);
  }
  const [contentAvailability, created, ownerships, revocation, tombstones, version] = properties(
    input,
    keys,
    message,
  );
  if (typeof created !== "boolean") throw new RegressionRepositoryContractError(message);
  return {
    created,
    ...validateStoredInteractionFixtureContent(
      { contentAvailability, ownerships, revocation, tombstones, version },
      scope,
      expectedVersionId,
      message,
    ),
  };
}

function revocationTimestamp(clock: Clock): string {
  let timestamp: string;
  try {
    timestamp = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Interaction fixture content revocation clock is invalid", cause);
  }
  const result = UtcMillisecondTimestampSchema.safeParse(timestamp);
  if (!result.success) {
    throw invalidInput("Interaction fixture content revocation clock is invalid", result.error);
  }
  return result.data;
}

/** Revokes the complete captured content set without rewriting the immutable fixture definition. */
export class RevokeRecordedInteractionFixtureContent {
  constructor(private readonly dependencies: RevokeRecordedInteractionFixtureContentDependencies) {}

  async execute(
    command: RevokeRecordedInteractionFixtureContentCommand,
  ): Promise<RevokeInteractionFixtureContentResult> {
    const principalResult = PrincipalContextSchema.safeParse(command.principal);
    if (!principalResult.success) {
      throw invalidInput(
        "Interaction fixture content revocation principal is invalid",
        principalResult.error,
      );
    }
    const principal = principalResult.data;
    requireCapability(principal, "dataset:manage");
    requireCapability(principal, "artifact:delete");
    const projectId = command.projectId;
    const environmentId = command.environmentId;
    requireEnvironmentAccess(principal, projectId, environmentId);

    const scope = exactScope(principal, projectId, environmentId);
    const fixtureId = routeId(
      command.fixtureId,
      "Interaction fixture content revocation route is invalid",
    );
    const fixtureVersionId = routeId(
      command.fixtureVersionId,
      "Interaction fixture content revocation route is invalid",
    );
    const request = RevokeInteractionFixtureContentRequestSchema.safeParse(command.request);
    if (!request.success) {
      throw invalidInput(
        "Interaction fixture content revocation request is invalid",
        request.error,
      );
    }
    const storedInput =
      await this.dependencies.versionRepository.findRecordedInteractionFixtureContent(
        detached(scope),
        fixtureVersionId,
      );
    if (storedInput === null) throw new RegressionVersionNotFoundError();
    const stored = validateStoredInteractionFixtureContent(
      storedInput,
      scope,
      fixtureVersionId,
      "Stored interaction fixture content violates the repository contract",
    );
    if (stored.version.fixtureId !== fixtureId) throw new RegressionVersionConflictError();

    if (stored.revocation !== null) {
      if (stored.revocation.reason !== request.data.reason) {
        throw new RegressionFixtureContentRevocationConflictError();
      }
      const result = validateRevocationResult(
        await this.dependencies.versionRepository.revokeRecordedInteractionFixtureContent({
          revocation: detached(stored.revocation),
          tombstones: detached(stored.tombstones),
        }),
        scope,
        fixtureVersionId,
      );
      if (result.created || !isDeepStrictEqual(result, { ...stored, created: false })) {
        throw new RegressionRepositoryContractError(
          "Interaction fixture content revocation retry violates the repository contract",
        );
      }
      return result;
    }

    const revokedAt = revocationTimestamp(this.dependencies.clock);
    let candidate: RevokeInteractionFixtureContentCandidate;
    try {
      const revocation = InteractionFixtureContentRevocationSchema.parse({
        fixtureId,
        fixtureVersionId,
        reason: request.data.reason,
        revocationId: this.dependencies.identities.generateRevocationId(),
        revokedAt,
        revokedByPrincipalId: principal.principalId,
        schemaVersion: "0.1",
        scope,
      });
      const tombstones = stored.ownerships.map((ownership) =>
        ArtifactTombstoneSchema.parse({
          actorPrincipalId: principal.principalId,
          artifactId: ownership.artifactId,
          occurredAt: revokedAt,
          reason: request.data.reason,
          tombstoneId: this.dependencies.identities.generateArtifactTombstoneId(
            ownership.artifactId,
          ),
          trigger: "fixture_revocation",
        }),
      );
      candidate = { revocation, tombstones };
    } catch (cause) {
      throw invalidInput("Interaction fixture content revocation identity is invalid", cause);
    }
    const result = validateRevocationResult(
      await this.dependencies.versionRepository.revokeRecordedInteractionFixtureContent(
        detached(candidate),
      ),
      scope,
      fixtureVersionId,
    );
    if (
      result.contentAvailability !== "revoked" ||
      result.revocation === null ||
      (result.created &&
        (!isDeepStrictEqual(result.revocation, candidate.revocation) ||
          !isDeepStrictEqual(result.tombstones, candidate.tombstones)))
    ) {
      throw new RegressionRepositoryContractError(
        "Revoked interaction fixture content violates the repository contract",
      );
    }
    return result;
  }
}
