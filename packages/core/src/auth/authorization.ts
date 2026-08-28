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
    !principal.resourceScope.projects.some((project) => project.projectId === projectId)
  ) {
    throw new ForbiddenError(`Principal cannot access project: ${projectId}`);
  }
}

export function requireEnvironmentAccess(
  principal: PrincipalContext,
  projectId: string,
  environmentId: string,
): void {
  requireProjectAccess(principal, projectId);
  if (principal.resourceScope.mode === "tenant") return;

  const projectScope = principal.resourceScope.projects.find(
    (project) => project.projectId === projectId,
  );
  if (projectScope?.environmentIds && !projectScope.environmentIds.includes(environmentId)) {
    throw new ForbiddenError(`Principal cannot access environment: ${environmentId}`);
  }
}
