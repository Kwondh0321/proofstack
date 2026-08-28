import type { Capability, PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "../errors.js";

export function requireCapability(
  principal: PrincipalContext,
  requiredCapability: Capability,
): void {
  if (!principal.capabilities.includes(requiredCapability)) {
    throw new ForbiddenError(`Missing required capability: ${requiredCapability}`);
  }
}

export function requireProjectAccess(principal: PrincipalContext, projectId: string): void {
  if (
    principal.resourceScope.mode === "restricted" &&
    !principal.resourceScope.projectIds.includes(projectId)
  ) {
    throw new ForbiddenError(`Principal cannot access project: ${projectId}`);
  }
}
