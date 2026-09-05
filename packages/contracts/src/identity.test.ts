import { describe, expect, it } from "vitest";
import {
  PrincipalContextSchema,
  WORKLOAD_DELEGABLE_CAPABILITIES,
  WorkloadCapabilitySchema,
} from "./identity.js";

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

  it("keeps dataset reading and management as distinct user capabilities", () => {
    expect(
      PrincipalContextSchema.safeParse({
        ...developmentPrincipal,
        capabilities: ["dataset:read", "dataset:manage"],
      }).success,
    ).toBe(true);
  });

  it("keeps replay control-plane capabilities distinct from evaluation and release authority", () => {
    expect(
      PrincipalContextSchema.safeParse({
        ...developmentPrincipal,
        capabilities: ["replay:read", "replay:run", "replay:cancel", "replay:manage"],
      }).success,
    ).toBe(true);
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
      resourceScope: { mode: "restricted", projects: [] },
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate projects in a restricted scope", () => {
    const result = PrincipalContextSchema.safeParse({
      ...developmentPrincipal,
      resourceScope: {
        mode: "restricted",
        projects: [{ projectId: "prj_local" }, { projectId: "prj_local" }],
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a unique environment restriction for a project", () => {
    const result = PrincipalContextSchema.safeParse({
      ...developmentPrincipal,
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_staging", "env_production"], projectId: "prj_local" }],
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects duplicate environments in a project scope", () => {
    const result = PrincipalContextSchema.safeParse({
      ...developmentPrincipal,
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_local", "env_local"], projectId: "prj_local" }],
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("WorkloadCapabilitySchema", () => {
  it("keeps the exported allowlist and runtime schema identical", () => {
    expect(WorkloadCapabilitySchema.options).toEqual(WORKLOAD_DELEGABLE_CAPABILITIES);
  });

  it.each([
    "evidence:ingest",
    "artifact:write",
    "artifact:read",
    "dataset:read",
    "replay:read",
    "replay:run",
    "replay:cancel",
    "evaluation:run",
    "evaluation:model:run",
    "policy:evaluate",
  ])("accepts delegable capability %s", (capability) => {
    expect(WorkloadCapabilitySchema.safeParse(capability).success).toBe(true);
  });

  it.each([
    "artifact:read:restricted",
    "artifact:delete",
    "dataset:manage",
    "replay:manage",
    "evaluation:manage",
    "evaluation:human:review",
    "comparison:manage",
    "identity:manage",
    "approval:decide",
    "project:manage",
    "policy:manage",
  ])("rejects administrative capability %s", (capability) => {
    expect(WorkloadCapabilitySchema.safeParse(capability).success).toBe(false);
  });

  it("allows comparison reads without delegating comparison management", () => {
    expect(WorkloadCapabilitySchema.safeParse("comparison:read").success).toBe(true);
    expect(WorkloadCapabilitySchema.safeParse("comparison:manage").success).toBe(false);
  });
});
