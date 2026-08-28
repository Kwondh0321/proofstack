import {
  type PrincipalContext,
  type ResourceScope,
  type WorkloadCapability,
  WorkloadCapabilitySchema,
} from "@proofstack/contracts";
import { ForbiddenError } from "../errors.js";
import { requireCapability } from "./authorization.js";

export function canDelegateResourceScope(
  issuerScope: ResourceScope,
  requestedScope: ResourceScope,
): boolean {
  if (issuerScope.mode === "tenant") return true;
  if (requestedScope.mode === "tenant") return false;

  return requestedScope.projects.every((requestedProject) => {
    const issuerProject = issuerScope.projects.find(
      ({ projectId }) => projectId === requestedProject.projectId,
    );
    if (!issuerProject) return false;
    if (!issuerProject.environmentIds) return true;
    if (!requestedProject.environmentIds) return false;
    return requestedProject.environmentIds.every((environmentId) =>
      issuerProject.environmentIds?.includes(environmentId),
    );
  });
}

export function requireWorkloadDelegation(
  issuer: PrincipalContext,
  requestedCapabilities: readonly WorkloadCapability[],
  requestedScope: ResourceScope,
): void {
  requireCapability(issuer, "identity:manage");
  if (issuer.principalType !== "user") {
    throw new ForbiddenError("Only a user principal can delegate workload credentials");
  }
  if (
    requestedCapabilities.length === 0 ||
    new Set(requestedCapabilities).size !== requestedCapabilities.length ||
    requestedCapabilities.some(
      (capability) => !WorkloadCapabilitySchema.safeParse(capability).success,
    )
  ) {
    throw new ForbiddenError("Requested workload capabilities are invalid");
  }
  if (requestedCapabilities.some((capability) => !issuer.capabilities.includes(capability))) {
    throw new ForbiddenError("A workload cannot receive a capability its issuer does not hold");
  }
  if (!canDelegateResourceScope(issuer.resourceScope, requestedScope)) {
    throw new ForbiddenError("A workload cannot receive a resource scope broader than its issuer");
  }
}
