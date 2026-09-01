import { readFileSync } from "node:fs";
import {
  HumanReviewRecordSchema,
  IndependentCritiqueSchema,
  ModelAssuranceAssessmentSchema,
  ModelEvaluatorProfileSchema,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "./auth.js";
import {
  type ModelAssuranceRouteDependencies,
  registerModelAssuranceRoutes,
} from "./model-assurance-routes.js";

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown>; readonly scope: unknown };
  readonly sha256: string;
}

function vector(filename: string): StoredVector {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/vectors/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly StoredVector[] };
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected ${filename}`);
  return value;
}

const profileVector = vector("evaluation-model-assurance-definition-v1.json");
const critiqueVector = vector("evaluation-independent-critique-definition-v1.json");
const reviewVector = vector("evaluation-human-review-record-definition-v1.json");
const assessmentVector = vector("evaluation-model-assurance-assessment-definition-v1.json");

const profileDefinition = structuredClone(profileVector.input.definition);
const critiqueDefinition = structuredClone(critiqueVector.input.definition);
const reviewDefinition = structuredClone(reviewVector.input.definition);
const assessmentDefinition = structuredClone(assessmentVector.input.definition);
Reflect.deleteProperty(assessmentDefinition, "eligibility");
Reflect.deleteProperty(assessmentDefinition, "evaluatedAt");
Reflect.deleteProperty(assessmentDefinition, "reasons");

const profile = ModelEvaluatorProfileSchema.parse({
  ...profileVector.input.definition,
  definitionSha256: profileVector.sha256,
  publishedAt: "2026-09-02T01:00:00.000Z",
  publishedByPrincipalId: "usr_model_assurance_route",
  schemaVersion: "0.1",
  scope: profileVector.input.scope,
});

const critique = IndependentCritiqueSchema.parse({
  ...critiqueVector.input.definition,
  definitionSha256: critiqueVector.sha256,
  recordedAt: "2026-09-02T01:01:01.000Z",
  recordedByPrincipalId: "wrk_model_critic",
  schemaVersion: "0.1",
  scope: critiqueVector.input.scope,
});

const review = HumanReviewRecordSchema.parse({
  ...reviewVector.input.definition,
  definitionSha256: reviewVector.sha256,
  recordedAt: "2026-09-02T03:30:01.000Z",
  schemaVersion: "0.1",
  scope: reviewVector.input.scope,
});

const assessment = ModelAssuranceAssessmentSchema.parse({
  ...assessmentVector.input.definition,
  definitionSha256: assessmentVector.sha256,
  recordedAt: "2026-09-02T06:00:01.000Z",
  schemaVersion: "0.1",
  scope: assessmentVector.input.scope,
});

function principal() {
  return PrincipalContextSchema.parse({
    authentication: { authenticatedAt: "2026-09-02T01:00:00.000Z", method: "development" },
    capabilities: [
      "evaluation:human:review",
      "evaluation:manage",
      "evaluation:model:run",
      "evaluation:read",
    ],
    principalId: "usr_model_assurance_route",
    principalType: "user",
    requestId: "req_model_assurance_route",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_assurance",
  });
}

function dependencies(
  overrides: Partial<ModelAssuranceRouteDependencies> = {},
): ModelAssuranceRouteDependencies {
  return {
    authenticator: { authenticate: vi.fn(async () => principal()) },
    createAssessment: { execute: vi.fn(async () => ({ created: true, record: assessment })) },
    publishDefinition: {
      execute: vi.fn(async () => ({ created: true, record: profile })),
    } as unknown as ModelAssuranceRouteDependencies["publishDefinition"],
    readRecord: { execute: vi.fn(async () => profile) },
    recordExecution: {
      execute: vi.fn(async () => ({ created: true, record: critique })),
    } as unknown as ModelAssuranceRouteDependencies["recordExecution"],
    recordHumanReview: { execute: vi.fn(async () => ({ created: true, record: review })) },
    ...overrides,
  };
}

const scopeUrl = "/v1/projects/prj_assurance/environments/env_assurance/model-assurance";
const profileUrl = `${scopeUrl}/definitions/${profile.modelProfileVersionId}`;
const critiqueUrl = `${scopeUrl}/executions/${critique.critiqueId}`;
const reviewUrl = `${scopeUrl}/human-reviews/${review.reviewId}`;
const assessmentUrl = `${scopeUrl}/assessments/${assessment.assessmentExtensionId}`;
const readUrl = `${scopeUrl}/records/model_evaluator_profile/${profile.modelProfileVersionId}`;

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
  await registerModelAssuranceRoutes(app, value);
  apps.push(app);
  return { app, value };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("model assurance routes", () => {
  it("maps each authority-specific mutation family and exact-version reads", async () => {
    const { app, value } = await testApp();
    const responses = await Promise.all([
      app.inject({
        body: { definition: profileDefinition, kind: "model_evaluator_profile" },
        method: "POST",
        url: profileUrl,
      }),
      app.inject({
        body: { definition: critiqueDefinition, kind: "independent_critique" },
        method: "POST",
        url: critiqueUrl,
      }),
      app.inject({
        body: { definition: reviewDefinition, kind: "human_review_record" },
        method: "POST",
        url: reviewUrl,
      }),
      app.inject({
        body: { definition: assessmentDefinition, kind: "model_assurance_assessment" },
        method: "POST",
        url: assessmentUrl,
      }),
      app.inject({ method: "GET", url: readUrl }),
    ]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([201, 201, 201, 201, 200]);
    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ requestId: expect.any(String) });
    }
    expect(value.publishDefinition.execute).toHaveBeenCalledWith({
      definition: profileDefinition,
      environmentId: "env_assurance",
      kind: "model_evaluator_profile",
      principal: principal(),
      projectId: "prj_assurance",
      recordId: profile.modelProfileVersionId,
    });
    expect(value.recordExecution.execute).toHaveBeenCalledWith({
      definition: critiqueDefinition,
      environmentId: "env_assurance",
      kind: "independent_critique",
      principal: principal(),
      projectId: "prj_assurance",
      recordId: critique.critiqueId,
    });
    expect(value.recordHumanReview.execute).toHaveBeenCalledWith({
      definition: reviewDefinition,
      environmentId: "env_assurance",
      kind: "human_review_record",
      principal: principal(),
      projectId: "prj_assurance",
      recordId: review.reviewId,
    });
    expect(value.createAssessment.execute).toHaveBeenCalledWith({
      definition: assessmentDefinition,
      environmentId: "env_assurance",
      principal: principal(),
      projectId: "prj_assurance",
      recordId: assessment.assessmentExtensionId,
    });
    expect(value.readRecord.execute).toHaveBeenCalledWith({
      environmentId: "env_assurance",
      kind: "model_evaluator_profile",
      principal: principal(),
      projectId: "prj_assurance",
      recordId: profile.modelProfileVersionId,
    });
  });

  it("returns 200 for an exact idempotent retry", async () => {
    const { app } = await testApp(
      dependencies({
        publishDefinition: {
          execute: vi.fn(async () => ({ created: false, record: profile })),
        } as unknown as ModelAssuranceRouteDependencies["publishDefinition"],
      }),
    );
    const response = await app.inject({
      body: { definition: profileDefinition, kind: "model_evaluator_profile" },
      method: "POST",
      url: profileUrl,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: false });
  });

  it("authenticates before parsing paths and bodies", async () => {
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
      url: `${scopeUrl}/definitions/INVALID`,
    });
    expect(response.statusCode).toBe(401);
    expect(authenticator.authenticate).toHaveBeenCalledOnce();
    expect(value.publishDefinition.execute).not.toHaveBeenCalled();
  });

  it("rejects cross-authority kinds, mutable aliases, and corrupt responses", async () => {
    const { app, value } = await testApp(
      dependencies({
        readRecord: { execute: vi.fn(async () => ({ secret: "corrupt-row" }) as never) },
      }),
    );
    const managementCrossing = await app.inject({
      body: { definition: critiqueDefinition, kind: "independent_critique" },
      method: "POST",
      url: `${scopeUrl}/definitions/${critique.critiqueId}`,
    });
    const mutableAlias = await app.inject({
      method: "GET",
      url: `${scopeUrl}/records/latest/${profile.modelProfileVersionId}`,
    });
    const corruptResponse = await app.inject({ method: "GET", url: readUrl });

    expect(managementCrossing.statusCode).toBe(400);
    expect(mutableAlias.statusCode).toBe(400);
    expect(corruptResponse.statusCode).toBe(500);
    expect(JSON.stringify(corruptResponse.json())).not.toContain("corrupt-row");
    expect(value.publishDefinition.execute).not.toHaveBeenCalled();
  });
});
