import { readFileSync } from "node:fs";
import {
  type PrincipalContext,
  PrincipalContextSchema,
  ReplayJobSnapshotSchema,
  ReplayPlanDefinitionSchema,
  ReplayPlanSchema,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "./auth.js";
import { type ReplayRouteDependencies, registerReplayRoutes } from "./replay-routes.js";

const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../packages/replay/vectors/replay-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly vectors: readonly {
      readonly input: unknown;
      readonly kind: "replay_plan" | "target_release";
      readonly sha256: string;
    }[];
  }
).vectors;
const targetVector = vectors.find(({ kind }) => kind === "target_release");
const planVector = vectors.find(({ kind }) => kind === "replay_plan");
if (!targetVector || !planVector) throw new Error("Replay definition vectors are incomplete");

const targetDefinition = TargetReleaseDefinitionSchema.parse(targetVector.input);
const planDefinition = ReplayPlanDefinitionSchema.parse(planVector.input);
const release = TargetReleaseSchema.parse({
  ...targetDefinition,
  createdAt: "2026-08-30T18:00:00.000Z",
  createdByPrincipalId: "usr_replay_route",
  definitionSha256: targetVector.sha256,
});
const plan = ReplayPlanSchema.parse({
  ...planDefinition,
  createdAt: "2026-08-30T18:00:01.000Z",
  createdByPrincipalId: "usr_replay_route",
  definitionSha256: planVector.sha256,
});
const snapshot = ReplayJobSnapshotSchema.parse({
  attempts: [],
  budgetLedger: [],
  cancellationAcknowledgements: [],
  cancellationRequest: null,
  executionObservations: [],
  job: {
    createdAt: "2026-08-30T18:00:02.000Z",
    createdByPrincipalId: "usr_replay_route",
    jobId: "job_vector_001",
    lastFencingToken: 0,
    plan: {
      definitionSha256: plan.definitionSha256,
      planId: plan.planId,
      planVersionId: plan.planVersionId,
    },
    recoveryEpoch: 0,
    schemaVersion: "0.1",
    scope: plan.scope,
    stateVersion: 1,
    status: "queued",
  },
  usageObservations: [],
});
const cancellationRequest = {
  cancellationId: "can_vector_001",
  reason: "Stop the bounded replay safely.",
  reasonCode: "operator_request",
} as const;

const targetUrl =
  "/v1/projects/prj_vector/environments/env_vector/replay-targets/target_vector/releases/trg_vector_001";
const planUrl =
  "/v1/projects/prj_vector/environments/env_vector/replay-plans/plan_vector/versions/plv_vector_001";
const jobUrl = "/v1/projects/prj_vector/environments/env_vector/replay-jobs/job_vector_001";
const cancellationUrl = `${jobUrl}/cancellation-requests/can_vector_001`;

function principal(): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-30T18:00:00.000Z",
      method: "development",
    },
    capabilities: ["replay:manage", "replay:run", "replay:read", "replay:cancel"],
    principalId: "usr_replay_route",
    principalType: "user",
    requestId: "req_replay_route",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_vector",
  });
}

function dependencies(overrides: Partial<ReplayRouteDependencies> = {}): ReplayRouteDependencies {
  return {
    authenticator: { authenticate: vi.fn(async () => principal()) },
    createJob: { execute: vi.fn(async () => ({ created: true, snapshot })) },
    publishPlan: { execute: vi.fn(async () => ({ created: true, plan })) },
    publishTargetRelease: { execute: vi.fn(async () => ({ created: true, release })) },
    readJob: { execute: vi.fn(async () => snapshot) },
    readPlan: { execute: vi.fn(async () => plan) },
    readTargetRelease: { execute: vi.fn(async () => release) },
    requestCancellation: { execute: vi.fn(async () => ({ created: true, snapshot })) },
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];

async function testApp(value = dependencies()) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    reply.status(errorName === "ZodError" ? 400 : statusCode).send({ error: errorName });
  });
  await registerReplayRoutes(app, value);
  apps.push(app);
  return { app, value };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("replay routes", () => {
  it("maps exact immutable definitions, durable jobs, and cancellation requests", async () => {
    const { app, value } = await testApp();

    const publishTarget = await app.inject({
      body: targetDefinition,
      method: "POST",
      url: targetUrl,
    });
    const readTarget = await app.inject({ method: "GET", url: targetUrl });
    const publishPlan = await app.inject({ body: planDefinition, method: "POST", url: planUrl });
    const readPlan = await app.inject({ method: "GET", url: planUrl });
    const createJob = await app.inject({
      body: {
        jobId: snapshot.job.jobId,
        plan: snapshot.job.plan,
      },
      method: "POST",
      url: jobUrl,
    });
    const readJob = await app.inject({ method: "GET", url: jobUrl });
    const cancelJob = await app.inject({
      body: cancellationRequest,
      method: "POST",
      url: cancellationUrl,
    });

    for (const response of [
      publishTarget,
      readTarget,
      publishPlan,
      readPlan,
      createJob,
      readJob,
      cancelJob,
    ]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ requestId: expect.any(String) });
    }
    expect([
      publishTarget.statusCode,
      publishPlan.statusCode,
      createJob.statusCode,
      cancelJob.statusCode,
    ]).toEqual([201, 201, 201, 201]);
    expect([readTarget.statusCode, readPlan.statusCode, readJob.statusCode]).toEqual([
      200, 200, 200,
    ]);
    expect(value.publishTargetRelease.execute).toHaveBeenCalledWith({
      definition: targetDefinition,
      environmentId: "env_vector",
      principal: principal(),
      projectId: "prj_vector",
      targetId: "target_vector",
      targetReleaseId: "trg_vector_001",
    });
    expect(value.publishPlan.execute).toHaveBeenCalledWith({
      definition: planDefinition,
      environmentId: "env_vector",
      planId: "plan_vector",
      planVersionId: "plv_vector_001",
      principal: principal(),
      projectId: "prj_vector",
    });
    expect(value.createJob.execute).toHaveBeenCalledWith({
      environmentId: "env_vector",
      jobId: "job_vector_001",
      principal: principal(),
      projectId: "prj_vector",
      request: { jobId: snapshot.job.jobId, plan: snapshot.job.plan },
    });
    expect(value.requestCancellation.execute).toHaveBeenCalledWith({
      environmentId: "env_vector",
      jobId: "job_vector_001",
      principal: principal(),
      projectId: "prj_vector",
      request: cancellationRequest,
    });
  });

  it("returns 200 for exact idempotent mutation retries", async () => {
    const { app } = await testApp(
      dependencies({
        createJob: { execute: vi.fn(async () => ({ created: false, snapshot })) },
        publishPlan: { execute: vi.fn(async () => ({ created: false, plan })) },
        publishTargetRelease: { execute: vi.fn(async () => ({ created: false, release })) },
        requestCancellation: { execute: vi.fn(async () => ({ created: false, snapshot })) },
      }),
    );

    const responses = await Promise.all([
      app.inject({ body: targetDefinition, method: "POST", url: targetUrl }),
      app.inject({ body: planDefinition, method: "POST", url: planUrl }),
      app.inject({
        body: { jobId: snapshot.job.jobId, plan: snapshot.job.plan },
        method: "POST",
        url: jobUrl,
      }),
      app.inject({ body: cancellationRequest, method: "POST", url: cancellationUrl }),
    ]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200, 200, 200]);
    for (const response of responses) expect(response.json()).toMatchObject({ created: false });
  });

  it("authenticates before contract parsing or protected use-case access", async () => {
    const authenticator: Authenticator = {
      authenticate: vi.fn(async () => {
        throw Object.assign(new Error("missing credentials"), { statusCode: 401 });
      }),
    };
    const value = dependencies({ authenticator });
    const { app } = await testApp(value);

    const response = await app.inject({
      body: { malformed: true },
      method: "POST",
      url: "/v1/projects/INVALID/environments/INVALID/replay-jobs/INVALID",
    });

    expect(response.statusCode).toBe(401);
    expect(authenticator.authenticate).toHaveBeenCalledOnce();
    expect(value.createJob.execute).not.toHaveBeenCalled();
  });

  it("rejects malformed contracts and a cancellation ID substituted in the body", async () => {
    const { app, value } = await testApp();
    const malformed = await app.inject({
      body: { ...targetDefinition, latest: true },
      method: "POST",
      url: targetUrl,
    });
    const substituted = await app.inject({
      body: { ...cancellationRequest, cancellationId: "can_substituted_001" },
      method: "POST",
      url: cancellationUrl,
    });

    expect(malformed.statusCode).toBe(400);
    expect(substituted.statusCode).toBe(400);
    expect(value.publishTargetRelease.execute).not.toHaveBeenCalled();
    expect(value.requestCancellation.execute).not.toHaveBeenCalled();
  });

  it("rejects response data that violates the public contract", async () => {
    const value = dependencies({
      readJob: { execute: vi.fn(async () => ({ secret: "corrupt-row" }) as never) },
    });
    const { app } = await testApp(value);

    const response = await app.inject({ method: "GET", url: jobUrl });

    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.json())).not.toContain("corrupt-row");
  });
});
