import { readFileSync } from "node:fs";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  COMPARISON_RESULT_SCHEMA_VERSION,
  ComparisonDefinitionRecordSchema,
  ComparisonEvidenceSnapshotSchema,
  ComparisonResultSchema,
  type PrincipalContext,
  PublishComparisonDefinitionRequestSchema,
} from "@proofstack/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "./auth.js";
import { type ComparisonRouteDependencies, registerComparisonRoutes } from "./comparison-routes.js";

interface VectorDocument {
  readonly vectors: readonly {
    readonly input: { readonly definition: Record<string, unknown>; readonly scope: unknown };
    readonly sha256: string;
  }[];
}

function vector(filename: string): VectorDocument["vectors"][number] {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/vectors/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as VectorDocument;
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected ${filename}`);
  return first;
}

const definitionVector = vector("evaluation-comparison-definition-v1.json");
const snapshotVector = vector("evaluation-comparison-snapshot-definition-v1.json");
const resultVector = vector("evaluation-comparison-result-definition-v1.json");
const definitionDocument = structuredClone(definitionVector.input.definition);
const { comparisonId, predecessor: _predecessor, ...definitionBody } = definitionDocument;
const definitionInput = PublishComparisonDefinitionRequestSchema.parse(definitionBody);
const definitionRecord = ComparisonDefinitionRecordSchema.parse({
  ...definitionDocument,
  createdAt: "2026-09-02T04:00:00.000Z",
  createdByPrincipalId: "usr_comparison_route",
  definitionSha256: definitionVector.sha256,
  schemaVersion: COMPARISON_DEFINITION_SCHEMA_VERSION,
  scope: structuredClone(definitionVector.input.scope),
});
const snapshotRecord = ComparisonEvidenceSnapshotSchema.parse({
  ...structuredClone(snapshotVector.input.definition),
  createdAt: "2026-09-02T04:00:00.000Z",
  createdByPrincipalId: "usr_comparison_route",
  definitionSha256: snapshotVector.sha256,
  schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  scope: structuredClone(snapshotVector.input.scope),
});
const resultRecord = ComparisonResultSchema.parse({
  ...structuredClone(resultVector.input.definition),
  createdAt: "2026-09-02T04:00:00.000Z",
  createdByPrincipalId: "usr_comparison_route",
  definitionSha256: resultVector.sha256,
  schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
  scope: structuredClone(resultVector.input.scope),
});
const snapshotInput = {
  comparison: snapshotRecord.comparison,
  role: snapshotRecord.role,
  snapshotId: snapshotRecord.snapshotId,
};
const resultInput = {
  baselineSnapshot: resultRecord.baselineSnapshot,
  candidateSnapshot: resultRecord.candidateSnapshot,
  comparison: resultRecord.comparison,
  resultId: resultRecord.resultId,
};

function principal(): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-02T03:00:00.000Z", method: "development" },
    capabilities: ["comparison:manage", "comparison:read"],
    principalId: "usr_comparison_route",
    principalType: "user",
    requestId: "req_comparison_route",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_local",
  };
}

function dependencies(
  overrides: Partial<ComparisonRouteDependencies> = {},
): ComparisonRouteDependencies {
  return {
    authenticator: { authenticate: vi.fn(async () => principal()) },
    createSnapshot: {
      execute: vi.fn(async () => ({ created: true, record: snapshotRecord })),
    } as unknown as ComparisonRouteDependencies["createSnapshot"],
    deriveResult: {
      execute: vi.fn(async () => ({ created: true, record: resultRecord })),
    } as unknown as ComparisonRouteDependencies["deriveResult"],
    publishDefinition: {
      execute: vi.fn(async () => ({ created: true, record: definitionRecord })),
    } as unknown as ComparisonRouteDependencies["publishDefinition"],
    readRecord: {
      execute: vi.fn(async () => resultRecord),
    } as unknown as ComparisonRouteDependencies["readRecord"],
    ...overrides,
  };
}

const scopeUrl = "/v1/projects/prj_local/environments/env_local/comparisons";
const definitionUrl = `${scopeUrl}/${comparisonId}/definitions/${definitionInput.comparisonVersionId}`;
const snapshotUrl = `${scopeUrl}/evidence-snapshots/${snapshotInput.snapshotId}`;
const resultUrl = `${scopeUrl}/results/${resultInput.resultId}`;
const readUrl = `${scopeUrl}/records/comparison_result/${resultInput.resultId}`;
const apps: ReturnType<typeof Fastify>[] = [];

async function testApp(value = dependencies()) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    reply.status(errorName === "ZodError" ? 400 : 500).send({ error: errorName });
  });
  await registerComparisonRoutes(app, value);
  apps.push(app);
  return { app, value };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("comparison routes", () => {
  it("maps definitions, snapshots, results, and exact record reads", async () => {
    const { app, value } = await testApp();
    const responses = await Promise.all([
      app.inject({ body: definitionInput, method: "POST", url: definitionUrl }),
      app.inject({ body: snapshotInput, method: "POST", url: snapshotUrl }),
      app.inject({ body: resultInput, method: "POST", url: resultUrl }),
      app.inject({ method: "GET", url: readUrl }),
    ]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([201, 201, 201, 200]);
    expect(responses.map(({ body }) => JSON.parse(body).result.kind)).toEqual([
      "comparison_definition",
      "comparison_evidence_snapshot",
      "comparison_result",
      "comparison_result",
    ]);
    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ requestId: expect.any(String) });
    }
    expect(value.publishDefinition.execute).toHaveBeenCalledWith({
      comparisonId,
      comparisonVersionId: definitionInput.comparisonVersionId,
      environmentId: "env_local",
      input: definitionInput,
      principal: principal(),
      projectId: "prj_local",
    });
    expect(value.createSnapshot.execute).toHaveBeenCalledWith({
      environmentId: "env_local",
      input: snapshotInput,
      principal: principal(),
      projectId: "prj_local",
      snapshotId: snapshotInput.snapshotId,
    });
    expect(value.deriveResult.execute).toHaveBeenCalledWith({
      environmentId: "env_local",
      input: resultInput,
      principal: principal(),
      projectId: "prj_local",
      resultId: resultInput.resultId,
    });
    expect(value.readRecord.execute).toHaveBeenCalledWith({
      environmentId: "env_local",
      kind: "comparison_result",
      principal: principal(),
      projectId: "prj_local",
      recordId: resultInput.resultId,
    });
  });

  it("returns 200 for exact idempotent retries", async () => {
    const { app } = await testApp(
      dependencies({
        deriveResult: {
          execute: vi.fn(async () => ({ created: false, record: resultRecord })),
        } as unknown as ComparisonRouteDependencies["deriveResult"],
      }),
    );
    const response = await app.inject({ body: resultInput, method: "POST", url: resultUrl });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: false });
  });

  it("authenticates before parsing path and body contracts", async () => {
    const authenticator: Authenticator = {
      authenticate: vi.fn(async () => {
        throw new Error("unauthenticated");
      }),
    };
    const { app, value } = await testApp(dependencies({ authenticator }));
    const response = await app.inject({
      body: { secret: "must-not-be-parsed" },
      method: "POST",
      url: `${scopeUrl}/bad!/definitions/bad!`,
    });
    expect(response.statusCode).toBe(500);
    expect(authenticator.authenticate).toHaveBeenCalledOnce();
    expect(value.publishDefinition.execute).not.toHaveBeenCalled();
  });

  it("rejects malformed inputs before invoking use cases", async () => {
    const { app, value } = await testApp();
    const [pathResponse, bodyResponse, kindResponse] = await Promise.all([
      app.inject({
        body: definitionInput,
        method: "POST",
        url: `${scopeUrl}/bad!/definitions/bad!`,
      }),
      app.inject({
        body: { ...resultInput, callerVerdict: "pass" },
        method: "POST",
        url: resultUrl,
      }),
      app.inject({ method: "GET", url: `${scopeUrl}/records/unknown/${resultInput.resultId}` }),
    ]);
    expect([pathResponse.statusCode, bodyResponse.statusCode, kindResponse.statusCode]).toEqual([
      400, 400, 400,
    ]);
    expect(value.publishDefinition.execute).not.toHaveBeenCalled();
    expect(value.deriveResult.execute).not.toHaveBeenCalled();
    expect(value.readRecord.execute).not.toHaveBeenCalled();
  });

  it("refuses to emit malformed use-case output", async () => {
    const { app } = await testApp(
      dependencies({
        deriveResult: {
          execute: vi.fn(async () => ({ created: true, record: { secret: "malformed" } })),
        } as unknown as ComparisonRouteDependencies["deriveResult"],
      }),
    );
    const response = await app.inject({ body: resultInput, method: "POST", url: resultUrl });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Error" });
  });
});
