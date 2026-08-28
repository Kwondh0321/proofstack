import { type ZodType, z } from "zod";
import {
  BrowserLoginQuerySchema,
  BrowserLogoutResponseSchema,
  BrowserReturnPathSchema,
  BrowserSessionResponseSchema,
  DEFAULT_TRACE_PAGE_SIZE,
  IngestEvidenceResponseSchema,
  LivenessResponseSchema,
  MAX_TRACE_PAGE_SIZE,
  OidcStateSchema,
  ProblemDocumentSchema,
  ReadinessResponseSchema,
  TracePageCursorSchema,
  TraceResponseSchema,
} from "./api.js";
import {
  IssueApiKeyRequestSchema,
  IssueApiKeyResponseSchema,
  RevokeApiKeyRequestSchema,
  RevokeApiKeyResponseSchema,
  RotateApiKeyRequestSchema,
  RotateApiKeyResponseSchema,
} from "./api-key.js";
import { EVIDENCE_SCHEMA_VERSION, IngestEvidenceRequestSchema } from "./evidence.js";
import { OpaqueIdSchema, TraceIdSchema } from "./primitives.js";

export const PROOFSTACK_OPENAPI_VERSION = "3.2.0" as const;
export const PROOFSTACK_API_VERSION = "0.2.0-foundation" as const;

type JsonSchemaObject = Record<string, unknown>;
type SchemaIo = "input" | "output";

function isObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewriteDefinitionReferences(value: unknown, componentName: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteDefinitionReferences(item, componentName));
  }
  if (!isObject(value)) return value;

  const rewritten: JsonSchemaObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "$defs") continue;
    if (key === "$ref" && typeof child === "string" && child.startsWith("#/$defs/")) {
      rewritten[key] = `#/components/schemas/${componentName}__${child.slice(8)}`;
      continue;
    }
    rewritten[key] = rewriteDefinitionReferences(child, componentName);
  }
  return rewritten;
}

function componentsFor(
  componentName: string,
  schema: ZodType,
  io: SchemaIo,
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    io,
    reused: "inline",
    target: "draft-2020-12",
  }) as JsonSchemaObject;

  const components: Record<string, unknown> = {
    [componentName]: rewriteDefinitionReferences(generated, componentName),
  };

  const { $defs } = generated;
  if (isObject($defs)) {
    for (const [definitionName, definition] of Object.entries($defs)) {
      components[`${componentName}__${definitionName}`] = rewriteDefinitionReferences(
        definition,
        componentName,
      );
    }
  }

  return components;
}

function schemaReference(name: string): { readonly $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

const projectParameter = {
  description: "Opaque project identifier within the authenticated tenant",
  in: "path",
  name: "projectId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const environmentParameter = {
  description: "Opaque environment identifier within the project",
  in: "path",
  name: "environmentId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const credentialParameter = {
  description: "Opaque API key credential identifier within the authenticated tenant",
  in: "path",
  name: "credentialId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const bearerSecurity = [{ bearerAuth: [] }] as const;
const browserSecurity = [{ browserSession: [] }] as const;
const userOrWorkloadSecurity = [...bearerSecurity, ...browserSecurity] as const;

const browserMutationParameters = [
  {
    description: "Required with browser-session authentication and must match the allowed origin",
    in: "header",
    name: "Origin",
    required: false,
    schema: { type: "string" },
  },
  {
    description:
      "Required with browser-session authentication and must equal the __Host-proofstack_csrf cookie",
    in: "header",
    name: "X-ProofStack-CSRF",
    required: false,
    schema: { type: "string" },
  },
] as const;

const problemResponses = {
  "400": {
    content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
    description: "The request does not match the required contract",
  },
  "401": {
    content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
    description: "Authentication is missing or invalid",
  },
  "403": {
    content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
    description: "The authenticated principal is not authorized",
  },
  "429": {
    content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
    description: "The request rate limit was exceeded",
  },
  "500": {
    content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
    description: "An unexpected error occurred",
  },
} as const;

export function createProofStackOpenApiDocument(): Record<string, unknown> {
  const schemas = {
    ...componentsFor("OpaqueId", OpaqueIdSchema, "input"),
    ...componentsFor("TraceId", TraceIdSchema, "input"),
    ...componentsFor("IngestEvidenceRequest", IngestEvidenceRequestSchema, "input"),
    ...componentsFor("IngestEvidenceResponse", IngestEvidenceResponseSchema, "output"),
    ...componentsFor("TraceResponse", TraceResponseSchema, "output"),
    ...componentsFor("TracePageCursor", TracePageCursorSchema, "input"),
    ...componentsFor("ProblemDocument", ProblemDocumentSchema, "output"),
    ...componentsFor("LivenessResponse", LivenessResponseSchema, "output"),
    ...componentsFor("ReadinessResponse", ReadinessResponseSchema, "output"),
    ...componentsFor("BrowserLoginQuery", BrowserLoginQuerySchema, "input"),
    ...componentsFor("BrowserReturnPath", BrowserReturnPathSchema, "input"),
    ...componentsFor("OidcState", OidcStateSchema, "input"),
    ...componentsFor("BrowserSessionResponse", BrowserSessionResponseSchema, "output"),
    ...componentsFor("BrowserLogoutResponse", BrowserLogoutResponseSchema, "output"),
    ...componentsFor("IssueApiKeyRequest", IssueApiKeyRequestSchema, "input"),
    ...componentsFor("IssueApiKeyResponse", IssueApiKeyResponseSchema, "output"),
    ...componentsFor("RotateApiKeyRequest", RotateApiKeyRequestSchema, "input"),
    ...componentsFor("RotateApiKeyResponse", RotateApiKeyResponseSchema, "output"),
    ...componentsFor("RevokeApiKeyRequest", RevokeApiKeyRequestSchema, "input"),
    ...componentsFor("RevokeApiKeyResponse", RevokeApiKeyResponseSchema, "output"),
  };

  return {
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          bearerFormat: "ProofStack API key",
          description: "A complete ProofStack API key presented only in the Authorization header",
          scheme: "bearer",
          type: "http",
        },
        browserSession: {
          description:
            "An HttpOnly host-only browser session cookie. Unsafe requests also require exact Origin and double-submit CSRF verification.",
          in: "cookie",
          name: "__Host-proofstack_session",
          type: "apiKey",
        },
      },
    },
    info: {
      description:
        "Foundation API for authenticated tenant-scoped evidence, trace inspection, workload credentials, and OIDC browser sessions.",
      license: { identifier: "Apache-2.0", name: "Apache License 2.0" },
      title: "ProofStack API",
      version: PROOFSTACK_API_VERSION,
    },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    openapi: PROOFSTACK_OPENAPI_VERSION,
    paths: {
      "/health/live": {
        get: {
          operationId: "getLiveness",
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("LivenessResponse") },
              },
              description: "The process is running",
            },
          },
          summary: "Check process liveness",
          tags: ["Health"],
        },
      },
      "/health/ready": {
        get: {
          operationId: "getReadiness",
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("ReadinessResponse") },
              },
              description: "The API is ready to accept requests",
            },
            "503": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "A required dependency is unavailable or not initialized",
            },
          },
          summary: "Check API readiness",
          tags: ["Health"],
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          responses: { "200": { description: "The canonical OpenAPI description" } },
          summary: "Read the API contract",
          tags: ["Metadata"],
        },
      },
      "/v1/auth/oidc/login": {
        get: {
          description:
            "Starts an Authorization Code flow with PKCE, nonce, one-time state, and a browser-bound interaction cookie.",
          operationId: "beginOidcLogin",
          parameters: [
            {
              description: "Local path to restore after successful login",
              in: "query",
              name: "returnTo",
              required: false,
              schema: schemaReference("BrowserReturnPath"),
            },
          ],
          responses: {
            "302": {
              description: "Redirect to the configured OIDC provider",
              headers: {
                Location: { description: "Validated provider authorization URL" },
                "Set-Cookie": { description: "Short-lived browser interaction binding" },
              },
            },
            "400": problemResponses["400"],
            "429": problemResponses["429"],
            "500": problemResponses["500"],
          },
          summary: "Begin browser login",
          tags: ["Identity"],
        },
      },
      "/v1/auth/oidc/callback": {
        get: {
          description:
            "Validates the browser interaction, one-time state, PKCE verifier, nonce, provider identity, and active local binding before issuing a session.",
          operationId: "completeOidcLogin",
          parameters: [
            {
              description: "One-time canonical OIDC state returned by the provider",
              in: "query",
              name: "state",
              required: true,
              schema: schemaReference("OidcState"),
            },
          ],
          responses: {
            "303": {
              description: "Session created and redirected to the validated local return path",
              headers: {
                Location: { description: "Validated local return path" },
                "Set-Cookie": {
                  description:
                    "Hardened session and CSRF cookies; the interaction cookie is cleared",
                },
              },
            },
            "400": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "The OIDC login is invalid, expired, or does not belong to this browser",
            },
            "429": problemResponses["429"],
            "500": problemResponses["500"],
          },
          summary: "Complete browser login",
          tags: ["Identity"],
        },
      },
      "/v1/auth/session": {
        get: {
          operationId: "getBrowserSession",
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("BrowserSessionResponse") },
              },
              description: "Current tenant authorization derived from the active OIDC binding",
            },
            "401": problemResponses["401"],
            "429": problemResponses["429"],
            "500": problemResponses["500"],
          },
          security: browserSecurity,
          summary: "Read the browser session",
          tags: ["Identity"],
        },
      },
      "/v1/auth/oidc/logout": {
        post: {
          description:
            "Requires exact Origin and double-submit CSRF verification, revokes the server-side session, and clears every ProofStack browser cookie.",
          operationId: "revokeBrowserSession",
          parameters: browserMutationParameters,
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("BrowserLogoutResponse") },
              },
              description: "Session revocation result",
            },
            ...problemResponses,
          },
          security: browserSecurity,
          summary: "Log out the browser session",
          tags: ["Identity"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/evidence": {
        post: {
          description:
            "The authenticated server context assigns tenant ownership. Client payloads cannot select a tenant.",
          operationId: "ingestEvidence",
          parameters: [projectParameter, environmentParameter, ...browserMutationParameters],
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("IngestEvidenceRequest") },
            },
            required: true,
          },
          responses: {
            "202": {
              content: {
                "application/json": { schema: schemaReference("IngestEvidenceResponse") },
              },
              description: "The evidence batch was accepted or identified as duplicate delivery",
            },
            ...problemResponses,
            "409": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "An event identifier was reused with different evidence",
            },
            "413": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "The request body exceeds the configured limit",
            },
          },
          security: userOrWorkloadSecurity,
          summary: "Ingest a bounded evidence batch",
          tags: ["Evidence"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/traces/{traceId}": {
        get: {
          description:
            "Returns an ordered, bounded evidence page. Follow nextCursor to read additional events. An unknown trace identifier returns a problem document.",
          operationId: "getTraceEvidence",
          parameters: [
            projectParameter,
            environmentParameter,
            {
              description: "W3C-compatible 16-byte lowercase trace identifier",
              in: "path",
              name: "traceId",
              required: true,
              schema: schemaReference("TraceId"),
            },
            {
              description: "Opaque cursor returned by the preceding trace page",
              in: "query",
              name: "cursor",
              required: false,
              schema: schemaReference("TracePageCursor"),
            },
            {
              description: "Maximum evidence events to return",
              in: "query",
              name: "limit",
              required: false,
              schema: {
                default: DEFAULT_TRACE_PAGE_SIZE,
                maximum: MAX_TRACE_PAGE_SIZE,
                minimum: 1,
                type: "integer",
              },
            },
          ],
          responses: {
            "200": {
              content: { "application/json": { schema: schemaReference("TraceResponse") } },
              description: "Tenant-scoped evidence for the trace",
            },
            "404": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "No evidence exists for the trace in the authorized scope",
            },
            ...problemResponses,
          },
          security: userOrWorkloadSecurity,
          summary: "Read a causal trace",
          tags: ["Evidence"],
        },
      },
      "/v1/identity/api-keys": {
        post: {
          description:
            "Creates a capability- and resource-scoped workload credential. The complete key value is returned only in this response.",
          operationId: "issueApiKey",
          parameters: browserMutationParameters,
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("IssueApiKeyRequest") },
            },
            required: true,
          },
          responses: {
            "201": {
              content: {
                "application/json": { schema: schemaReference("IssueApiKeyResponse") },
              },
              description: "A new workload credential and its one-time value",
            },
            ...problemResponses,
            "503": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "Identity management storage is unavailable",
            },
          },
          security: userOrWorkloadSecurity,
          summary: "Issue a workload API key",
          tags: ["Identity"],
        },
      },
      "/v1/identity/api-keys/{credentialId}/revoke": {
        post: {
          operationId: "revokeApiKey",
          parameters: [credentialParameter, ...browserMutationParameters],
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("RevokeApiKeyRequest") },
            },
            required: true,
          },
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("RevokeApiKeyResponse") },
              },
              description: "The credential is revoked or was already revoked",
            },
            ...problemResponses,
            "404": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "The credential does not exist in the authenticated tenant",
            },
            "503": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "Identity management storage is unavailable",
            },
          },
          security: userOrWorkloadSecurity,
          summary: "Revoke a workload API key",
          tags: ["Identity"],
        },
      },
      "/v1/identity/api-keys/{credentialId}/rotate": {
        post: {
          description:
            "Atomically revokes the previous credential and returns an independently generated replacement value once.",
          operationId: "rotateApiKey",
          parameters: [credentialParameter, ...browserMutationParameters],
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("RotateApiKeyRequest") },
            },
            required: false,
          },
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("RotateApiKeyResponse") },
              },
              description: "The independently generated replacement credential and one-time value",
            },
            ...problemResponses,
            "404": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "The credential does not exist in the authenticated tenant",
            },
            "409": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "The credential is expired, revoked, or already rotated",
            },
            "503": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "Identity management storage is unavailable",
            },
          },
          security: userOrWorkloadSecurity,
          summary: "Rotate a workload API key",
          tags: ["Identity"],
        },
      },
    },
    servers: [{ url: "/" }],
    tags: [
      { description: "Process and dependency status", name: "Health" },
      { description: "Agent execution evidence", name: "Evidence" },
      { description: "OIDC browser identity and workload credential lifecycle", name: "Identity" },
      { description: "Machine-readable service metadata", name: "Metadata" },
    ],
    "x-proofstack-evidence-schema-version": EVIDENCE_SCHEMA_VERSION,
  };
}
