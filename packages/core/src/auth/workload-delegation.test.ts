import {
  type PrincipalContext,
  PrincipalContextSchema,
  type ResourceScope,
  type WorkloadCapability,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../errors.js";
import { canDelegateResourceScope, requireWorkloadDelegation } from "./workload-delegation.js";

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-28T06:00:00.000Z",
      credentialId: "ses_delegation",
      method: "oidc",
    },
    capabilities: ["identity:manage", "evidence:ingest", "evidence:read"],
    principalId: "usr_delegation",
    principalType: "user",
    requestId: "req_delegation",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: "ten_delegation",
    ...overrides,
  });
}

const restricted: ResourceScope = {
  mode: "restricted",
  projects: [
    { environmentIds: ["env_dev", "env_prod"], projectId: "prj_scoped" },
    { projectId: "prj_all_environments" },
  ],
};

const invalidCapabilitySets: readonly (readonly WorkloadCapability[])[] = [
  [],
  ["evidence:ingest", "evidence:ingest"],
  ["identity:manage" as WorkloadCapability],
];

describe("canDelegateResourceScope", () => {
  it("allows a tenant principal to narrow or retain its scope", () => {
    expect(canDelegateResourceScope({ mode: "tenant" }, { mode: "tenant" })).toBe(true);
    expect(canDelegateResourceScope({ mode: "tenant" }, restricted)).toBe(true);
  });

  it("prevents a restricted principal from delegating tenant-wide access", () => {
    expect(canDelegateResourceScope(restricted, { mode: "tenant" })).toBe(false);
  });

  it("allows exact and narrower project and environment restrictions", () => {
    expect(canDelegateResourceScope(restricted, restricted)).toBe(true);
    expect(
      canDelegateResourceScope(restricted, {
        mode: "restricted",
        projects: [
          { environmentIds: ["env_dev"], projectId: "prj_scoped" },
          { environmentIds: ["env_any"], projectId: "prj_all_environments" },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    {
      mode: "restricted" as const,
      projects: [{ environmentIds: ["env_unknown"], projectId: "prj_scoped" }],
    },
    {
      mode: "restricted" as const,
      projects: [{ projectId: "prj_scoped" }],
    },
    {
      mode: "restricted" as const,
      projects: [{ projectId: "prj_unknown" }],
    },
  ])("rejects a broader restricted scope", (requestedScope) => {
    expect(canDelegateResourceScope(restricted, requestedScope)).toBe(false);
  });
});

describe("requireWorkloadDelegation", () => {
  it("accepts a nonempty capability subset and narrower scope", () => {
    expect(() =>
      requireWorkloadDelegation(principal(), ["evidence:ingest"], restricted),
    ).not.toThrow();
  });

  it("requires identity management capability", () => {
    expect(() =>
      requireWorkloadDelegation(
        principal({ capabilities: ["evidence:ingest"] }),
        ["evidence:ingest"],
        { mode: "tenant" },
      ),
    ).toThrow(ForbiddenError);
  });

  it("refuses delegation by a non-user principal", () => {
    expect(() =>
      requireWorkloadDelegation(principal({ principalType: "service" }), ["evidence:ingest"], {
        mode: "tenant",
      }),
    ).toThrow("Only a user principal");
  });

  it("refuses capabilities the issuer does not hold", () => {
    expect(() =>
      requireWorkloadDelegation(principal(), ["evaluation:run"], { mode: "tenant" }),
    ).toThrow("issuer does not hold");
  });

  for (const [index, capabilities] of invalidCapabilitySets.entries()) {
    it(`refuses invalid capability set ${index + 1}`, () => {
      expect(() =>
        requireWorkloadDelegation(principal(), capabilities, { mode: "tenant" }),
      ).toThrow("capabilities are invalid");
    });
  }

  it("refuses a resource scope broader than the issuer", () => {
    expect(() =>
      requireWorkloadDelegation(principal({ resourceScope: restricted }), ["evidence:ingest"], {
        mode: "tenant",
      }),
    ).toThrow("scope broader");
  });
});
