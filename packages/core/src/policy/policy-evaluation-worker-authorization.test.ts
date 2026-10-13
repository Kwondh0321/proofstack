import { describe, expect, it } from "vitest";
import {
  PrincipalContextSchema,
  WorkloadCapabilitySchema,
  type EvidenceScope,
  type PrincipalContext,
  type WorkloadCapability,
} from "@proofstack/contracts";
import { requireWorkloadDelegation } from "../auth/workload-delegation.js";
import { ForbiddenError } from "../errors.js";
import { requirePolicyEvaluationExecution } from "./policy-evaluation-worker-authorization.js";

const scope: EvidenceScope = {
  tenantId: "tenant_policy",
  projectId: "project_policy",
  environmentId: "environment_policy",
};
function worker(overrides: Partial<PrincipalContext> = {}) {
  return PrincipalContextSchema.parse({
    principalId: "worker_policy",
    principalType: "service",
    tenantId: scope.tenantId,
    authentication: {
      method: "service_token",
      credentialId: "credential_worker",
      authenticatedAt: "2026-10-13T20:00:00.000Z",
    },
    capabilities: ["policy:evaluation:execute"],
    roles: ["member"],
    requestId: "request_worker",
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
    ...overrides,
  });
}
describe("separate non-delegable policy execution authority", () => {
  it("allows only an explicitly capable service-token worker in its exact scope", () => {
    expect(() => requirePolicyEvaluationExecution(worker(), scope)).not.toThrow();
  });
  it.each([
    "policy:evaluate",
    "policy:author",
    "policy:read",
    "evaluation:run",
    "evaluation:model:run",
    "evaluation:human:review",
    "policy:evaluation:cancel",
  ] as const)("does not substitute %s for execution", (capability) => {
    expect(() =>
      requirePolicyEvaluationExecution(worker({ capabilities: [capability] }), scope),
    ).toThrow(ForbiddenError);
  });
  it.each(["user", "workload"] as const)(
    "rejects %s even with a forged execution capability",
    (principalType) => {
      expect(() => requirePolicyEvaluationExecution(worker({ principalType }), scope)).toThrow(
        ForbiddenError,
      );
    },
  );
  it.each(["development", "api_key", "oidc"] as const)(
    "rejects service authentication substitution: %s",
    (method) => {
      expect(() =>
        requirePolicyEvaluationExecution(
          worker({
            authentication: {
              method,
              credentialId: "credential_other",
              authenticatedAt: "2026-10-13T20:00:00.000Z",
            },
          }),
          scope,
        ),
      ).toThrow(ForbiddenError);
    },
  );
  it.each(["tenantId", "projectId", "environmentId"] as const)("denies an outside %s", (field) => {
    expect(() =>
      requirePolicyEvaluationExecution(worker(), { ...scope, [field]: "outside_scope" }),
    ).toThrow(ForbiddenError);
  });
  it("checks capability and principal boundary before malformed job scope", () => {
    const malformed = { tenantId: "bad" } as unknown as EvidenceScope;
    expect(() => requirePolicyEvaluationExecution(worker({ capabilities: [] }), malformed)).toThrow(
      ForbiddenError,
    );
    expect(() =>
      requirePolicyEvaluationExecution(worker({ principalType: "user" }), malformed),
    ).toThrow(ForbiddenError);
  });
  it("cannot delegate execution even from an issuer that holds it", () => {
    expect(WorkloadCapabilitySchema.safeParse("policy:evaluation:execute").success).toBe(false);
    expect(WorkloadCapabilitySchema.safeParse("policy:evaluation:cancel").success).toBe(true);
    const issuer = worker({
      principalType: "user",
      capabilities: ["identity:manage", "policy:evaluation:execute"],
    });
    expect(() =>
      requireWorkloadDelegation(
        issuer,
        ["policy:evaluation:execute" as WorkloadCapability],
        issuer.resourceScope,
      ),
    ).toThrow(ForbiddenError);
  });
});
