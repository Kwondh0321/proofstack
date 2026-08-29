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
      info: { version: "0.4.0-workflow-1" },
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
        "/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/{datasetId}/versions":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/{datasetId}/versions/{datasetVersionId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/versions":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/versions/{fixtureVersionId}":
          {},
        "/v1/projects/{projectId}/environments/{environmentId}/traces/{traceId}": {},
      },
    });
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
