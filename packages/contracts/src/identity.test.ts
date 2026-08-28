import { describe, expect, it } from "vitest";
import { PrincipalContextSchema } from "./identity.js";

const developmentPrincipal = {
  authentication: {
    authenticatedAt: "2026-08-28T02:00:00.000Z",
    method: "development",
  },
  capabilities: ["project:read", "evidence:ingest"],
  principalId: "usr_local",
  principalType: "user",
  requestId: "req_local_001",
  resourceScope: { mode: "tenant" },
  roles: ["owner"],
  tenantId: "ten_local",
} as const;

describe("PrincipalContextSchema", () => {
  it("accepts an explicit development principal", () => {
    expect(PrincipalContextSchema.safeParse(developmentPrincipal).success).toBe(true);
  });

  it("requires a credential identifier for non-development authentication", () => {
    const result = PrincipalContextSchema.safeParse({
      ...developmentPrincipal,
      authentication: {
        authenticatedAt: "2026-08-28T02:00:00.000Z",
        method: "api_key",
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate capabilities", () => {
    const result = PrincipalContextSchema.safeParse({
      ...developmentPrincipal,
      capabilities: ["evidence:ingest", "evidence:ingest"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate roles", () => {
    const result = PrincipalContextSchema.safeParse({
      ...developmentPrincipal,
      roles: ["owner", "owner"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty restricted project scope", () => {
    const result = PrincipalContextSchema.safeParse({
      ...developmentPrincipal,
      resourceScope: { mode: "restricted", projectIds: [] },
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate projects in a restricted scope", () => {
    const result = PrincipalContextSchema.safeParse({
      ...developmentPrincipal,
      resourceScope: {
        mode: "restricted",
        projectIds: ["prj_local", "prj_local"],
      },
    });

    expect(result.success).toBe(false);
  });
});
