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
  it("describes the implemented foundation routes", () => {
    const document = createProofStackOpenApiDocument();

    expect(document).toMatchObject({
      info: { version: "0.1.0-foundation" },
      openapi: "3.2.0",
      paths: {
        "/health/live": {},
        "/health/ready": {},
        "/openapi.json": {},
        "/v1/identity/api-keys": {},
        "/v1/identity/api-keys/{credentialId}/revoke": {},
        "/v1/identity/api-keys/{credentialId}/rotate": {},
        "/v1/projects/{projectId}/environments/{environmentId}/evidence": {},
        "/v1/projects/{projectId}/environments/{environmentId}/traces/{traceId}": {},
      },
    });
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

  it("documents Bearer authentication and bounded credential lifecycle failures", () => {
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
    expect(paths["/v1/identity/api-keys"]?.post.security).toEqual([{ bearerAuth: [] }]);
    expect(paths["/v1/identity/api-keys"]?.post.responses).toHaveProperty("401");
    expect(paths["/v1/identity/api-keys/{credentialId}/rotate"]?.post.responses).toHaveProperty(
      "409",
    );
  });
});
