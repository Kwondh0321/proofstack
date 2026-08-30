import { readFileSync } from "node:fs";
import {
  type PrincipalContext,
  PrincipalContextSchema,
  ReplayPlanDefinitionSchema,
  TargetReleaseDefinitionSchema,
} from "@proofstack/contracts";
import type { ReplayJobControlRepository } from "@proofstack/replay";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { type Authenticator, AuthenticationRequiredError } from "./auth.js";
import { loadConfig } from "./config.js";

const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
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
    }[];
  }
).vectors;
const targetVector = vectors.find(({ kind }) => kind === "target_release");
const planVector = vectors.find(({ kind }) => kind === "replay_plan");
if (!targetVector || !planVector) throw new Error("Replay definition vectors are incomplete");

const targetDefinition = TargetReleaseDefinitionSchema.parse({
  ...(targetVector.input as object),
  scope: {
    environmentId: "env_local",
    projectId: "prj_local",
    tenantId: "ten_local",
  },
});
const targetUrl =
  "/v1/projects/prj_local/environments/env_local/replay-targets/target_vector/releases/trg_vector_001";
const planUrl =
  "/v1/projects/prj_local/environments/env_local/replay-plans/plan_vector/versions/plv_vector_001";
const jobUrl = "/v1/projects/prj_local/environments/env_local/replay-jobs/job_local_001";
const cancellationUrl = `${jobUrl}/cancellation-requests/can_local_001`;

function principal(capabilities: PrincipalContext["capabilities"]): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-30T18:10:00.000Z",
      method: "development",
    },
    capabilities,
    principalId: "usr_local",
    principalType: "user",
    requestId: "req_replay_api",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_local",
  });
}

async function testApp(
  dependencies: Parameters<typeof createApp>[1] = {},
): Promise<Awaited<ReturnType<typeof createApp>>> {
  const app = await createApp(config, {
    clock: { now: () => new Date("2026-08-30T18:10:00.000Z") },
    ...dependencies,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("replay control-plane API", () => {
  it("publishes exact lineage, creates a durable job, and commits queued cancellation", async () => {
    const app = await testApp();
    const targetPublication = await app.inject({
      body: targetDefinition,
      method: "POST",
      url: targetUrl,
    });
    const publishedTarget = targetPublication.json().release;
    const planDefinition = ReplayPlanDefinitionSchema.parse({
      ...(planVector.input as object),
      scope: targetDefinition.scope,
      targetRelease: {
        ...(planVector.input as { readonly targetRelease: object }).targetRelease,
        definitionSha256: publishedTarget.definitionSha256,
      },
    });
    const planPublication = await app.inject({
      body: planDefinition,
      method: "POST",
      url: planUrl,
    });
    const publishedPlan = planPublication.json().plan;
    const creationRequest = {
      jobId: "job_local_001",
      plan: {
        definitionSha256: publishedPlan.definitionSha256,
        planId: publishedPlan.planId,
        planVersionId: publishedPlan.planVersionId,
      },
    };
    const creation = await app.inject({ body: creationRequest, method: "POST", url: jobUrl });
    const readQueued = await app.inject({ method: "GET", url: jobUrl });
    const cancellation = await app.inject({
      body: {
        cancellationId: "can_local_001",
        reason: "Stop the local replay safely.",
        reasonCode: "operator_request",
      },
      method: "POST",
      url: cancellationUrl,
    });
    const readCancelled = await app.inject({ method: "GET", url: jobUrl });

    expect(targetPublication.statusCode).toBe(201);
    expect(planPublication.statusCode).toBe(201);
    expect(creation.statusCode).toBe(201);
    expect(creation.json()).toMatchObject({
      created: true,
      snapshot: { job: { jobId: "job_local_001", status: "queued" } },
    });
    expect(readQueued.statusCode).toBe(200);
    expect(readQueued.json()).toMatchObject({ snapshot: { attempts: [], budgetLedger: [] } });
    expect(cancellation.statusCode).toBe(201);
    expect(cancellation.json()).toMatchObject({
      created: true,
      snapshot: {
        cancellationRequest: {
          cancellationId: "can_local_001",
          requestedByPrincipalId: "usr_local",
        },
        job: {
          status: "cancelled",
          terminal: { code: "cancellation_committed", status: "cancelled" },
        },
      },
    });
    expect(readCancelled.statusCode).toBe(200);
    expect(readCancelled.json()).toMatchObject({
      snapshot: { job: { stateVersion: 2, status: "cancelled" } },
    });

    const targetRetry = await app.inject({
      body: targetDefinition,
      method: "POST",
      url: targetUrl,
    });
    const planRetry = await app.inject({ body: planDefinition, method: "POST", url: planUrl });
    const jobRetry = await app.inject({ body: creationRequest, method: "POST", url: jobUrl });
    const cancellationRetry = await app.inject({
      body: {
        cancellationId: "can_local_001",
        reason: "Stop the local replay safely.",
        reasonCode: "operator_request",
      },
      method: "POST",
      url: cancellationUrl,
    });
    expect([
      targetRetry.statusCode,
      planRetry.statusCode,
      jobRetry.statusCode,
      cancellationRetry.statusCode,
    ]).toEqual([200, 200, 200, 200]);
  });

  it("maps malformed, missing, lineage, and immutable-definition conflicts distinctly", async () => {
    const app = await testApp();
    const malformed = await app.inject({
      body: { ...targetDefinition, latest: true },
      method: "POST",
      url: targetUrl,
    });
    const missing = await app.inject({ method: "GET", url: targetUrl });
    const routeMismatch = await app.inject({
      body: targetDefinition,
      method: "POST",
      url: targetUrl.replace("target_vector", "target_other"),
    });
    await app.inject({ body: targetDefinition, method: "POST", url: targetUrl });
    const conflict = await app.inject({
      body: {
        ...targetDefinition,
        outputLimits: { ...targetDefinition.outputLimits, stdoutBytes: 1024 },
      },
      method: "POST",
      url: targetUrl,
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "invalid_request", status: 400 });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "replay_definition_not_found", status: 404 });
    expect(routeMismatch.statusCode).toBe(400);
    expect(routeMismatch.json()).toMatchObject({
      code: "replay_definition_input_invalid",
      status: 400,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "replay_definition_conflict", status: 409 });
  });

  it("enforces authentication and each replay capability before protected work", async () => {
    const unavailable: Authenticator = {
      authenticate: vi.fn(async () => {
        throw new AuthenticationRequiredError();
      }),
    };
    const unauthenticated = await testApp({ authenticator: unavailable });
    const unauthenticatedResponse = await unauthenticated.inject({
      body: { malformed: true },
      method: "POST",
      url: "/v1/projects/INVALID/environments/INVALID/replay-jobs/INVALID",
    });
    const reader = await testApp({
      authenticator: { authenticate: async () => principal(["replay:read"]) },
    });
    const forbiddenPublication = await reader.inject({
      body: targetDefinition,
      method: "POST",
      url: targetUrl,
    });

    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(unauthenticatedResponse.json()).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(forbiddenPublication.statusCode).toBe(403);
    expect(forbiddenPublication.json()).toMatchObject({ code: "forbidden", status: 403 });
  });

  it("fails closed without exposing a corrupt replay repository result", async () => {
    const unexpected = vi.fn(async () => {
      throw new Error("Unexpected repository operation");
    });
    const replayJobControlRepository: ReplayJobControlRepository = {
      createJob: unexpected,
      findJob: vi.fn(async () => ({ secret: "corrupt-row" }) as never),
      requestCancellation: unexpected,
    };
    const app = await testApp({ replayJobControlRepository });

    const response = await app.inject({ method: "GET", url: jobUrl });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "internal_error",
      detail: "An unexpected error occurred",
      status: 500,
    });
    expect(JSON.stringify(response.json())).not.toContain("corrupt-row");
  });
});
