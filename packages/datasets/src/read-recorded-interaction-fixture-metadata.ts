import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import { InvalidRegressionVersionInputError, RegressionVersionNotFoundError } from "./errors.js";
import { validateStoredInteractionFixtureContent } from "./recorded-interaction-fixture-content.js";
import type {
  InteractionFixtureVersionRepository,
  StoredInteractionFixtureContent,
} from "./regression-version-repository.js";

export interface ReadRecordedInteractionFixtureMetadataCommand {
  readonly environmentId: string;
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

function invalidInput(message: string, cause: unknown): InvalidRegressionVersionInputError {
  return new InvalidRegressionVersionInputError(message, { cause });
}

function routeId(input: unknown, field: string): string {
  const result = OpaqueIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput(`Recorded interaction fixture read ${field} is invalid`, result.error);
  }
  return result.data;
}

/** Reads fixture metadata, ownership, and availability without crossing the plaintext boundary. */
export class ReadRecordedInteractionFixtureMetadata {
  constructor(private readonly repository: InteractionFixtureVersionRepository) {}

  async execute(
    command: ReadRecordedInteractionFixtureMetadataCommand,
  ): Promise<StoredInteractionFixtureContent> {
    const principalResult = PrincipalContextSchema.safeParse(command.principal);
    if (!principalResult.success) {
      throw invalidInput(
        "Recorded interaction fixture read principal is invalid",
        principalResult.error,
      );
    }
    const principal = principalResult.data;
    requireCapability(principal, "dataset:read");
    const projectId = command.projectId;
    const environmentId = command.environmentId;
    requireEnvironmentAccess(principal, projectId, environmentId);

    const scope = EvidenceScopeSchema.safeParse({
      environmentId,
      projectId,
      tenantId: principal.tenantId,
    });
    if (!scope.success) {
      throw invalidInput("Recorded interaction fixture read scope is invalid", scope.error);
    }
    const fixtureId = routeId(command.fixtureId, "fixtureId");
    const fixtureVersionId = routeId(command.fixtureVersionId, "fixtureVersionId");
    const storedInput = await this.repository.findRecordedInteractionFixtureContent(
      structuredClone(scope.data),
      fixtureVersionId,
    );
    if (storedInput === null) throw new RegressionVersionNotFoundError();
    const stored = validateStoredInteractionFixtureContent(
      storedInput,
      scope.data,
      fixtureVersionId,
      "Stored interaction fixture content violates the repository contract",
    );
    if (stored.version.fixtureId !== fixtureId) throw new RegressionVersionNotFoundError();
    return structuredClone(stored);
  }
}
