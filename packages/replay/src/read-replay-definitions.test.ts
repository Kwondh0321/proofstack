import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayPlan,
  ReplayPlanSchema,
  type TargetRelease,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidReplayDefinitionInputError,
  ReplayDefinitionNotFoundError,
  ReplayRepositoryContractError,
} from "./errors.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "./replay-definition-digest.js";
import {
  ReadReplayPlan,
  type ReadReplayPlanCommand,
  ReadTargetRelease,
  type ReadTargetReleaseCommand,
} from "./read-replay-definitions.js";
import type { ReplayDefinitionRepository } from "./replay-definition-repository.js";

const vectors = JSON.parse(
  readFileSync(new URL("../vectors/replay-definition-v1.json", import.meta.url), "utf8"),
) as {
  readonly vectors: readonly [
    {
      readonly input: Omit<
        TargetRelease,
        "createdAt" | "createdByPrincipalId" | "definitionSha256"
      >;
      readonly sha256: string;
    },
    {
      readonly input: Omit<ReplayPlan, "createdAt" | "createdByPrincipalId" | "definitionSha256">;
      readonly sha256: string;
    },
  ];
};

const CREATED_AT = "2026-08-30T16:00:00.000Z";
const RELEASE = TargetReleaseSchema.parse({
  ...vectors.vectors[0].input,
  createdAt: CREATED_AT,
  createdByPrincipalId: "usr_release_author",
  definitionSha256: vectors.vectors[0].sha256,
});
const PLAN = ReplayPlanSchema.parse({
  ...vectors.vectors[1].input,
  createdAt: CREATED_AT,
  createdByPrincipalId: "usr_plan_author",
  definitionSha256: vectors.vectors[1].sha256,
});
const SCOPE: EvidenceScope = RELEASE.scope;

function targetRelease(overrides: Partial<TargetRelease>): TargetRelease {
  const candidate = { ...RELEASE, ...overrides };
  const {
    createdAt,
    createdByPrincipalId,
    definitionSha256: _definitionSha256,
    ...definition
  } = candidate;
  return TargetReleaseSchema.parse({
    ...definition,
    createdAt,
    createdByPrincipalId,
    definitionSha256: digestTargetReleaseDefinition(definition),
  });
}

function replayPlan(overrides: Partial<ReplayPlan>): ReplayPlan {
  const candidate = { ...PLAN, ...overrides };
  const {
    createdAt,
    createdByPrincipalId,
    definitionSha256: _definitionSha256,
    ...definition
  } = candidate;
  return ReplayPlanSchema.parse({
    ...definition,
    createdAt,
    createdByPrincipalId,
    definitionSha256: digestReplayPlanDefinition(definition),
  });
}

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-30T15:59:00.000Z",
      method: "development",
    },
    capabilities: ["replay:read"],
    principalId: "usr_replay_reader",
    principalType: "user",
    requestId: "req_replay_read_001",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function releaseCommand(
  overrides: Partial<ReadTargetReleaseCommand> = {},
): ReadTargetReleaseCommand {
  return {
    environmentId: SCOPE.environmentId,
    principal: principal(),
    projectId: SCOPE.projectId,
    targetId: RELEASE.targetId,
    targetReleaseId: RELEASE.targetReleaseId,
    ...overrides,
  };
}

function planCommand(overrides: Partial<ReadReplayPlanCommand> = {}): ReadReplayPlanCommand {
  return {
    environmentId: SCOPE.environmentId,
    planId: PLAN.planId,
    planVersionId: PLAN.planVersionId,
    principal: principal(),
    projectId: SCOPE.projectId,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly plan?: unknown;
  readonly release?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const findReplayPlan = vi
    .fn<ReplayDefinitionRepository["findReplayPlan"]>()
    .mockResolvedValue((options.plan === undefined ? PLAN : options.plan) as ReplayPlan | null);
  const findTargetRelease = vi
    .fn<ReplayDefinitionRepository["findTargetRelease"]>()
    .mockResolvedValue(
      (options.release === undefined ? RELEASE : options.release) as TargetRelease | null,
    );
  const unexpected = vi.fn(async () => {
    throw new Error("Unexpected repository mutation");
  });
  const repository: ReplayDefinitionRepository = {
    findReplayPlan,
    findTargetRelease,
    publishReplayPlan: unexpected,
    publishTargetRelease: unexpected,
  };
  return {
    findReplayPlan,
    findTargetRelease,
    planReader: new ReadReplayPlan(repository),
    releaseReader: new ReadTargetRelease(repository),
  };
}

describe("authorized replay definition reads", () => {
  it("returns detached exact releases and plans through detached repository scopes", async () => {
    const value = harness();
    value.findTargetRelease.mockImplementation(async (scope, targetReleaseId) => {
      expect(scope).toEqual(SCOPE);
      expect(targetReleaseId).toBe(RELEASE.targetReleaseId);
      (scope as { environmentId: string }).environmentId = "env_mutated";
      return RELEASE;
    });
    value.findReplayPlan.mockImplementation(async (scope, planVersionId) => {
      expect(scope).toEqual(SCOPE);
      expect(planVersionId).toBe(PLAN.planVersionId);
      (scope as { projectId: string }).projectId = "prj_mutated";
      return PLAN;
    });

    const release = await value.releaseReader.execute(releaseCommand());
    const plan = await value.planReader.execute(planCommand());

    expect(release).toEqual(RELEASE);
    expect(plan).toEqual(PLAN);
    expect(release).not.toBe(RELEASE);
    expect(plan).not.toBe(PLAN);
    (release.mounts as unknown[]).push({});
    (plan.boundaries as unknown[]).push({});
    expect(RELEASE.mounts).toHaveLength(0);
    expect(PLAN.boundaries).toHaveLength(1);
  });

  it("requires replay read authority before touching routes or repositories", async () => {
    const value = harness();
    let targetReads = 0;
    const command = {
      get environmentId() {
        targetReads += 1;
        return SCOPE.environmentId;
      },
      principal: principal({ capabilities: ["replay:run"] }),
      projectId: SCOPE.projectId,
      targetId: RELEASE.targetId,
      targetReleaseId: RELEASE.targetReleaseId,
    } satisfies ReadTargetReleaseCommand;

    await expect(value.releaseReader.execute(command)).rejects.toBeInstanceOf(ForbiddenError);
    expect(targetReads).toBe(0);
    expect(value.findTargetRelease).not.toHaveBeenCalled();
  });

  it.each([
    {
      resourceScope: {
        mode: "restricted" as const,
        projects: [{ projectId: "prj_other" }],
      },
    },
    {
      resourceScope: {
        mode: "restricted" as const,
        projects: [{ environmentIds: ["env_other"], projectId: SCOPE.projectId }],
      },
    },
  ])("authorizes the exact route before parsing its identifiers %#", async (override) => {
    const value = harness();
    await expect(
      value.planReader.execute(planCommand({ planId: "x", principal: principal(override) })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findReplayPlan).not.toHaveBeenCalled();
  });

  it("accepts an explicitly authorized restricted environment", async () => {
    const value = harness();
    const restricted = principal({
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: [SCOPE.environmentId], projectId: SCOPE.projectId }],
      },
    });

    await expect(
      value.releaseReader.execute(releaseCommand({ principal: restricted })),
    ).resolves.toEqual(RELEASE);
  });

  it.each([
    ["principal", releaseCommand({ principal: { principalId: "bad" } as PrincipalContext })],
    ["scope", releaseCommand({ projectId: "x" })],
    ["target id", releaseCommand({ targetId: "x" })],
    ["target release id", releaseCommand({ targetReleaseId: "x" })],
    ["plan id", planCommand({ planId: "x" })],
    ["plan version id", planCommand({ planVersionId: "x" })],
  ])("rejects invalid %s input without repository access", async (kind, command) => {
    const value = harness();
    const operation = kind.startsWith("plan")
      ? value.planReader.execute(command as ReadReplayPlanCommand)
      : value.releaseReader.execute(command as ReadTargetReleaseCommand);
    await expect(operation).rejects.toBeInstanceOf(InvalidReplayDefinitionInputError);
    expect(value.findReplayPlan).not.toHaveBeenCalled();
    expect(value.findTargetRelease).not.toHaveBeenCalled();
  });
});

describe("target release read isolation", () => {
  it("uses the same not-found result for missing and cross-target releases", async () => {
    const missing = harness({ release: null });
    await expect(missing.releaseReader.execute(releaseCommand())).rejects.toBeInstanceOf(
      ReplayDefinitionNotFoundError,
    );

    const otherTarget = harness({ release: targetRelease({ targetId: "target_other" }) });
    await expect(otherTarget.releaseReader.execute(releaseCommand())).rejects.toBeInstanceOf(
      ReplayDefinitionNotFoundError,
    );
  });

  it.each([
    ["invalid release", {}],
    ["invalid digest", { ...RELEASE, definitionSha256: "0".repeat(64) }],
    ["substituted version", targetRelease({ targetReleaseId: "trg_other_001" })],
    ["substituted tenant", targetRelease({ scope: { ...SCOPE, tenantId: "ten_other" } })],
    ["substituted project", targetRelease({ scope: { ...SCOPE, projectId: "prj_other" } })],
    ["substituted environment", targetRelease({ scope: { ...SCOPE, environmentId: "env_other" } })],
  ])("rejects a repository %s as a contract violation", async (_label, release) => {
    const value = harness({ release });
    await expect(value.releaseReader.execute(releaseCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("normalizes unreadable repository releases as contract violations", async () => {
    const value = harness({
      release: new Proxy(RELEASE, {
        ownKeys: () => {
          throw new Error("unreadable release");
        },
      }),
    });
    await expect(value.releaseReader.execute(releaseCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("preserves target release adapter failures", async () => {
    const value = harness();
    const failure = new Error("database unavailable");
    value.findTargetRelease.mockRejectedValue(failure);
    await expect(value.releaseReader.execute(releaseCommand())).rejects.toBe(failure);
  });
});

describe("replay plan read isolation", () => {
  it("uses the same not-found result for missing and cross-plan versions", async () => {
    const missing = harness({ plan: null });
    await expect(missing.planReader.execute(planCommand())).rejects.toBeInstanceOf(
      ReplayDefinitionNotFoundError,
    );

    const otherPlan = harness({ plan: replayPlan({ planId: "plan_other" }) });
    await expect(otherPlan.planReader.execute(planCommand())).rejects.toBeInstanceOf(
      ReplayDefinitionNotFoundError,
    );
  });

  it.each([
    ["invalid plan", {}],
    ["invalid digest", { ...PLAN, definitionSha256: "0".repeat(64) }],
    ["substituted version", replayPlan({ planVersionId: "plv_other_001" })],
    ["substituted tenant", replayPlan({ scope: { ...SCOPE, tenantId: "ten_other" } })],
    ["substituted project", replayPlan({ scope: { ...SCOPE, projectId: "prj_other" } })],
    ["substituted environment", replayPlan({ scope: { ...SCOPE, environmentId: "env_other" } })],
  ])("rejects a repository %s as a contract violation", async (_label, plan) => {
    const value = harness({ plan });
    await expect(value.planReader.execute(planCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("normalizes unreadable repository plans as contract violations", async () => {
    const value = harness({
      plan: new Proxy(PLAN, {
        ownKeys: () => {
          throw new Error("unreadable plan");
        },
      }),
    });
    await expect(value.planReader.execute(planCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("preserves replay plan adapter failures", async () => {
    const value = harness();
    const failure = new Error("database unavailable");
    value.findReplayPlan.mockRejectedValue(failure);
    await expect(value.planReader.execute(planCommand())).rejects.toBe(failure);
  });
});
