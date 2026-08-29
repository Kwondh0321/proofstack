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
  PublishRegressionDatasetVersionResponseSchema,
  PublishRegressionFixtureVersionResponseSchema,
  ReadRegressionDatasetVersionResponseSchema,
  ReadRegressionFixtureVersionResponseSchema,
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
import {
  PublishRegressionDatasetVersionRequestSchema,
  PublishRegressionFixtureVersionRequestSchema,
} from "./dataset.js";
import { EVIDENCE_SCHEMA_VERSION, IngestEvidenceRequestSchema } from "./evidence.js";
import { OpaqueIdSchema, TraceIdSchema } from "./primitives.js";

export const PROOFSTACK_OPENAPI_VERSION = "3.2.0" as const;
export const PROOFSTACK_API_VERSION = "0.4.0-workflow-1" as const;

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

const fixtureParameter = {
  description: "Opaque logical regression fixture identifier within the authorized scope",
  in: "path",
  name: "fixtureId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const fixtureVersionParameter = {
  description: "Exact immutable regression fixture version identifier",
  in: "path",
  name: "fixtureVersionId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const datasetParameter = {
  description: "Opaque logical regression dataset identifier within the authorized scope",
  in: "path",
  name: "datasetId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const datasetVersionParameter = {
  description: "Exact immutable regression dataset version identifier",
  in: "path",
  name: "datasetVersionId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const bearerSecurity = [{ bearerAuth: [] }] as const;
const browserSecurity = [{ browserSession: [] }] as const;
const userOrWorkloadSecurity = [...bearerSecurity, ...browserSecurity] as const;

const otlpRoutingParameters = [
  {
    description: "Opaque project identifier authorized within the authenticated tenant",
    in: "header",
    name: "X-ProofStack-Project-Id",
    required: true,
    schema: schemaReference("OpaqueId"),
  },
  {
    description: "Opaque environment identifier authorized within the selected project",
    in: "header",
    name: "X-ProofStack-Environment-Id",
    required: true,
    schema: schemaReference("OpaqueId"),
  },
] as const;

const otlpProtobufBody = {
  schema: {
    description: "Binary Protobuf message",
    format: "binary",
    type: "string",
  },
} as const;

const otlpJsonRequestBody = {
  schema: {
    additionalProperties: true,
    description:
      "OTLP 1.11 opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest JSON mapping",
    type: "object",
  },
} as const;

const otlpJsonResponseBody = {
  schema: {
    additionalProperties: false,
    description:
      "OTLP 1.11 opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse JSON mapping",
    properties: {
      partialSuccess: {
        additionalProperties: false,
        properties: {
          errorMessage: { type: "string" },
          rejectedSpans: { pattern: "^-?[0-9]+$", type: "string" },
        },
        required: ["rejectedSpans", "errorMessage"],
        type: "object",
      },
    },
    type: "object",
  },
} as const;

const otlpJsonStatusBody = {
  schema: {
    additionalProperties: true,
    description: "google.rpc.Status Protobuf JSON mapping",
    properties: {
      code: { format: "int32", type: "integer" },
      message: { type: "string" },
    },
    required: ["message"],
    type: "object",
  },
} as const;

function otlpFailureResponse(description: string): Record<string, unknown> {
  return {
    content: {
      "application/json": otlpJsonStatusBody,
      "application/x-protobuf": {
        ...otlpProtobufBody,
        "x-protobuf-message": "google.rpc.Status",
      },
    },
    description,
  };
}

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

const regressionNotFoundResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "The exact version, source trace, or referenced fixture version does not exist in the authorized scope",
} as const;

const regressionConflictResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "The immutable version identifier conflicts with another definition or violates logical-resource lineage",
} as const;

export function createProofStackOpenApiDocument(): Record<string, unknown> {
  const schemas = {
    ...componentsFor("OpaqueId", OpaqueIdSchema, "input"),
    ...componentsFor("TraceId", TraceIdSchema, "input"),
    ...componentsFor("IngestEvidenceRequest", IngestEvidenceRequestSchema, "input"),
    ...componentsFor("IngestEvidenceResponse", IngestEvidenceResponseSchema, "output"),
    ...componentsFor("TraceResponse", TraceResponseSchema, "output"),
    ...componentsFor("TracePageCursor", TracePageCursorSchema, "input"),
    ...componentsFor(
      "PublishRegressionFixtureVersionRequest",
      PublishRegressionFixtureVersionRequestSchema,
      "input",
    ),
    ...componentsFor(
      "PublishRegressionFixtureVersionResponse",
      PublishRegressionFixtureVersionResponseSchema,
      "output",
    ),
    ...componentsFor(
      "ReadRegressionFixtureVersionResponse",
      ReadRegressionFixtureVersionResponseSchema,
      "output",
    ),
    ...componentsFor(
      "PublishRegressionDatasetVersionRequest",
      PublishRegressionDatasetVersionRequestSchema,
      "input",
    ),
    ...componentsFor(
      "PublishRegressionDatasetVersionResponse",
      PublishRegressionDatasetVersionResponseSchema,
      "output",
    ),
    ...componentsFor(
      "ReadRegressionDatasetVersionResponse",
      ReadRegressionDatasetVersionResponseSchema,
      "output",
    ),
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
        "API for authenticated tenant-scoped evidence, OTLP/HTTP trace ingestion, trace inspection, immutable evidence-only regression fixture and dataset versions, workload credentials, and OIDC browser sessions.",
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
      "/v1/traces": {
        post: {
          description:
            "Accepts the stable OTLP 1.11 trace service request. Authentication runs before protected routing validation. Tenant ownership comes only from the workload principal; the required project and environment headers request an authorized scope and never grant it. Known GenAI content fields are removed before evidence persistence.",
          externalDocs: {
            description: "ProofStack OTLP/HTTP compatibility profile",
            url: "https://github.com/Kwondh0321/proofstack/blob/main/docs/architecture/0010-otlp-http-trace-ingestion.md",
          },
          operationId: "exportOtlpTraces",
          parameters: otlpRoutingParameters,
          requestBody: {
            content: {
              "application/json": otlpJsonRequestBody,
              "application/x-protobuf": {
                ...otlpProtobufBody,
                "x-protobuf-message":
                  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
              },
            },
            required: true,
          },
          responses: {
            "200": {
              content: {
                "application/json": otlpJsonResponseBody,
                "application/x-protobuf": {
                  ...otlpProtobufBody,
                  "x-protobuf-message":
                    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse",
                },
              },
              description:
                "Full or partial success. A partial success is not a request to retry rejected spans.",
            },
            "400": otlpFailureResponse("The OTLP request or routing headers are invalid"),
            "401": otlpFailureResponse("Workload authentication is missing or invalid"),
            "403": otlpFailureResponse("The workload cannot ingest into the requested scope"),
            "409": otlpFailureResponse(
              "A deterministic event identity conflicts with different stored evidence",
            ),
            "413": otlpFailureResponse("The compressed or decompressed body limit was exceeded"),
            "415": otlpFailureResponse("The media type or content encoding is unsupported"),
            "429": otlpFailureResponse("The authenticated workload rate limit was exceeded"),
            "500": otlpFailureResponse("An unexpected ingestion error occurred"),
            "503": otlpFailureResponse("Atomic evidence persistence is unavailable"),
          },
          security: bearerSecurity,
          summary: "Export OTLP traces",
          tags: ["Telemetry"],
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
      "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/versions":
        {
          post: {
            description:
              "Captures the currently observed bounded trace evidence into an immutable evidence-only fixture version. Requires a browser-authenticated user with dataset:manage and evidence:read; dataset:manage is not delegable to workload keys. A semantically equivalent retry returns the original version with created=false.",
            operationId: "publishRegressionFixtureVersion",
            parameters: [
              projectParameter,
              environmentParameter,
              fixtureParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("PublishRegressionFixtureVersionRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: schemaReference("PublishRegressionFixtureVersionResponse"),
                  },
                },
                description: "An identical retry returned the original immutable fixture version",
              },
              "201": {
                content: {
                  "application/json": {
                    schema: schemaReference("PublishRegressionFixtureVersionResponse"),
                  },
                },
                description: "A new immutable evidence-only fixture version was created",
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
              "409": regressionConflictResponse,
            },
            security: browserSecurity,
            summary: "Publish a regression fixture version",
            tags: ["Regression"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/versions/{fixtureVersionId}":
        {
          get: {
            description:
              "Returns one exact immutable fixture version. Logical-resource mismatches and absent versions share the same scope-safe not-found response.",
            operationId: "getRegressionFixtureVersion",
            parameters: [
              projectParameter,
              environmentParameter,
              fixtureParameter,
              fixtureVersionParameter,
            ],
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: schemaReference("ReadRegressionFixtureVersionResponse"),
                  },
                },
                description: "The exact immutable fixture version",
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Read an exact regression fixture version",
            tags: ["Regression"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/{datasetId}/versions":
        {
          post: {
            description:
              "Pins an ordered set of exact fixture versions and their definition digests into an immutable dataset version. Requires a browser-authenticated user with dataset:manage; that capability is not delegable to workload keys. An equivalent retry returns the original version with created=false.",
            operationId: "publishRegressionDatasetVersion",
            parameters: [
              projectParameter,
              environmentParameter,
              datasetParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("PublishRegressionDatasetVersionRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: schemaReference("PublishRegressionDatasetVersionResponse"),
                  },
                },
                description: "An identical retry returned the original immutable dataset version",
              },
              "201": {
                content: {
                  "application/json": {
                    schema: schemaReference("PublishRegressionDatasetVersionResponse"),
                  },
                },
                description: "A new immutable dataset version was created",
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
              "409": regressionConflictResponse,
            },
            security: browserSecurity,
            summary: "Publish a regression dataset version",
            tags: ["Regression"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/{datasetId}/versions/{datasetVersionId}":
        {
          get: {
            description:
              "Returns one exact immutable dataset version and its pinned fixture-version digests. Logical-resource mismatches and absent versions share the same scope-safe not-found response.",
            operationId: "getRegressionDatasetVersion",
            parameters: [
              projectParameter,
              environmentParameter,
              datasetParameter,
              datasetVersionParameter,
            ],
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: schemaReference("ReadRegressionDatasetVersionResponse"),
                  },
                },
                description: "The exact immutable dataset version",
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Read an exact regression dataset version",
            tags: ["Regression"],
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
          security: browserSecurity,
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
          security: browserSecurity,
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
          security: browserSecurity,
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
      {
        description: "Immutable evidence-only fixture and dataset version lifecycle",
        name: "Regression",
      },
      { description: "OpenTelemetry-compatible ingestion", name: "Telemetry" },
    ],
    "x-proofstack-evidence-schema-version": EVIDENCE_SCHEMA_VERSION,
  };
}
