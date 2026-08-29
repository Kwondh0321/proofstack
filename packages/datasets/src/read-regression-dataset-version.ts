import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type RegressionDatasetVersion,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { validateAndProjectRegressionDatasetVersion } from "./regression-version-definition.js";
import type { RegressionVersionRepository } from "./regression-version-repository.js";

export interface ReadRegressionDatasetVersionCommand {
  readonly datasetId: string;
  readonly datasetVersionId: string;
  readonly environmentId: string;
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
    throw invalidInput("Regression dataset read principal is invalid", cause);
  }
}

function readIdentifier(input: unknown, field: string): string {
  const parsed = OpaqueIdSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(`Regression dataset read ${field} is invalid`, parsed.error);
  }
  return parsed.data;
}

function sameScope(
  left: RegressionDatasetVersion["scope"],
  right: RegressionDatasetVersion["scope"],
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

/** Reads one exact immutable dataset version without exposing cross-resource or cross-scope state. */
export class ReadRegressionDatasetVersion {
  constructor(private readonly repository: RegressionVersionRepository) {}

  async execute(command: ReadRegressionDatasetVersionCommand): Promise<RegressionDatasetVersion> {
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
      throw invalidInput("Regression dataset read scope is invalid", scope.error);
    }
    const datasetId = readIdentifier(command.datasetId, "datasetId");
    const datasetVersionId = readIdentifier(command.datasetVersionId, "datasetVersionId");
    const stored = await this.repository.findDatasetVersion(
      structuredClone(scope.data),
      datasetVersionId,
    );
    if (stored === null) throw new RegressionVersionNotFoundError();

    let version: RegressionDatasetVersion;
    try {
      version = validateAndProjectRegressionDatasetVersion(stored).version;
    } catch (cause) {
      throw new RegressionRepositoryContractError(
        "The regression repository returned an invalid dataset version",
        { cause },
      );
    }
    if (version.datasetVersionId !== datasetVersionId || !sameScope(version.scope, scope.data)) {
      throw new RegressionRepositoryContractError(
        "The regression repository substituted a dataset version outside the exact query",
      );
    }
    if (version.datasetId !== datasetId) throw new RegressionVersionNotFoundError();
    return structuredClone(version);
  }
}
