import {
  EvidenceScopeSchema,
  PrincipalContextSchema,
  type EvidenceScope,
  type PrincipalContext,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import { ForbiddenError } from "../errors.js";

/** Execution is non-delegable and requires the separately configured service-token boundary. */
export function requirePolicyEvaluationExecution(
  actor: PrincipalContext,
  input: EvidenceScope,
): void {
  const principal = PrincipalContextSchema.parse(actor);
  requireCapability(principal, "policy:evaluation:execute");
  if (principal.principalType !== "service" || principal.authentication.method !== "service_token")
    throw new ForbiddenError("Policy execution requires a service-token worker principal");
  const scope = EvidenceScopeSchema.parse(input);
  if (principal.tenantId !== scope.tenantId)
    throw new ForbiddenError("Policy worker tenant does not match job scope");
  requireEnvironmentAccess(principal, scope.projectId, scope.environmentId);
}
