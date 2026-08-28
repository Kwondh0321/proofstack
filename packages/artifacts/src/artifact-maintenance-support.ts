import {
  EvidenceScopeSchema,
  type EvidenceScope,
  type PrincipalContext,
  TimestampSchema,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import { InvalidArtifactLifecycleInputError } from "./errors.js";

export const MIN_ABANDONED_RESERVATION_AGE_MS = 60 * 60 * 1_000;

export interface ArtifactMaintenanceScopeCommand {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export function artifactMaintenanceScope(command: ArtifactMaintenanceScopeCommand): EvidenceScope {
  requireCapability(command.principal, "artifact:delete");
  requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);
  const scope = EvidenceScopeSchema.safeParse({
    environmentId: command.environmentId,
    projectId: command.projectId,
    tenantId: command.principal.tenantId,
  });
  if (!scope.success) {
    throw new InvalidArtifactLifecycleInputError("Artifact maintenance scope is invalid", {
      cause: scope.error,
    });
  }
  return scope.data;
}

export function artifactMaintenanceTimestamp(clock: Clock, message: string): string {
  try {
    return clock.now().toISOString();
  } catch (error) {
    throw new InvalidArtifactLifecycleInputError(message, { cause: error });
  }
}

export function artifactAbandonedThreshold(value: string, occurredAt: string): string {
  const threshold = TimestampSchema.safeParse(value);
  if (
    !threshold.success ||
    Date.parse(threshold.data) > Date.parse(occurredAt) - MIN_ABANDONED_RESERVATION_AGE_MS
  ) {
    throw new InvalidArtifactLifecycleInputError(
      "Abandoned reservation threshold must be at least one hour in the past",
      threshold.success ? undefined : { cause: threshold.error },
    );
  }
  return new Date(threshold.data).toISOString();
}
