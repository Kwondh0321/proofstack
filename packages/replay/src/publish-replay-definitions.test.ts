import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayPlan,
  type ReplayPlanDefinition,
  ReplayPlanSchema,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import { type Clock, ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidReplayDefinitionInputError,
  ReplayDefinitionConflictError,
  ReplayRepositoryContractError,
} from "./errors.js";
import {
  PublishReplayPlan,
  type PublishReplayPlanCommand,
  PublishTargetRelease,
  type PublishTargetReleaseCommand,
} from "./publish-replay-definitions.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "./replay-definition-digest.js";
import type { ReplayDefinitionRepository } from "./replay-definition-repository.js";

const vectors = JSON.parse(
  readFileSync(new URL("../vectors/replay-definition-v1.json", import.meta.url), "utf8"),
) as {
  readonly vectors: readonly [
    { readonly input: TargetReleaseDefinition },
    { readonly input: ReplayPlanDefinition },
  ];
};

const CREATED_AT = "2026-08-30T17:00:00.000Z";
const TARGET_DEFINITION = vectors.vectors[0].input;
const PLAN_DEFINITION = vectors.vectors[1].input;
const SCOPE: EvidenceScope = TARGET_DEFINITION.scope;

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-30T16:59:00.000Z",
      method: "development",
    },
    capabilities: ["replay:manage"],
    principalId: "usr_replay_manager",
    principalType: "user",
    requestId: "req_replay_publish_001",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function releaseFrom(
  definition: TargetReleaseDefinition = TARGET_DEFINITION,
  overrides: Partial<Pick<TargetRelease, "createdAt" | "createdByPrincipalId">> = {},
): TargetRelease {
  return TargetReleaseSchema.parse({
    ...definition,
    createdAt: overrides.createdAt ?? CREATED_AT,
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_original_release_author",
    definitionSha256: digestTargetReleaseDefinition(definition),
  });
}

function planFrom(
  definition: ReplayPlanDefinition = PLAN_DEFINITION,
  overrides: Partial<Pick<ReplayPlan, "createdAt" | "createdByPrincipalId">> = {},
): ReplayPlan {
  return ReplayPlanSchema.parse({
    ...definition,
    createdAt: overrides.createdAt ?? CREATED_AT,
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_original_plan_author",
    definitionSha256: digestReplayPlanDefinition(definition),
  });
}

function targetCommand(
  overrides: Partial<PublishTargetReleaseCommand> = {},
): PublishTargetReleaseCommand {
  return {
    definition: TARGET_DEFINITION,
    environmentId: SCOPE.environmentId,
    principal: principal(),
    projectId: SCOPE.projectId,
    targetId: TARGET_DEFINITION.targetId,
    targetReleaseId: TARGET_DEFINITION.targetReleaseId,
    ...overrides,
  };
}

function planCommand(overrides: Partial<PublishReplayPlanCommand> = {}): PublishReplayPlanCommand {
  return {
    definition: PLAN_DEFINITION,
    environmentId: SCOPE.environmentId,
    planId: PLAN_DEFINITION.planId,
    planVersionId: PLAN_DEFINITION.planVersionId,
    principal: principal(),
    projectId: SCOPE.projectId,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly existingPlan?: ReplayPlan | null;
  readonly existingRelease?: TargetRelease | null;
}

function harness(options: HarnessOptions = {}) {
  const clockNow = vi.fn<Clock["now"]>().mockReturnValue(new Date(CREATED_AT));
  const findReplayPlan = vi
    .fn<ReplayDefinitionRepository["findReplayPlan"]>()
    .mockResolvedValue(options.existingPlan ?? null);
  const findTargetRelease = vi
    .fn<ReplayDefinitionRepository["findTargetRelease"]>()
    .mockResolvedValue(options.existingRelease ?? null);
  const publishReplayPlan = vi
    .fn<ReplayDefinitionRepository["publishReplayPlan"]>()
    .mockImplementation(async (definition) => ({ created: true, definition }));
  const publishTargetRelease = vi
    .fn<ReplayDefinitionRepository["publishTargetRelease"]>()
    .mockImplementation(async (definition) => ({ created: true, definition }));
  const repository: ReplayDefinitionRepository = {
    findReplayPlan,
    findTargetRelease,
    publishReplayPlan,
    publishTargetRelease,
  };
  const dependencies = { clock: { now: clockNow }, repository };
  return {
    clockNow,
    findReplayPlan,
    findTargetRelease,
    planPublisher: new PublishReplayPlan(dependencies),
    publishReplayPlan,
    publishTargetRelease,
    releasePublisher: new PublishTargetRelease(dependencies),
  };
}

describe("replay definition publication authorization and input", () => {
  it("requires replay management before reading protected route or body input", async () => {
    const value = harness();
    let definitionReads = 0;
    const command = {
      get definition() {
        definitionReads += 1;
        return TARGET_DEFINITION;
      },
      environmentId: SCOPE.environmentId,
      principal: principal({ capabilities: ["replay:read"] }),
      projectId: SCOPE.projectId,
      targetId: TARGET_DEFINITION.targetId,
      targetReleaseId: TARGET_DEFINITION.targetReleaseId,
    } satisfies PublishTargetReleaseCommand;

    await expect(value.releasePublisher.execute(command)).rejects.toBeInstanceOf(ForbiddenError);
    expect(definitionReads).toBe(0);
    expect(value.findTargetRelease).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
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
  ])("authorizes exact scope before parsing an attacker body %#", async (override) => {
    const value = harness();
    await expect(
      value.planPublisher.execute(
        planCommand({
          definition: { ...PLAN_DEFINITION, unexpected: true } as ReplayPlanDefinition,
          principal: principal(override),
        }),
      ),
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
      value.releasePublisher.execute(targetCommand({ principal: restricted })),
    ).resolves.toMatchObject({ created: true });
  });

  it.each([
    [
      "principal",
      targetCommand({ principal: { principalId: "bad" } as PrincipalContext }),
      "target",
    ],
    ["scope", targetCommand({ environmentId: "x" }), "target"],
    ["target id", targetCommand({ targetId: "x" }), "target"],
    ["target release id", targetCommand({ targetReleaseId: "x" }), "target"],
    [
      "target definition",
      targetCommand({
        definition: { ...TARGET_DEFINITION, unexpected: true } as TargetReleaseDefinition,
      }),
      "target",
    ],
    ["plan id", planCommand({ planId: "x" }), "plan"],
    ["plan version id", planCommand({ planVersionId: "x" }), "plan"],
    [
      "plan definition",
      planCommand({ definition: { ...PLAN_DEFINITION, unexpected: true } as ReplayPlanDefinition }),
      "plan",
    ],
  ])("rejects invalid %s without repository or clock access", async (_label, command, kind) => {
    const value = harness();
    const operation =
      kind === "target"
        ? value.releasePublisher.execute(command as PublishTargetReleaseCommand)
        : value.planPublisher.execute(command as PublishReplayPlanCommand);
    await expect(operation).rejects.toBeInstanceOf(InvalidReplayDefinitionInputError);
    expect(value.findTargetRelease).not.toHaveBeenCalled();
    expect(value.findReplayPlan).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it.each([
    targetCommand({
      definition: { ...TARGET_DEFINITION, scope: { ...SCOPE, tenantId: "ten_other" } },
    }),
    targetCommand({ definition: { ...TARGET_DEFINITION, targetId: "target_other" } }),
    targetCommand({ definition: { ...TARGET_DEFINITION, targetReleaseId: "trg_other_001" } }),
  ])("rejects target definitions that disagree with exact route scope and IDs", async (command) => {
    const value = harness();
    await expect(value.releasePublisher.execute(command)).rejects.toBeInstanceOf(
      InvalidReplayDefinitionInputError,
    );
    expect(value.findTargetRelease).not.toHaveBeenCalled();
  });

  it.each([
    planCommand({
      definition: { ...PLAN_DEFINITION, scope: { ...SCOPE, projectId: "prj_other" } },
    }),
    planCommand({ definition: { ...PLAN_DEFINITION, planId: "plan_other" } }),
    planCommand({ definition: { ...PLAN_DEFINITION, planVersionId: "plv_other_001" } }),
  ])("rejects plan definitions that disagree with exact route scope and IDs", async (command) => {
    const value = harness();
    await expect(value.planPublisher.execute(command)).rejects.toBeInstanceOf(
      InvalidReplayDefinitionInputError,
    );
    expect(value.findReplayPlan).not.toHaveBeenCalled();
  });
});

describe("new replay definition publication", () => {
  it("publishes server-authored target releases and replay plans with exact digests", async () => {
    const value = harness();
    const release = await value.releasePublisher.execute(targetCommand());
    const plan = await value.planPublisher.execute(planCommand());

    expect(release).toEqual({
      created: true,
      release: releaseFrom(TARGET_DEFINITION, {
        createdByPrincipalId: "usr_replay_manager",
      }),
    });
    expect(plan).toEqual({
      created: true,
      plan: planFrom(PLAN_DEFINITION, { createdByPrincipalId: "usr_replay_manager" }),
    });
    expect(value.clockNow).toHaveBeenCalledTimes(2);
    expect(value.findTargetRelease).toHaveBeenCalledWith(SCOPE, TARGET_DEFINITION.targetReleaseId);
    expect(value.findReplayPlan).toHaveBeenCalledWith(SCOPE, PLAN_DEFINITION.planVersionId);
    expect(value.publishTargetRelease).toHaveBeenCalledTimes(1);
    expect(value.publishReplayPlan).toHaveBeenCalledTimes(1);
    expect(value.publishTargetRelease.mock.calls[0]?.[0]).not.toBe(release.release);
    expect(value.publishReplayPlan.mock.calls[0]?.[0]).not.toBe(plan.plan);
  });

  it("accepts authoritative concurrent publications with equivalent immutable semantics", async () => {
    const value = harness();
    const concurrentRelease = releaseFrom(TARGET_DEFINITION, {
      createdAt: "2026-08-30T16:59:59.000Z",
      createdByPrincipalId: "usr_concurrent",
    });
    const concurrentPlan = planFrom(PLAN_DEFINITION, {
      createdAt: "2026-08-30T16:59:59.000Z",
      createdByPrincipalId: "usr_concurrent",
    });
    value.publishTargetRelease.mockResolvedValue({
      created: false,
      definition: concurrentRelease,
    });
    value.publishReplayPlan.mockResolvedValue({ created: false, definition: concurrentPlan });

    await expect(value.releasePublisher.execute(targetCommand())).resolves.toEqual({
      created: false,
      release: concurrentRelease,
    });
    await expect(value.planPublisher.execute(planCommand())).resolves.toEqual({
      created: false,
      plan: concurrentPlan,
    });
  });

  it.each([
    {
      clock: () => {
        throw new Error("clock unavailable");
      },
    },
    {
      clock: () => ({ toISOString: () => "2026-08-30T17:00:00Z" }) as Date,
    },
  ])("rejects an invalid authoritative clock before publication %#", async ({ clock }) => {
    const value = harness();
    value.clockNow.mockImplementation(clock);
    await expect(value.releasePublisher.execute(targetCommand())).rejects.toBeInstanceOf(
      InvalidReplayDefinitionInputError,
    );
    expect(value.publishTargetRelease).not.toHaveBeenCalled();
  });
});

describe("idempotent replay definition publication", () => {
  it("revalidates and returns the authoritative target release without reading the clock", async () => {
    const existing = releaseFrom();
    const value = harness({ existingRelease: existing });
    value.publishTargetRelease.mockImplementation(async (definition) => ({
      created: false,
      definition,
    }));

    const result = await value.releasePublisher.execute(targetCommand());

    expect(result).toEqual({ created: false, release: existing });
    expect(result.release).not.toBe(existing);
    expect(value.clockNow).not.toHaveBeenCalled();
    expect(value.publishTargetRelease).toHaveBeenCalledWith(existing);
    expect(value.publishTargetRelease.mock.calls[0]?.[0]).not.toBe(existing);
  });

  it("revalidates and returns the authoritative replay plan without reading the clock", async () => {
    const existing = planFrom();
    const value = harness({ existingPlan: existing });
    value.publishReplayPlan.mockImplementation(async (definition) => ({
      created: false,
      definition,
    }));

    const result = await value.planPublisher.execute(planCommand());

    expect(result).toEqual({ created: false, plan: existing });
    expect(result.plan).not.toBe(existing);
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it("rejects conflicting target and plan retries before mutation", async () => {
    const changedTarget: TargetReleaseDefinition = {
      ...TARGET_DEFINITION,
      source: { ...TARGET_DEFINITION.source, revision: "f".repeat(40) },
    };
    const changedPlan: ReplayPlanDefinition = {
      ...PLAN_DEFINITION,
      budget: {
        ...PLAN_DEFINITION.budget,
        modelRequests: { ...PLAN_DEFINITION.budget.modelRequests, limit: 5 },
      },
    };
    const value = harness({
      existingPlan: planFrom(),
      existingRelease: releaseFrom(),
    });

    await expect(
      value.releasePublisher.execute(targetCommand({ definition: changedTarget })),
    ).rejects.toBeInstanceOf(ReplayDefinitionConflictError);
    await expect(
      value.planPublisher.execute(planCommand({ definition: changedPlan })),
    ).rejects.toBeInstanceOf(ReplayDefinitionConflictError);
    expect(value.publishTargetRelease).not.toHaveBeenCalled();
    expect(value.publishReplayPlan).not.toHaveBeenCalled();
  });

  it("rejects retry results that claim creation or replace authoritative metadata", async () => {
    const existingRelease = releaseFrom();
    const existingPlan = planFrom();
    const value = harness({ existingPlan, existingRelease });
    value.publishTargetRelease.mockResolvedValue({ created: true, definition: existingRelease });
    value.publishReplayPlan.mockResolvedValue({
      created: false,
      definition: planFrom(PLAN_DEFINITION, { createdByPrincipalId: "usr_replaced" }),
    });

    await expect(value.releasePublisher.execute(targetCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
    await expect(value.planPublisher.execute(planCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });
});

describe("replay definition publication repository contracts", () => {
  it.each([
    null,
    {},
    { created: "yes", definition: releaseFrom() },
    { created: true, definition: releaseFrom(), unexpected: true },
    new Proxy(
      { created: true, definition: releaseFrom() },
      {
        ownKeys: () => {
          throw new Error("unreadable keys");
        },
      },
    ),
    new Proxy(
      { created: true, definition: releaseFrom() },
      {
        get: (target, property, receiver) => {
          if (property === "created") throw new Error("unreadable field");
          return Reflect.get(target, property, receiver);
        },
      },
    ),
  ])("rejects malformed publication result %#", async (result) => {
    const value = harness();
    value.publishTargetRelease.mockResolvedValue(result as never);
    await expect(value.releasePublisher.execute(targetCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
  });

  it("rejects invalid, substituted, and semantically altered target publication values", async () => {
    const cases: unknown[] = [
      { created: true, definition: {} },
      {
        created: true,
        definition: releaseFrom({ ...TARGET_DEFINITION, targetReleaseId: "trg_other_001" }),
      },
      {
        created: true,
        definition: releaseFrom({
          ...TARGET_DEFINITION,
          scope: { ...SCOPE, environmentId: "env_other" },
        }),
      },
      {
        created: false,
        definition: releaseFrom({
          ...TARGET_DEFINITION,
          source: { ...TARGET_DEFINITION.source, revision: "f".repeat(40) },
        }),
      },
      {
        created: true,
        definition: releaseFrom(TARGET_DEFINITION, { createdByPrincipalId: "usr_replaced" }),
      },
    ];

    for (const result of cases) {
      const value = harness();
      value.publishTargetRelease.mockResolvedValue(result as never);
      await expect(value.releasePublisher.execute(targetCommand())).rejects.toBeInstanceOf(
        ReplayRepositoryContractError,
      );
    }
  });

  it("rejects invalid, substituted, and semantically altered plan publication values", async () => {
    const changedPlan: ReplayPlanDefinition = {
      ...PLAN_DEFINITION,
      budget: {
        ...PLAN_DEFINITION.budget,
        modelRequests: { ...PLAN_DEFINITION.budget.modelRequests, limit: 5 },
      },
    };
    const cases: unknown[] = [
      { created: true, definition: {} },
      {
        created: true,
        definition: planFrom({ ...PLAN_DEFINITION, planVersionId: "plv_other_001" }),
      },
      {
        created: true,
        definition: planFrom({
          ...PLAN_DEFINITION,
          scope: { ...SCOPE, tenantId: "ten_other" },
        }),
      },
      { created: false, definition: planFrom(changedPlan) },
      {
        created: true,
        definition: planFrom(PLAN_DEFINITION, { createdByPrincipalId: "usr_replaced" }),
      },
    ];

    for (const result of cases) {
      const value = harness();
      value.publishReplayPlan.mockResolvedValue(result as never);
      await expect(value.planPublisher.execute(planCommand())).rejects.toBeInstanceOf(
        ReplayRepositoryContractError,
      );
    }
  });

  it("rejects invalid stored definitions and preserves adapter failures", async () => {
    const invalidRelease = harness({ existingRelease: {} as TargetRelease });
    const invalidPlan = harness({ existingPlan: {} as ReplayPlan });
    await expect(invalidRelease.releasePublisher.execute(targetCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );
    await expect(invalidPlan.planPublisher.execute(planCommand())).rejects.toBeInstanceOf(
      ReplayRepositoryContractError,
    );

    const targetFailure = harness();
    const targetError = new Error("target database unavailable");
    targetFailure.findTargetRelease.mockRejectedValue(targetError);
    await expect(targetFailure.releasePublisher.execute(targetCommand())).rejects.toBe(targetError);

    const planFailure = harness();
    const planError = new Error("plan database unavailable");
    planFailure.publishReplayPlan.mockRejectedValue(planError);
    await expect(planFailure.planPublisher.execute(planCommand())).rejects.toBe(planError);
  });
});
