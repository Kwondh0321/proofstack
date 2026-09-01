import { readFileSync } from "node:fs";
import {
  AssessmentDefinitionSchema,
  AssessmentSchema,
  CriterionSetDefinitionSchema,
  CriterionSetSchema,
  CriterionSetStatusDefinitionSchema,
  CriterionSetStatusRecordSchema,
  type EvaluationRecordKind,
  EvaluationRunDefinitionSchema,
  EvaluationRunSchema,
  PrincipalContextSchema,
  QualificationReportDefinitionSchema,
} from "@proofstack/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "./auth.js";
import { type EvaluationRouteDependencies, registerEvaluationRoutes } from "./evaluation-routes.js";

interface StoredVector {
  readonly input: {
    readonly definition: unknown;
    readonly scope: unknown;
  };
  readonly kind: EvaluationRecordKind;
  readonly sha256: string;
}

const vectors = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
].flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(
          new URL(`../../../packages/contracts/vectors/${file}`, import.meta.url),
          "utf8",
        ),
      ) as { readonly vectors: readonly StoredVector[] }
    ).vectors,
);

function vector(kind: EvaluationRecordKind): StoredVector {
  const result = vectors.find((candidate) => candidate.kind === kind);
  if (!result) throw new Error(`Missing evaluation vector for ${kind}`);
  return result;
}

const criterionVector = vector("criterion_set");
const statusVector = vector("criterion_set_status");
const runVector = vector("evaluation_run");
const assessmentVector = vector("assessment");
const qualificationVector = vector("qualification_report");

const criterionDefinition = CriterionSetDefinitionSchema.parse(criterionVector.input.definition);
const statusDefinition = CriterionSetStatusDefinitionSchema.parse(statusVector.input.definition);
const runDefinition = EvaluationRunDefinitionSchema.parse(runVector.input.definition);
const assessmentDefinition = AssessmentDefinitionSchema.parse(assessmentVector.input.definition);
const qualificationDefinition = QualificationReportDefinitionSchema.parse(
  qualificationVector.input.definition,
);

const criterion = CriterionSetSchema.parse({
  ...criterionDefinition,
  definitionSha256: criterionVector.sha256,
  publishedAt: "2026-09-02T01:00:00.000Z",
  publishedByPrincipalId: "usr_evaluation_route",
  schemaVersion: "0.1",
  scope: criterionVector.input.scope,
});
const status = CriterionSetStatusRecordSchema.parse({
  ...statusDefinition,
  definitionSha256: statusVector.sha256,
  recordedAt: "2026-09-02T01:00:01.000Z",
  recordedByPrincipalId: "usr_evaluation_route",
  schemaVersion: "0.1",
  scope: statusVector.input.scope,
});
const run = EvaluationRunSchema.parse({
  ...runDefinition,
  createdAt: "2026-09-02T01:00:02.000Z",
  createdByPrincipalId: "usr_evaluation_route",
  definitionSha256: runVector.sha256,
  schemaVersion: "0.1",
  scope: runVector.input.scope,
});
const assessment = AssessmentSchema.parse({
  ...assessmentDefinition,
  createdAt: "2026-09-02T01:00:03.000Z",
  createdByPrincipalId: "usr_evaluation_route",
  definitionSha256: assessmentVector.sha256,
  schemaVersion: "0.1",
  scope: assessmentVector.input.scope,
});

function principal() {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-09-02T01:00:00.000Z",
      method: "development",
    },
    capabilities: ["evaluation:manage", "evaluation:read", "evaluation:run"],
    principalId: "usr_evaluation_route",
    principalType: "user",
    requestId: "req_evaluation_route",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_local",
  });
}

function dependencies(
  overrides: Partial<EvaluationRouteDependencies> = {},
): EvaluationRouteDependencies {
  return {
    authenticator: { authenticate: vi.fn(async () => principal()) },
    createAssessment: { execute: vi.fn(async () => ({ created: true, record: assessment })) },
    publishDefinition: {
      execute: vi.fn(async () => ({ created: true, record: criterion })),
    } as unknown as EvaluationRouteDependencies["publishDefinition"],
    readRecord: { execute: vi.fn(async () => criterion) },
    recordCriterionSetStatus: { execute: vi.fn(async () => ({ created: true, record: status })) },
    recordRunDecision: {
      execute: vi.fn(async () => ({ created: true, record: run })),
    } as unknown as EvaluationRouteDependencies["recordRunDecision"],
    ...overrides,
  };
}

const scopeUrl = "/v1/projects/prj_local/environments/env_local/evaluations";
const definitionUrl = `${scopeUrl}/definitions/${criterion.criterionSetVersionId}`;
const statusUrl = `${scopeUrl}/criterion-set-statuses/${status.statusRecordId}`;
const runUrl = `${scopeUrl}/run-decisions/${run.evaluationRunId}`;
const assessmentUrl = `${scopeUrl}/assessments/${assessment.assessmentId}`;
const readUrl = `${scopeUrl}/records/criterion_set/${criterion.criterionSetVersionId}`;

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
  await registerEvaluationRoutes(app, value);
  apps.push(app);
  return { app, value };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("evaluation routes", () => {
  it("maps every public mutation family and exact-version reads", async () => {
    const { app, value } = await testApp();
    const responses = await Promise.all([
      app.inject({
        body: { definition: criterionDefinition, kind: "criterion_set" },
        method: "POST",
        url: definitionUrl,
      }),
      app.inject({
        body: { definition: statusDefinition, kind: "criterion_set_status" },
        method: "POST",
        url: statusUrl,
      }),
      app.inject({
        body: { definition: runDefinition, kind: "evaluation_run" },
        method: "POST",
        url: runUrl,
      }),
      app.inject({
        body: { definition: assessmentDefinition, kind: "assessment" },
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
      definition: criterionDefinition,
      environmentId: "env_local",
      kind: "criterion_set",
      principal: principal(),
      projectId: "prj_local",
      recordId: criterion.criterionSetVersionId,
    });
    expect(value.recordCriterionSetStatus.execute).toHaveBeenCalledWith({
      definition: statusDefinition,
      environmentId: "env_local",
      kind: "criterion_set_status",
      principal: principal(),
      projectId: "prj_local",
      recordId: status.statusRecordId,
    });
    expect(value.recordRunDecision.execute).toHaveBeenCalledWith({
      definition: runDefinition,
      environmentId: "env_local",
      kind: "evaluation_run",
      principal: principal(),
      projectId: "prj_local",
      recordId: run.evaluationRunId,
    });
    expect(value.createAssessment.execute).toHaveBeenCalledWith({
      definition: assessmentDefinition,
      environmentId: "env_local",
      kind: "assessment",
      principal: principal(),
      projectId: "prj_local",
      recordId: assessment.assessmentId,
    });
    expect(value.readRecord.execute).toHaveBeenCalledWith({
      environmentId: "env_local",
      kind: "criterion_set",
      principal: principal(),
      projectId: "prj_local",
      recordId: criterion.criterionSetVersionId,
    });
  });

  it("returns 200 for exact idempotent mutation retries", async () => {
    const { app } = await testApp(
      dependencies({
        publishDefinition: {
          execute: vi.fn(async () => ({ created: false, record: criterion })),
        } as unknown as EvaluationRouteDependencies["publishDefinition"],
      }),
    );

    const response = await app.inject({
      body: { definition: criterionDefinition, kind: "criterion_set" },
      method: "POST",
      url: definitionUrl,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: false });
  });

  it("authenticates before parsing path or body contracts", async () => {
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

  it("does not expose worker-owned mutation surfaces", async () => {
    const { app, value } = await testApp();
    const qualificationOnDefinitionRoute = await app.inject({
      body: { definition: qualificationDefinition, kind: "qualification_report" },
      method: "POST",
      url: `${scopeUrl}/definitions/qlr_vector_001`,
    });
    const workerRoutes = await Promise.all(
      ["qualification-reports", "raw-observations", "run-results", "aggregates"].map((segment) =>
        app.inject({
          body: {},
          method: "POST",
          url: `${scopeUrl}/${segment}/rec_worker_001`,
        }),
      ),
    );

    expect(qualificationOnDefinitionRoute.statusCode).toBe(400);
    expect(workerRoutes.map(({ statusCode }) => statusCode)).toEqual([404, 404, 404, 404]);
    expect(value.publishDefinition.execute).not.toHaveBeenCalled();
  });

  it("rejects invalid kinds and corrupt public responses", async () => {
    const { app } = await testApp(
      dependencies({
        readRecord: { execute: vi.fn(async () => ({ secret: "corrupt-row" }) as never) },
      }),
    );
    const invalidKind = await app.inject({
      method: "GET",
      url: `${scopeUrl}/records/latest/${criterion.criterionSetVersionId}`,
    });
    const corruptResponse = await app.inject({ method: "GET", url: readUrl });

    expect(invalidKind.statusCode).toBe(400);
    expect(corruptResponse.statusCode).toBe(500);
    expect(JSON.stringify(corruptResponse.json())).not.toContain("corrupt-row");
  });
});
