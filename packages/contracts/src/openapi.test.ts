import { describe, expect, it } from "vitest";
import { createProofStackOpenApiDocument } from "./openapi.js";

function collectReferences(value: unknown, references: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return references;
  }
  if (typeof value !== "object" || value === null) return references;

  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") references.push(child);
    collectReferences(child, references);
  }
  return references;
}

describe("ProofStack OpenAPI document", () => {
  it("describes the implemented workflow routes", () => {
    const document = createProofStackOpenApiDocument();

    expect(document).toMatchObject({
      info: { version: "0.8.0-workflow-1" },
      openapi: "3.2.0",
      paths: {
        "/health/live": {},
        "/health/ready": {},
        "/openapi.json": {},
        "/v1/traces": {},
        "/v1/auth/oidc/callback": {},
        "/v1/auth/oidc/login": {},
        "/v1/auth/oidc/logout": {},
        "/v1/auth/session": {},
        "/v1/identity/api-keys": {},
        "/v1/identity/api-keys/{credentialId}/revoke": {},
        "/v1/identity/api-keys/{credentialId}/rotate": {},
        "/v1/projects/{projectId}/environments/{environmentId}/evidence": {},
        "/v1/projects/{projectId}/environments/{environmentId}/evaluations/assessments/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/evaluations/criterion-set-statuses/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/evaluations/definitions/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/evaluations/records/{kind}/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/evaluations/run-decisions/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/assessments/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/definitions/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/executions/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/human-reviews/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/records/{kind}/{recordId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/artifacts": {},
        "/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}": {},
        "/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}/content": {},
        "/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}/purge": {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/{datasetId}/versions":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/{datasetId}/versions/{datasetVersionId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/versions":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/versions/{fixtureVersionId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/export":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/export/content":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/revocation":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/replay-targets/{targetId}/releases/{targetReleaseId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/replay-plans/{planId}/versions/{planVersionId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/replay-jobs/{jobId}": {},
        "/v1/projects/{projectId}/environments/{environmentId}/replay-jobs/{jobId}/cancellation-requests/{cancellationId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/traces/{traceId}": {},
      },
    });
  });

  it("documents separated exact model-assurance authority and no mutable aliases", () => {
    const document = createProofStackOpenApiDocument();
    const { components: rawComponents, paths: rawPaths } = document;
    const components = (rawComponents as { schemas: Record<string, unknown> }).schemas;
    const paths = rawPaths as Record<
      string,
      {
        get?: {
          parameters: Array<{ name: string }>;
          responses: Record<string, unknown>;
          security: unknown;
        };
        post?: {
          parameters: Array<{ name: string }>;
          requestBody: { content: { "application/json": { schema: { $ref: string } } } };
          responses: Record<string, { headers?: Record<string, unknown> }>;
          security: unknown;
        };
      }
    >;
    const prefix = "/v1/projects/{projectId}/environments/{environmentId}/model-assurance";
    const definition = paths[`${prefix}/definitions/{recordId}`]?.post;
    const execution = paths[`${prefix}/executions/{recordId}`]?.post;
    const review = paths[`${prefix}/human-reviews/{recordId}`]?.post;
    const assessment = paths[`${prefix}/assessments/{recordId}`]?.post;
    const read = paths[`${prefix}/records/{kind}/{recordId}`]?.get;

    expect(definition?.security).toEqual([{ browserSession: [] }]);
    expect(execution?.security).toEqual([{ bearerAuth: [] }]);
    expect(review?.security).toEqual([{ browserSession: [] }]);
    expect(assessment?.security).toEqual([{ browserSession: [] }]);
    expect(read?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
    expect(definition?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/PublishModelAssuranceDefinitionRequest",
    );
    expect(execution?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/RecordModelAssuranceExecutionRequest",
    );
    expect(review?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/RecordHumanReviewRequest",
    );
    expect(assessment?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/CreateModelAssuranceAssessmentRequest",
    );
    expect(execution?.parameters.map(({ name }) => name)).toEqual([
      "projectId",
      "environmentId",
      "recordId",
    ]);
    expect(read?.parameters.map(({ name }) => name)).toEqual([
      "projectId",
      "environmentId",
      "kind",
      "recordId",
    ]);
    for (const operation of [definition, execution, review, assessment]) {
      expect(operation?.responses).toHaveProperty("200");
      expect(operation?.responses).toHaveProperty("201");
      expect(operation?.responses).toHaveProperty("409");
      expect(operation?.responses).toHaveProperty("503");
      expect(operation?.responses["200"]?.headers).toHaveProperty("Cache-Control");
    }
    expect(read?.responses).toHaveProperty("404");
    expect(read?.responses).toHaveProperty("503");
    for (const schema of [
      "ModelAssuranceRecordKind",
      "PublishModelAssuranceDefinitionRequest",
      "RecordModelAssuranceExecutionRequest",
      "RecordHumanReviewRequest",
      "CreateModelAssuranceAssessmentRequest",
      "PublishModelAssuranceRecordResponse",
      "ReadModelAssuranceRecordResponse",
    ]) {
      expect(components).toHaveProperty(schema);
    }
    const assurancePaths = Object.keys(paths).filter((path) => path.includes("/model-assurance/"));
    expect(assurancePaths).toHaveLength(5);
    expect(assurancePaths.some((path) => /latest|arbitrary-prompt|release/.test(path))).toBe(false);
  });

  it("documents exact evaluation control without worker mutation or latest aliases", () => {
    const document = createProofStackOpenApiDocument();
    const { components: rawComponents, paths: rawPaths } = document;
    const components = (rawComponents as { schemas: Record<string, unknown> }).schemas;
    const paths = rawPaths as Record<
      string,
      {
        get?: {
          parameters: Array<{ name: string }>;
          responses: Record<string, { headers?: Record<string, unknown> }>;
          security: unknown;
        };
        post?: {
          parameters: Array<{ name: string }>;
          requestBody: {
            content: { "application/json": { schema: { $ref: string } } };
          };
          responses: Record<string, { headers?: Record<string, unknown> }>;
          security: unknown;
        };
      }
    >;
    const prefix = "/v1/projects/{projectId}/environments/{environmentId}/evaluations";
    const definition = paths[`${prefix}/definitions/{recordId}`]?.post;
    const criterionStatus = paths[`${prefix}/criterion-set-statuses/{recordId}`]?.post;
    const runDecision = paths[`${prefix}/run-decisions/{recordId}`]?.post;
    const assessment = paths[`${prefix}/assessments/{recordId}`]?.post;
    const read = paths[`${prefix}/records/{kind}/{recordId}`]?.get;

    for (const operation of [definition, criterionStatus, assessment]) {
      expect(operation?.security).toEqual([{ browserSession: [] }]);
    }
    expect(runDecision?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
    expect(read?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);

    expect(definition?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/PublishEvaluationDefinitionRequest",
    );
    expect(criterionStatus?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/RecordCriterionSetStatusRequest",
    );
    expect(runDecision?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/RecordEvaluationRunDecisionRequest",
    );
    expect(assessment?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/CreateAssessmentRequest",
    );
    expect(read?.parameters.map(({ name }) => name)).toEqual([
      "projectId",
      "environmentId",
      "kind",
      "recordId",
    ]);

    for (const operation of [definition, criterionStatus, runDecision, assessment]) {
      expect(operation?.responses).toHaveProperty("200");
      expect(operation?.responses).toHaveProperty("201");
      expect(operation?.responses).toHaveProperty("409");
      expect(operation?.responses).toHaveProperty("503");
      expect(operation?.responses["200"]?.headers).toHaveProperty("Cache-Control");
      expect(operation?.responses["201"]?.headers).toHaveProperty("Cache-Control");
      expect(operation?.parameters.map(({ name }) => name)).toContain("X-ProofStack-CSRF");
    }
    expect(read?.responses).toHaveProperty("404");
    expect(read?.responses).toHaveProperty("503");
    expect(read?.responses["200"]?.headers).toHaveProperty("Cache-Control");

    for (const schema of [
      "EvaluationRecordKind",
      "PublishEvaluationDefinitionRequest",
      "RecordCriterionSetStatusRequest",
      "RecordEvaluationRunDecisionRequest",
      "CreateAssessmentRequest",
      "PublishEvaluationRecordResponse",
      "ReadEvaluationRecordResponse",
    ]) {
      expect(components).toHaveProperty(schema);
    }
    const evaluationPaths = Object.keys(paths).filter((path) => path.includes("/evaluations/"));
    expect(evaluationPaths).toHaveLength(5);
    expect(
      evaluationPaths.some((path) =>
        /latest|execute|raw-observations|qualification-reports/.test(path),
      ),
    ).toBe(false);
  });

  it("documents exact replay control without latest or synchronous execution routes", () => {
    const document = createProofStackOpenApiDocument();
    const { components: rawComponents, paths: rawPaths } = document;
    const components = (rawComponents as { schemas: Record<string, unknown> }).schemas;
    const paths = rawPaths as Record<
      string,
      {
        get?: {
          parameters: Array<{ name: string }>;
          responses: Record<string, { headers?: Record<string, unknown> }>;
          security: unknown;
        };
        post?: {
          parameters: Array<{ name: string }>;
          requestBody: {
            content: { "application/json": { schema: { $ref: string } } };
          };
          responses: Record<string, { headers?: Record<string, unknown> }>;
          security: unknown;
        };
      }
    >;
    const target =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/replay-targets/{targetId}/releases/{targetReleaseId}"
      ];
    const plan =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/replay-plans/{planId}/versions/{planVersionId}"
      ];
    const job = paths["/v1/projects/{projectId}/environments/{environmentId}/replay-jobs/{jobId}"];
    const cancellation =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/replay-jobs/{jobId}/cancellation-requests/{cancellationId}"
      ]?.post;

    expect(target?.post?.security).toEqual([{ browserSession: [] }]);
    expect(plan?.post?.security).toEqual([{ browserSession: [] }]);
    for (const operation of [target?.get, plan?.get, job?.get, job?.post, cancellation]) {
      expect(operation?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
    }
    expect(target?.get?.parameters.map(({ name }) => name)).toEqual([
      "projectId",
      "environmentId",
      "targetId",
      "targetReleaseId",
    ]);
    expect(plan?.get?.parameters.map(({ name }) => name)).toEqual([
      "projectId",
      "environmentId",
      "planId",
      "planVersionId",
    ]);
    expect(cancellation?.parameters.map(({ name }) => name)).toEqual([
      "projectId",
      "environmentId",
      "jobId",
      "cancellationId",
      "Origin",
      "X-ProofStack-CSRF",
    ]);
    expect(target?.post?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/TargetReleaseDefinition",
    );
    expect(plan?.post?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ReplayPlanDefinition",
    );
    expect(job?.post?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/CreateReplayJobRequest",
    );
    expect(cancellation?.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/RequestReplayCancellation",
    );

    for (const mutation of [target?.post, plan?.post, job?.post, cancellation]) {
      expect(mutation?.responses).toHaveProperty("200");
      expect(mutation?.responses).toHaveProperty("201");
      expect(mutation?.responses).toHaveProperty("409");
      expect(mutation?.responses["200"]?.headers).toHaveProperty("Cache-Control");
      expect(mutation?.responses["201"]?.headers).toHaveProperty("Cache-Control");
      expect(mutation?.parameters.map(({ name }) => name)).toContain("X-ProofStack-CSRF");
    }
    for (const read of [target?.get, plan?.get, job?.get]) {
      expect(read?.responses).toHaveProperty("200");
      expect(read?.responses).toHaveProperty("404");
      expect(read?.responses["200"]?.headers).toHaveProperty("Cache-Control");
    }
    expect(cancellation?.responses).toHaveProperty("404");

    for (const schema of [
      "TargetReleaseDefinition",
      "PublishTargetReleaseResponse",
      "ReadTargetReleaseResponse",
      "ReplayPlanDefinition",
      "PublishReplayPlanResponse",
      "ReadReplayPlanResponse",
      "CreateReplayJobRequest",
      "CreateReplayJobResponse",
      "ReadReplayJobResponse",
      "RequestReplayCancellation",
      "RequestReplayCancellationResponse",
    ]) {
      expect(components).toHaveProperty(schema);
    }
    expect(Object.keys(paths).filter((path) => path.includes("replay"))).not.toEqual([]);
    expect(Object.keys(paths).some((path) => /latest|execute/.test(path))).toBe(false);
  });

  it("documents exact regression versions, idempotent publication, and bounded failures", () => {
    const document = createProofStackOpenApiDocument();
    const { paths: rawPaths } = document;
    const paths = rawPaths as Record<
      string,
      {
        get?: {
          parameters: Array<{ name: string }>;
          responses: Record<string, unknown>;
          security: unknown;
        };
        post?: {
          parameters: Array<{ name: string }>;
          responses: Record<string, unknown>;
          security: unknown;
        };
      }
    >;
    const fixtureCollection =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/versions"
      ]?.post;
    const fixtureVersion =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/versions/{fixtureVersionId}"
      ]?.get;
    const datasetCollection =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/{datasetId}/versions"
      ]?.post;
    const datasetVersion =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/{datasetId}/versions/{datasetVersionId}"
      ]?.get;

    for (const publication of [fixtureCollection, datasetCollection]) {
      expect(publication?.security).toEqual([{ browserSession: [] }]);
      expect(publication?.responses).toHaveProperty("200");
      expect(publication?.responses).toHaveProperty("201");
      expect(publication?.responses).toHaveProperty("404");
      expect(publication?.responses).toHaveProperty("409");
      expect(publication?.parameters.map(({ name }) => name)).toContain("X-ProofStack-CSRF");
    }
    expect(fixtureVersion?.parameters.map(({ name }) => name)).toEqual([
      "projectId",
      "environmentId",
      "fixtureId",
      "fixtureVersionId",
    ]);
    expect(datasetVersion?.parameters.map(({ name }) => name)).toEqual([
      "projectId",
      "environmentId",
      "datasetId",
      "datasetVersionId",
    ]);
    expect(fixtureVersion?.responses).toHaveProperty("404");
    expect(datasetVersion?.responses).toHaveProperty("404");
  });

  it("documents the complete artifact and recorded-interaction lifecycle", () => {
    const document = createProofStackOpenApiDocument();
    const { components: rawComponents, paths: rawPaths } = document;
    const components = (rawComponents as { schemas: Record<string, unknown> }).schemas;
    const paths = rawPaths as Record<
      string,
      {
        delete?: {
          parameters: Array<{ name: string }>;
          responses: Record<string, unknown>;
          security: unknown;
        };
        get?: {
          responses: Record<
            string,
            { content?: Record<string, unknown>; headers?: Record<string, unknown> }
          >;
          security: unknown;
        };
        post?: {
          parameters: Array<{ name: string }>;
          responses: Record<
            string,
            { content?: Record<string, unknown>; headers?: Record<string, unknown> }
          >;
          security: unknown;
        };
        put?: {
          requestBody: { content: Record<string, unknown> };
          responses: Record<string, unknown>;
          security: unknown;
        };
      }
    >;
    const artifactCollection =
      paths["/v1/projects/{projectId}/environments/{environmentId}/artifacts"]?.post;
    const artifact =
      paths["/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}"];
    const content =
      paths["/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}/content"];
    const purge =
      paths["/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}/purge"]
        ?.post;
    const interactionCollection =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions"
      ]?.post;
    const interactionVersion =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}"
      ]?.get;
    const revocation =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/revocation"
      ]?.post;
    const metadataExport =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/export"
      ]?.get;
    const contentExport =
      paths[
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/export/content"
      ]?.post;

    expect(artifactCollection?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
    expect(artifactCollection?.responses).toHaveProperty("200");
    expect(artifactCollection?.responses).toHaveProperty("201");
    expect(artifactCollection?.responses).toHaveProperty("409");
    expect(artifactCollection?.responses).toHaveProperty("503");
    expect(artifactCollection?.parameters.map(({ name }) => name)).toContain("X-ProofStack-CSRF");

    expect(artifact?.get?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
    expect(artifact?.delete?.security).toEqual([{ browserSession: [] }]);
    expect(artifact?.delete?.parameters.map(({ name }) => name)).toContain("X-ProofStack-CSRF");
    expect(artifact?.delete?.responses).toHaveProperty("409");
    expect(content?.put?.requestBody.content).toHaveProperty("application/octet-stream");
    for (const status of ["200", "404", "409", "413", "415", "422", "503"]) {
      expect(content?.put?.responses).toHaveProperty(status);
    }
    expect(content?.get?.responses["200"]?.content).toHaveProperty("application/octet-stream");
    expect(content?.get?.responses["200"]?.headers).toHaveProperty("X-ProofStack-Artifact-Sha256");
    expect(purge?.security).toEqual([{ browserSession: [] }]);
    expect(purge?.responses).toHaveProperty("409");

    for (const mutation of [interactionCollection, revocation]) {
      expect(mutation?.security).toEqual([{ browserSession: [] }]);
      expect(mutation?.responses).toHaveProperty("200");
      expect(mutation?.responses).toHaveProperty("201");
      expect(mutation?.responses).toHaveProperty("404");
      expect(mutation?.responses).toHaveProperty("409");
      expect(mutation?.parameters.map(({ name }) => name)).toContain("X-ProofStack-CSRF");
    }
    expect(interactionVersion?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
    expect(interactionVersion?.responses).toHaveProperty("404");

    expect(metadataExport?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
    expect(metadataExport?.responses).toHaveProperty("200");
    expect(metadataExport?.responses).toHaveProperty("404");
    expect(metadataExport?.responses).toHaveProperty("409");
    expect(metadataExport?.responses).toHaveProperty("503");
    expect(metadataExport?.responses["200"]?.headers).toHaveProperty("Cache-Control");

    expect(contentExport?.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
    expect(contentExport?.responses).toHaveProperty("200");
    expect(contentExport?.responses).toHaveProperty("404");
    expect(contentExport?.responses).toHaveProperty("409");
    expect(contentExport?.responses).toHaveProperty("413");
    expect(contentExport?.responses).toHaveProperty("503");
    expect(contentExport?.responses["200"]?.headers).toHaveProperty("Cache-Control");
    expect(contentExport?.parameters.map(({ name }) => name)).toContain("X-ProofStack-CSRF");
    expect(contentExport).toMatchObject({
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ExportRecordedInteractionFixtureContentRequest" },
          },
        },
        required: true,
      },
    });

    for (const schema of [
      "ReserveArtifactRequest",
      "ReserveArtifactResponse",
      "ReadArtifactMetadataResponse",
      "PublishInteractionFixtureVersionRequest",
      "PublishRecordedInteractionFixtureVersionResponse",
      "ReadRecordedInteractionFixtureMetadataResponse",
      "ExportRecordedInteractionFixtureMetadataResponse",
      "ExportRecordedInteractionFixtureContentRequest",
      "ExportRecordedInteractionFixtureContentResponse",
      "RevokeRecordedInteractionFixtureContentResponse",
    ]) {
      expect(components).toHaveProperty(schema);
    }
  });

  it("documents the workload-only OTLP protocol and routing boundary", () => {
    const document = createProofStackOpenApiDocument();
    const { paths: rawPaths } = document;
    const paths = rawPaths as Record<
      string,
      {
        post: {
          parameters: Array<{ name: string }>;
          requestBody: { content: Record<string, unknown> };
          responses: Record<string, { content: Record<string, unknown> }>;
          security: unknown;
        };
      }
    >;
    const route = paths["/v1/traces"]?.post;

    expect(route?.security).toEqual([{ bearerAuth: [] }]);
    expect(route?.parameters.map(({ name }) => name)).toEqual([
      "X-ProofStack-Project-Id",
      "X-ProofStack-Environment-Id",
    ]);
    expect(route?.requestBody.content).toHaveProperty("application/json");
    expect(route?.requestBody.content).toHaveProperty("application/x-protobuf");
    for (const status of ["200", "400", "401", "403", "409", "413", "415", "429", "500", "503"]) {
      expect(route?.responses[status]?.content).toHaveProperty("application/json");
      expect(route?.responses[status]?.content).toHaveProperty("application/x-protobuf");
    }
  });

  it("resolves every local schema reference", () => {
    const document = createProofStackOpenApiDocument();
    const { components: rawComponents } = document;
    const components = (rawComponents as { schemas: Record<string, unknown> }).schemas;
    const references = collectReferences(document);

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference).toMatch(/^#\/components\/schemas\/[A-Za-z0-9_]+$/);
      expect(components[reference.slice("#/components/schemas/".length)]).toBeDefined();
    }
  });

  it("publishes input defaults as optional request fields", () => {
    const document = createProofStackOpenApiDocument();
    const { components } = document;
    const schemas = (components as { schemas: Record<string, unknown> }).schemas;
    const { IngestEvidenceRequest } = schemas;
    const request = IngestEvidenceRequest as {
      properties: { events: { items: { required: string[] } } };
    };

    expect(request.properties.events.items.required).not.toContain("attributes");
    expect(request.properties.events.items.required).toContain("eventId");
  });

  it("documents dependency readiness failures", () => {
    const document = createProofStackOpenApiDocument();
    const { paths: rawPaths } = document;
    const paths = rawPaths as Record<string, { get: { responses: Record<string, unknown> } }>;

    expect(paths["/health/ready"]?.get.responses).toHaveProperty("503");
  });

  it("documents workload and browser authentication with user-only identity administration", () => {
    const document = createProofStackOpenApiDocument();
    const { components: rawComponents, paths: rawPaths } = document;
    const components = rawComponents as {
      securitySchemes: Record<string, unknown>;
    };
    const paths = rawPaths as Record<
      string,
      { post: { responses: Record<string, unknown>; security: unknown } }
    >;

    expect(components.securitySchemes).toHaveProperty("bearerAuth");
    expect(components.securitySchemes).toHaveProperty("browserSession");
    for (const path of [
      "/v1/identity/api-keys",
      "/v1/identity/api-keys/{credentialId}/revoke",
      "/v1/identity/api-keys/{credentialId}/rotate",
    ]) {
      expect(paths[path]?.post.security).toEqual([{ browserSession: [] }]);
    }
    expect(paths["/v1/identity/api-keys"]?.post.responses).toHaveProperty("401");
    expect(paths["/v1/identity/api-keys/{credentialId}/rotate"]?.post.responses).toHaveProperty(
      "409",
    );
  });

  it("documents the complete OIDC browser lifecycle and CSRF boundary", () => {
    const document = createProofStackOpenApiDocument();
    const { paths: rawPaths } = document;
    const paths = rawPaths as Record<
      string,
      {
        get?: { responses: Record<string, unknown>; security?: unknown };
        post?: { parameters?: Array<{ name: string }>; security?: unknown };
      }
    >;

    expect(paths["/v1/auth/oidc/login"]?.get?.responses).toHaveProperty("302");
    expect(paths["/v1/auth/oidc/callback"]?.get?.responses).toHaveProperty("303");
    expect(paths["/v1/auth/session"]?.get?.security).toEqual([{ browserSession: [] }]);
    expect(paths["/v1/auth/oidc/logout"]?.post?.security).toEqual([{ browserSession: [] }]);
    expect(paths["/v1/auth/oidc/logout"]?.post?.parameters?.map(({ name }) => name)).toEqual([
      "Origin",
      "X-ProofStack-CSRF",
    ]);
  });
});
