import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type RegressionFixtureVersion,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { validateAndProjectRegressionFixtureVersion } from "./regression-version-definition.js";
import type { RegressionVersionRepository } from "./regression-version-repository.js";

export interface ReadRegressionFixtureVersionCommand {
  readonly environmentId: string;
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

function invalidInput(message: string, cause: unknown): InvalidRegressionVersionInputError {
  return new InvalidRegressionVersionInputError(message, { cause });
}

function readPrincipal(input: unknown): PrincipalContext {
  try {
    return PrincipalContextSchema.parse(input);
  } catch (cause) {
    throw invalidInput("Regression fixture read principal is invalid", cause);
  }
}

function readIdentifier(input: unknown, field: string): string {
  const parsed = OpaqueIdSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(`Regression fixture read ${field} is invalid`, parsed.error);
  }
  return parsed.data;
}

function sameScope(
  left: RegressionFixtureVersion["scope"],
  right: RegressionFixtureVersion["scope"],
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

/** Reads one exact immutable fixture version without exposing cross-resource or cross-scope state. */
export class ReadRegressionFixtureVersion {
  constructor(private readonly repository: RegressionVersionRepository) {}

  async execute(command: ReadRegressionFixtureVersionCommand): Promise<RegressionFixtureVersion> {
    const principal = readPrincipal(command.principal);
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
      throw invalidInput("Regression fixture read scope is invalid", scope.error);
    }
    const fixtureId = readIdentifier(command.fixtureId, "fixtureId");
    const fixtureVersionId = readIdentifier(command.fixtureVersionId, "fixtureVersionId");
    const stored = await this.repository.findFixtureVersion(
      structuredClone(scope.data),
      fixtureVersionId,
    );
    if (stored === null) throw new RegressionVersionNotFoundError();

    let version: RegressionFixtureVersion;
    try {
      version = validateAndProjectRegressionFixtureVersion(stored).version;
    } catch (cause) {
      throw new RegressionRepositoryContractError(
        "The regression repository returned an invalid fixture version",
        { cause },
      );
    }
    if (version.fixtureVersionId !== fixtureVersionId || !sameScope(version.scope, scope.data)) {
      throw new RegressionRepositoryContractError(
        "The regression repository substituted a fixture version outside the exact query",
      );
    }
    if (version.fixtureId !== fixtureId) throw new RegressionVersionNotFoundError();
    return structuredClone(version);
  }
}
