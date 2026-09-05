import { type ZodType, z } from "zod";
import {
  BrowserLoginQuerySchema,
  BrowserLogoutResponseSchema,
  BrowserReturnPathSchema,
  BrowserSessionResponseSchema,
  CreateReplayJobResponseSchema,
  DEFAULT_TRACE_PAGE_SIZE,
  ExportRecordedInteractionFixtureContentResponseSchema,
  ExportRecordedInteractionFixtureMetadataResponseSchema,
  IngestEvidenceResponseSchema,
  LivenessResponseSchema,
  MAX_TRACE_PAGE_SIZE,
  OidcStateSchema,
  ProblemDocumentSchema,
  PublishRecordedInteractionFixtureVersionResponseSchema,
  PublishRegressionDatasetVersionResponseSchema,
  PublishRegressionFixtureVersionResponseSchema,
  PublishReplayPlanResponseSchema,
  PublishTargetReleaseResponseSchema,
  PurgeArtifactResponseSchema,
  ReadArtifactMetadataResponseSchema,
  ReadinessResponseSchema,
  ReadRecordedInteractionFixtureMetadataResponseSchema,
  ReadRegressionDatasetVersionResponseSchema,
  ReadRegressionFixtureVersionResponseSchema,
  ReadReplayJobResponseSchema,
  ReadReplayPlanResponseSchema,
  ReadTargetReleaseResponseSchema,
  RequestReplayCancellationResponseSchema,
  ReserveArtifactResponseSchema,
  RevokeRecordedInteractionFixtureContentResponseSchema,
  TombstoneArtifactResponseSchema,
  TracePageCursorSchema,
  TraceResponseSchema,
  UploadArtifactResponseSchema,
} from "./api.js";
import {
  IssueApiKeyRequestSchema,
  IssueApiKeyResponseSchema,
  RevokeApiKeyRequestSchema,
  RevokeApiKeyResponseSchema,
  RotateApiKeyRequestSchema,
  RotateApiKeyResponseSchema,
} from "./api-key.js";
import { ReserveArtifactRequestSchema, TombstoneArtifactRequestSchema } from "./artifact.js";
import {
  PublishInteractionFixtureVersionRequestSchema,
  PublishRegressionDatasetVersionRequestSchema,
  PublishRegressionFixtureVersionRequestSchema,
  RevokeInteractionFixtureContentRequestSchema,
} from "./dataset.js";
import {
  CreateAssessmentRequestSchema,
  EvaluationRecordKindSchema,
  PublishEvaluationDefinitionRequestSchema,
  PublishEvaluationRecordResponseSchema,
  ReadEvaluationRecordResponseSchema,
  RecordCriterionSetStatusRequestSchema,
  RecordEvaluationRunDecisionRequestSchema,
} from "./evaluation-api.js";
import {
  ComparisonRecordKindSchema,
  PublishComparisonRecordResponseSchema,
  ReadComparisonRecordResponseSchema,
} from "./evaluation-comparison-api.js";
import {
  CreateComparisonEvidenceSnapshotRequestSchema,
  PublishComparisonDefinitionRequestSchema,
} from "./evaluation-comparison.js";
import { DeriveComparisonResultRequestSchema } from "./evaluation-comparison-result.js";
import {
  CreateModelAssuranceAssessmentRequestSchema,
  ModelAssuranceRecordKindSchema,
  PublishModelAssuranceDefinitionRequestSchema,
  PublishModelAssuranceRecordResponseSchema,
  ReadModelAssuranceRecordResponseSchema,
  RecordHumanReviewRequestSchema,
  RecordModelAssuranceExecutionRequestSchema,
} from "./evaluation-model-assurance-api.js";
import { EVIDENCE_SCHEMA_VERSION, IngestEvidenceRequestSchema } from "./evidence.js";
import { ExportRecordedInteractionFixtureContentRequestSchema } from "./interaction-export.js";
import { OpaqueIdSchema, TraceIdSchema } from "./primitives.js";
import { CreateReplayJobRequestSchema, RequestReplayCancellationSchema } from "./replay-job.js";
import { ReplayPlanDefinitionSchema, TargetReleaseDefinitionSchema } from "./replay-plan.js";

export const PROOFSTACK_OPENAPI_VERSION = "3.2.0" as const;
export const PROOFSTACK_API_VERSION = "0.9.0-workflow-1" as const;

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

const artifactParameter = {
  description: "Opaque immutable artifact identifier within the authorized scope",
  in: "path",
  name: "artifactId",
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

const targetParameter = {
  description: "Opaque logical replay target identifier within the authorized scope",
  in: "path",
  name: "targetId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const targetReleaseParameter = {
  description: "Exact immutable target release identifier",
  in: "path",
  name: "targetReleaseId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const replayPlanParameter = {
  description: "Opaque logical replay plan identifier within the authorized scope",
  in: "path",
  name: "planId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const replayPlanVersionParameter = {
  description: "Exact immutable replay plan version identifier",
  in: "path",
  name: "planVersionId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const replayJobParameter = {
  description: "Exact durable replay job identifier",
  in: "path",
  name: "jobId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const replayCancellationParameter = {
  description: "Exact immutable replay cancellation request identifier",
  in: "path",
  name: "cancellationId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const evaluationRecordParameter = {
  description: "Exact immutable evaluation record identifier",
  in: "path",
  name: "recordId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const evaluationRecordKindParameter = {
  description: "Exact evaluation record kind; aliases such as latest are not accepted",
  in: "path",
  name: "kind",
  required: true,
  schema: schemaReference("EvaluationRecordKind"),
} as const;

const comparisonParameter = {
  description: "Opaque logical comparison identifier within the authorized scope",
  in: "path",
  name: "comparisonId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const comparisonVersionParameter = {
  description: "Exact immutable comparison definition version identifier",
  in: "path",
  name: "comparisonVersionId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const comparisonSnapshotParameter = {
  description: "Exact immutable comparison evidence snapshot identifier",
  in: "path",
  name: "snapshotId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const comparisonResultParameter = {
  description: "Exact immutable derived comparison result identifier",
  in: "path",
  name: "resultId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const comparisonRecordParameter = {
  description: "Exact immutable comparison record identifier",
  in: "path",
  name: "recordId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const comparisonRecordKindParameter = {
  description: "Exact comparison record kind; mutable aliases are not accepted",
  in: "path",
  name: "kind",
  required: true,
  schema: schemaReference("ComparisonRecordKind"),
} as const;

const modelAssuranceRecordParameter = {
  description: "Exact immutable model-assurance record identifier",
  in: "path",
  name: "recordId",
  required: true,
  schema: schemaReference("OpaqueId"),
} as const;

const modelAssuranceRecordKindParameter = {
  description: "Exact model-assurance record kind; mutable aliases are not accepted",
  in: "path",
  name: "kind",
  required: true,
  schema: schemaReference("ModelAssuranceRecordKind"),
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

const artifactNotFoundResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description: "The artifact does not exist in the authorized scope",
} as const;

const artifactConflictResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "The artifact definition, lifecycle state, fixture ownership, or content availability conflicts with the operation",
} as const;

const artifactStorageUnavailableResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "Artifact catalog, content inspection, encryption, or immutable object storage is unavailable",
} as const;

const interactionExportConflictResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "The immutable fixture, artifact catalog, ownership, revocation, or purge state changed while the export was assembled",
} as const;

const replayNotFoundResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description: "The exact replay definition or job does not exist in the authorized scope",
} as const;

const replayConflictResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "The immutable replay identifier conflicts, required lineage is unavailable, or the job mutation is incompatible",
} as const;

const evaluationNotFoundResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description: "The exact evaluation record does not exist in the authorized scope",
} as const;

const evaluationConflictResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "The immutable record conflicts with existing semantics, tenant resources, or required lineage",
} as const;

const evaluationStorageUnavailableResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description: "Evaluation storage is unavailable or violated its public repository contract",
} as const;

const comparisonNotFoundResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description: "The exact comparison record does not exist in the authorized scope",
} as const;

const comparisonConflictResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "The immutable comparison conflicts with existing semantics, exact lineage, or authoritative source availability",
} as const;

const comparisonStorageUnavailableResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description: "Comparison storage is unavailable or violated its repository contract",
} as const;

const modelAssuranceNotFoundResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description: "The exact model-assurance record does not exist in the authorized scope",
} as const;

const modelAssuranceConflictResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description:
    "The immutable model-assurance record conflicts with existing semantics or exact lineage",
} as const;

const modelAssuranceStorageUnavailableResponse = {
  content: { "application/problem+json": { schema: schemaReference("ProblemDocument") } },
  description: "Model-assurance storage is unavailable or violated its repository contract",
} as const;

function replayJsonResponse(schemaName: string, description: string): Record<string, unknown> {
  return {
    content: { "application/json": { schema: schemaReference(schemaName) } },
    description,
    headers: {
      "Cache-Control": {
        description: "Replay control-plane responses are never cacheable",
        schema: { const: "no-store", type: "string" },
      },
    },
  };
}

function evaluationJsonResponse(schemaName: string, description: string): Record<string, unknown> {
  return {
    content: { "application/json": { schema: schemaReference(schemaName) } },
    description,
    headers: {
      "Cache-Control": {
        description: "Evaluation control-plane responses are never cacheable",
        schema: { const: "no-store", type: "string" },
      },
    },
  };
}

function comparisonJsonResponse(schemaName: string, description: string): Record<string, unknown> {
  return {
    content: { "application/json": { schema: schemaReference(schemaName) } },
    description,
    headers: {
      "Cache-Control": {
        description: "Comparison control-plane responses are never cacheable",
        schema: { const: "no-store", type: "string" },
      },
    },
  };
}

function modelAssuranceJsonResponse(
  schemaName: string,
  description: string,
): Record<string, unknown> {
  return {
    content: { "application/json": { schema: schemaReference(schemaName) } },
    description,
    headers: {
      "Cache-Control": {
        description: "Model-assurance responses are never cacheable",
        schema: { const: "no-store", type: "string" },
      },
    },
  };
}

export function createProofStackOpenApiDocument(): Record<string, unknown> {
  const schemas = {
    ...componentsFor("OpaqueId", OpaqueIdSchema, "input"),
    ...componentsFor("TraceId", TraceIdSchema, "input"),
    ...componentsFor("IngestEvidenceRequest", IngestEvidenceRequestSchema, "input"),
    ...componentsFor("IngestEvidenceResponse", IngestEvidenceResponseSchema, "output"),
    ...componentsFor("TraceResponse", TraceResponseSchema, "output"),
    ...componentsFor("TracePageCursor", TracePageCursorSchema, "input"),
    ...componentsFor("EvaluationRecordKind", EvaluationRecordKindSchema, "input"),
    ...componentsFor(
      "PublishEvaluationDefinitionRequest",
      PublishEvaluationDefinitionRequestSchema,
      "input",
    ),
    ...componentsFor(
      "RecordCriterionSetStatusRequest",
      RecordCriterionSetStatusRequestSchema,
      "input",
    ),
    ...componentsFor(
      "RecordEvaluationRunDecisionRequest",
      RecordEvaluationRunDecisionRequestSchema,
      "input",
    ),
    ...componentsFor("CreateAssessmentRequest", CreateAssessmentRequestSchema, "input"),
    ...componentsFor(
      "PublishEvaluationRecordResponse",
      PublishEvaluationRecordResponseSchema,
      "output",
    ),
    ...componentsFor("ReadEvaluationRecordResponse", ReadEvaluationRecordResponseSchema, "output"),
    ...componentsFor("ComparisonRecordKind", ComparisonRecordKindSchema, "input"),
    ...componentsFor(
      "PublishComparisonDefinitionRequest",
      PublishComparisonDefinitionRequestSchema,
      "input",
    ),
    ...componentsFor(
      "CreateComparisonEvidenceSnapshotRequest",
      CreateComparisonEvidenceSnapshotRequestSchema,
      "input",
    ),
    ...componentsFor("DeriveComparisonResultRequest", DeriveComparisonResultRequestSchema, "input"),
    ...componentsFor(
      "PublishComparisonRecordResponse",
      PublishComparisonRecordResponseSchema,
      "output",
    ),
    ...componentsFor("ReadComparisonRecordResponse", ReadComparisonRecordResponseSchema, "output"),
    ...componentsFor("ModelAssuranceRecordKind", ModelAssuranceRecordKindSchema, "input"),
    ...componentsFor(
      "PublishModelAssuranceDefinitionRequest",
      PublishModelAssuranceDefinitionRequestSchema,
      "input",
    ),
    ...componentsFor(
      "RecordModelAssuranceExecutionRequest",
      RecordModelAssuranceExecutionRequestSchema,
      "input",
    ),
    ...componentsFor("RecordHumanReviewRequest", RecordHumanReviewRequestSchema, "input"),
    ...componentsFor(
      "CreateModelAssuranceAssessmentRequest",
      CreateModelAssuranceAssessmentRequestSchema,
      "input",
    ),
    ...componentsFor(
      "PublishModelAssuranceRecordResponse",
      PublishModelAssuranceRecordResponseSchema,
      "output",
    ),
    ...componentsFor(
      "ReadModelAssuranceRecordResponse",
      ReadModelAssuranceRecordResponseSchema,
      "output",
    ),
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
    ...componentsFor("ReserveArtifactRequest", ReserveArtifactRequestSchema, "input"),
    ...componentsFor("ReserveArtifactResponse", ReserveArtifactResponseSchema, "output"),
    ...componentsFor("UploadArtifactResponse", UploadArtifactResponseSchema, "output"),
    ...componentsFor("ReadArtifactMetadataResponse", ReadArtifactMetadataResponseSchema, "output"),
    ...componentsFor("TombstoneArtifactRequest", TombstoneArtifactRequestSchema, "input"),
    ...componentsFor("TombstoneArtifactResponse", TombstoneArtifactResponseSchema, "output"),
    ...componentsFor("PurgeArtifactResponse", PurgeArtifactResponseSchema, "output"),
    ...componentsFor(
      "PublishInteractionFixtureVersionRequest",
      PublishInteractionFixtureVersionRequestSchema,
      "input",
    ),
    ...componentsFor(
      "PublishRecordedInteractionFixtureVersionResponse",
      PublishRecordedInteractionFixtureVersionResponseSchema,
      "output",
    ),
    ...componentsFor(
      "ReadRecordedInteractionFixtureMetadataResponse",
      ReadRecordedInteractionFixtureMetadataResponseSchema,
      "output",
    ),
    ...componentsFor(
      "ExportRecordedInteractionFixtureMetadataResponse",
      ExportRecordedInteractionFixtureMetadataResponseSchema,
      "output",
    ),
    ...componentsFor(
      "ExportRecordedInteractionFixtureContentRequest",
      ExportRecordedInteractionFixtureContentRequestSchema,
      "input",
    ),
    ...componentsFor(
      "ExportRecordedInteractionFixtureContentResponse",
      ExportRecordedInteractionFixtureContentResponseSchema,
      "output",
    ),
    ...componentsFor(
      "RevokeInteractionFixtureContentRequest",
      RevokeInteractionFixtureContentRequestSchema,
      "input",
    ),
    ...componentsFor(
      "RevokeRecordedInteractionFixtureContentResponse",
      RevokeRecordedInteractionFixtureContentResponseSchema,
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
    ...componentsFor("TargetReleaseDefinition", TargetReleaseDefinitionSchema, "input"),
    ...componentsFor("PublishTargetReleaseResponse", PublishTargetReleaseResponseSchema, "output"),
    ...componentsFor("ReadTargetReleaseResponse", ReadTargetReleaseResponseSchema, "output"),
    ...componentsFor("ReplayPlanDefinition", ReplayPlanDefinitionSchema, "input"),
    ...componentsFor("PublishReplayPlanResponse", PublishReplayPlanResponseSchema, "output"),
    ...componentsFor("ReadReplayPlanResponse", ReadReplayPlanResponseSchema, "output"),
    ...componentsFor("CreateReplayJobRequest", CreateReplayJobRequestSchema, "input"),
    ...componentsFor("CreateReplayJobResponse", CreateReplayJobResponseSchema, "output"),
    ...componentsFor("ReadReplayJobResponse", ReadReplayJobResponseSchema, "output"),
    ...componentsFor("RequestReplayCancellation", RequestReplayCancellationSchema, "input"),
    ...componentsFor(
      "RequestReplayCancellationResponse",
      RequestReplayCancellationResponseSchema,
      "output",
    ),
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
        "API for authenticated tenant-scoped evidence, OTLP/HTTP trace ingestion, trace inspection, encrypted immutable interaction artifacts, exact recorded fixture versions, evidence-only regression versions, immutable evaluation and evidence-comparison control, durable bounded replay control, workload credentials, and OIDC browser sessions.",
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
      "/v1/projects/{projectId}/environments/{environmentId}/artifacts": {
        post: {
          description:
            "Reserves one immutable, digest-bound artifact before content upload. An equivalent retry returns the original reservation. Browser callers must provide the mutation headers; workload callers require artifact:write within the exact requested scope.",
          operationId: "reserveArtifact",
          parameters: [projectParameter, environmentParameter, ...browserMutationParameters],
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("ReserveArtifactRequest") },
            },
            required: true,
          },
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("ReserveArtifactResponse") },
              },
              description: "An identical retry returned the existing immutable reservation",
            },
            "201": {
              content: {
                "application/json": { schema: schemaReference("ReserveArtifactResponse") },
              },
              description: "A new immutable artifact reservation was created",
            },
            ...problemResponses,
            "409": artifactConflictResponse,
            "503": artifactStorageUnavailableResponse,
          },
          security: userOrWorkloadSecurity,
          summary: "Reserve an immutable artifact",
          tags: ["Artifacts"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}": {
        delete: {
          description:
            "Tombstones an artifact without deleting ciphertext. This administrative capability is not delegable to workload keys, and fixture-owned artifacts can only be tombstoned through fixture revocation.",
          operationId: "tombstoneArtifact",
          parameters: [
            projectParameter,
            environmentParameter,
            artifactParameter,
            ...browserMutationParameters,
          ],
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("TombstoneArtifactRequest") },
            },
            required: true,
          },
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("TombstoneArtifactResponse") },
              },
              description: "An identical retry returned the existing tombstone",
            },
            "201": {
              content: {
                "application/json": { schema: schemaReference("TombstoneArtifactResponse") },
              },
              description: "The artifact was tombstoned",
            },
            ...problemResponses,
            "404": artifactNotFoundResponse,
            "409": artifactConflictResponse,
            "503": artifactStorageUnavailableResponse,
          },
          security: browserSecurity,
          summary: "Tombstone an artifact",
          tags: ["Artifacts"],
        },
        get: {
          description:
            "Returns exact artifact lifecycle metadata and fixture ownership without reading or decrypting content.",
          operationId: "getArtifactMetadata",
          parameters: [projectParameter, environmentParameter, artifactParameter],
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("ReadArtifactMetadataResponse") },
              },
              description: "Exact artifact metadata and optional immutable fixture ownership",
            },
            ...problemResponses,
            "404": artifactNotFoundResponse,
            "503": artifactStorageUnavailableResponse,
          },
          security: userOrWorkloadSecurity,
          summary: "Read artifact metadata",
          tags: ["Artifacts"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}/content": {
        get: {
          description:
            "Reads and integrity-verifies exact plaintext content. Restricted content additionally requires the non-delegable artifact:read:restricted capability. Revoked, tombstoned, purged, or missing object content fails closed.",
          operationId: "getArtifactContent",
          parameters: [projectParameter, environmentParameter, artifactParameter],
          responses: {
            "200": {
              content: {
                "application/octet-stream": {
                  schema: { format: "binary", type: "string" },
                },
              },
              description: "Integrity-verified artifact plaintext using the recorded media type",
              headers: {
                "X-ProofStack-Artifact-Classification": {
                  description: "Recorded content classification",
                  schema: { type: "string" },
                },
                "X-ProofStack-Artifact-Redaction-Status": {
                  description: "Recorded redaction status",
                  schema: { type: "string" },
                },
                "X-ProofStack-Artifact-Sha256": {
                  description: "Verified lowercase SHA-256 digest of the plaintext",
                  schema: { pattern: "^[a-f0-9]{64}$", type: "string" },
                },
                "X-ProofStack-Request-Id": {
                  description: "Stable request correlation identifier",
                  schema: { type: "string" },
                },
              },
            },
            ...problemResponses,
            "404": artifactNotFoundResponse,
            "409": artifactConflictResponse,
            "503": artifactStorageUnavailableResponse,
          },
          security: userOrWorkloadSecurity,
          summary: "Read artifact content",
          tags: ["Artifacts"],
        },
        put: {
          description:
            "Inspects, encrypts, and writes exact artifact content only when its declared size and digest match the reservation. JSON media types reject malformed content and structured credential fields; configured secret-scanner findings fail closed. Authentication and authorization run before body parsing. Existing object keys are never overwritten.",
          operationId: "uploadArtifactContent",
          parameters: [
            projectParameter,
            environmentParameter,
            artifactParameter,
            ...browserMutationParameters,
          ],
          requestBody: {
            content: {
              "application/octet-stream": { schema: { format: "binary", type: "string" } },
            },
            required: true,
          },
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("UploadArtifactResponse") },
              },
              description: "The encrypted object is durable and the catalog marks it available",
            },
            ...problemResponses,
            "404": artifactNotFoundResponse,
            "409": artifactConflictResponse,
            "413": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "The binary body exceeds the artifact content limit",
            },
            "415": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description: "The request is not application/octet-stream",
            },
            "422": {
              content: {
                "application/problem+json": { schema: schemaReference("ProblemDocument") },
              },
              description:
                "The plaintext size or digest does not match the reservation, or content inspection rejected the upload",
            },
            "503": artifactStorageUnavailableResponse,
          },
          security: userOrWorkloadSecurity,
          summary: "Upload immutable artifact content",
          tags: ["Artifacts"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/artifacts/{artifactId}/purge": {
        post: {
          description:
            "Deletes ciphertext only after a durable tombstone exists and appends an immutable purge receipt. Repeated calls remain safe. This administrative capability is not delegable to workload keys.",
          operationId: "purgeArtifactContent",
          parameters: [
            projectParameter,
            environmentParameter,
            artifactParameter,
            ...browserMutationParameters,
          ],
          responses: {
            "200": {
              content: {
                "application/json": { schema: schemaReference("PurgeArtifactResponse") },
              },
              description: "The object is absent and the durable purge state is returned",
            },
            ...problemResponses,
            "404": artifactNotFoundResponse,
            "409": artifactConflictResponse,
            "503": artifactStorageUnavailableResponse,
          },
          security: browserSecurity,
          summary: "Purge tombstoned artifact content",
          tags: ["Artifacts"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions":
        {
          post: {
            description:
              "Publishes one exact recorded-interaction fixture successor and atomically binds every same-scope, retain-mode, available, unowned artifact. Requires a browser-authenticated user with dataset:manage. Equivalent retries return the original version; reuse or lineage conflicts fail closed.",
            operationId: "publishRecordedInteractionFixtureVersion",
            parameters: [
              projectParameter,
              environmentParameter,
              fixtureParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("PublishInteractionFixtureVersionRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: schemaReference("PublishRecordedInteractionFixtureVersionResponse"),
                  },
                },
                description: "An identical retry returned the existing immutable version",
              },
              "201": {
                content: {
                  "application/json": {
                    schema: schemaReference("PublishRecordedInteractionFixtureVersionResponse"),
                  },
                },
                description: "The version and all artifact ownerships committed atomically",
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
              "409": regressionConflictResponse,
              "503": artifactStorageUnavailableResponse,
            },
            security: browserSecurity,
            summary: "Publish a recorded interaction fixture version",
            tags: ["Regression", "Artifacts"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}":
        {
          get: {
            description:
              "Returns exact immutable recorded-interaction metadata, ownerships, revocation state, and explicit content availability without returning artifact plaintext.",
            operationId: "getRecordedInteractionFixtureMetadata",
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
                    schema: schemaReference("ReadRecordedInteractionFixtureMetadataResponse"),
                  },
                },
                description:
                  "Exact metadata with explicit available, revoked, or unavailable state",
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Read recorded interaction fixture metadata",
            tags: ["Regression", "Artifacts"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/export":
        {
          get: {
            description:
              "Exports a versioned, provider-neutral metadata envelope for one exact recorded interaction. The response preserves artifact bindings, ownership, redaction, retention, lifecycle state, tombstones, and purge receipts, but never includes plaintext content or storage locators. Requires dataset:read and is never cacheable.",
            operationId: "exportRecordedInteractionFixtureMetadata",
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
                    schema: schemaReference("ExportRecordedInteractionFixtureMetadataResponse"),
                  },
                },
                description: "The complete metadata-only export envelope",
                headers: {
                  "Cache-Control": {
                    description: "Sensitive export responses are never cacheable",
                    schema: { const: "no-store", type: "string" },
                  },
                },
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
              "409": interactionExportConflictResponse,
              "503": artifactStorageUnavailableResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Export recorded interaction metadata",
            tags: ["Regression", "Artifacts"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/export/content":
        {
          post: {
            description:
              "Exports a bounded, provider-neutral envelope with canonical base64url plaintext only after an explicit sensitive-content acknowledgement. Requires dataset:read and artifact:read; restricted artifacts additionally require artifact:read:restricted. Missing, unavailable, revoked, and purged content remains explicit, and total returned plaintext is limited to 16 MiB. The response is never cacheable.",
            operationId: "exportRecordedInteractionFixtureContent",
            parameters: [
              projectParameter,
              environmentParameter,
              fixtureParameter,
              fixtureVersionParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("ExportRecordedInteractionFixtureContentRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: schemaReference("ExportRecordedInteractionFixtureContentResponse"),
                  },
                },
                description: "The bounded content export envelope",
                headers: {
                  "Cache-Control": {
                    description: "Sensitive export responses are never cacheable",
                    schema: { const: "no-store", type: "string" },
                  },
                },
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
              "409": interactionExportConflictResponse,
              "413": {
                content: {
                  "application/problem+json": { schema: schemaReference("ProblemDocument") },
                },
                description: "The aggregate declared interaction content exceeds 16 MiB",
              },
              "503": artifactStorageUnavailableResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Export recorded interaction content",
            tags: ["Regression", "Artifacts"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/{fixtureId}/interaction-versions/{fixtureVersionId}/revocation":
        {
          post: {
            description:
              "Atomically revokes the recorded content set and creates one fixture-authority tombstone per owned artifact. Physical object deletion remains a separate retryable purge step.",
            operationId: "revokeRecordedInteractionFixtureContent",
            parameters: [
              projectParameter,
              environmentParameter,
              fixtureParameter,
              fixtureVersionParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("RevokeInteractionFixtureContentRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: schemaReference("RevokeRecordedInteractionFixtureContentResponse"),
                  },
                },
                description: "An identical retry returned the existing revocation",
              },
              "201": {
                content: {
                  "application/json": {
                    schema: schemaReference("RevokeRecordedInteractionFixtureContentResponse"),
                  },
                },
                description: "The version and all owned artifacts were durably revoked",
              },
              ...problemResponses,
              "404": regressionNotFoundResponse,
              "409": regressionConflictResponse,
              "503": artifactStorageUnavailableResponse,
            },
            security: browserSecurity,
            summary: "Revoke recorded interaction fixture content",
            tags: ["Regression", "Artifacts"],
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
      "/v1/projects/{projectId}/environments/{environmentId}/evaluations/definitions/{recordId}": {
        post: {
          description:
            "Publishes one exact immutable discovery, source, criterion, fixture, oracle, evaluator, or aggregation-policy definition. Server identity, time, scope, schema version, and canonical digest are authoritative. Qualification and execution results are worker-owned and are not accepted here. Requires non-delegable evaluation:manage authority.",
          operationId: "publishEvaluationDefinition",
          parameters: [
            projectParameter,
            environmentParameter,
            evaluationRecordParameter,
            ...browserMutationParameters,
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: schemaReference("PublishEvaluationDefinitionRequest"),
              },
            },
            required: true,
          },
          responses: {
            "200": evaluationJsonResponse(
              "PublishEvaluationRecordResponse",
              "An identical retry returned the existing immutable definition",
            ),
            "201": evaluationJsonResponse(
              "PublishEvaluationRecordResponse",
              "A new immutable evaluation definition was published",
            ),
            ...problemResponses,
            "409": evaluationConflictResponse,
            "503": evaluationStorageUnavailableResponse,
          },
          security: browserSecurity,
          summary: "Publish an exact evaluation definition",
          tags: ["Evaluation"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/evaluations/criterion-set-statuses/{recordId}":
        {
          post: {
            description:
              "Appends one immutable lifecycle status for an exact criterion-set version. Prior status records remain unchanged. Requires non-delegable evaluation:manage authority.",
            operationId: "recordCriterionSetStatus",
            parameters: [
              projectParameter,
              environmentParameter,
              evaluationRecordParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("RecordCriterionSetStatusRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": evaluationJsonResponse(
                "PublishEvaluationRecordResponse",
                "An identical retry returned the existing immutable status record",
              ),
              "201": evaluationJsonResponse(
                "PublishEvaluationRecordResponse",
                "A new immutable criterion-set status was recorded",
              ),
              ...problemResponses,
              "409": evaluationConflictResponse,
              "503": evaluationStorageUnavailableResponse,
            },
            security: browserSecurity,
            summary: "Record an exact criterion-set status",
            tags: ["Evaluation"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/evaluations/run-decisions/{recordId}":
        {
          post: {
            description:
              "Records one exact accepted evaluation run or explicit rejection after application authorization and immutable lineage validation. This endpoint does not execute the run. Requires evaluation:run authority and supports explicitly delegated workloads.",
            operationId: "recordEvaluationRunDecision",
            parameters: [
              projectParameter,
              environmentParameter,
              evaluationRecordParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("RecordEvaluationRunDecisionRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": evaluationJsonResponse(
                "PublishEvaluationRecordResponse",
                "An identical retry returned the existing immutable run decision",
              ),
              "201": evaluationJsonResponse(
                "PublishEvaluationRecordResponse",
                "A new immutable evaluation run decision was recorded",
              ),
              ...problemResponses,
              "409": evaluationConflictResponse,
              "503": evaluationStorageUnavailableResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Record an exact evaluation run decision",
            tags: ["Evaluation"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/evaluations/assessments/{recordId}": {
        post: {
          description:
            "Creates one exact immutable assessment over explicit evidence, eligibility, conflicts, and limitations. It does not grant release authority. Requires non-delegable evaluation:manage authority.",
          operationId: "createEvaluationAssessment",
          parameters: [
            projectParameter,
            environmentParameter,
            evaluationRecordParameter,
            ...browserMutationParameters,
          ],
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("CreateAssessmentRequest") },
            },
            required: true,
          },
          responses: {
            "200": evaluationJsonResponse(
              "PublishEvaluationRecordResponse",
              "An identical retry returned the existing immutable assessment",
            ),
            "201": evaluationJsonResponse(
              "PublishEvaluationRecordResponse",
              "A new immutable evaluation assessment was created",
            ),
            ...problemResponses,
            "409": evaluationConflictResponse,
            "503": evaluationStorageUnavailableResponse,
          },
          security: browserSecurity,
          summary: "Create an exact evaluation assessment",
          tags: ["Evaluation"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/evaluations/records/{kind}/{recordId}":
        {
          get: {
            description:
              "Returns one exact immutable evaluation record by its strict kind and identifier. Cross-scope records and absent records share the same not-found response. There is no latest alias.",
            operationId: "getEvaluationRecord",
            parameters: [
              projectParameter,
              environmentParameter,
              evaluationRecordKindParameter,
              evaluationRecordParameter,
            ],
            responses: {
              "200": evaluationJsonResponse(
                "ReadEvaluationRecordResponse",
                "The exact immutable evaluation record",
              ),
              ...problemResponses,
              "404": evaluationNotFoundResponse,
              "503": evaluationStorageUnavailableResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Read an exact evaluation record",
            tags: ["Evaluation"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/comparisons/{comparisonId}/definitions/{comparisonVersionId}":
        {
          post: {
            description:
              "Publishes one exact immutable baseline/candidate comparison definition. Every dataset, fixture, terminal replay, assessment, and model-assurance reference is digest-bound. The result remains descriptive and cannot approve a release. Requires non-delegable comparison:manage authority.",
            operationId: "publishComparisonDefinition",
            parameters: [
              projectParameter,
              environmentParameter,
              comparisonParameter,
              comparisonVersionParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("PublishComparisonDefinitionRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": comparisonJsonResponse(
                "PublishComparisonRecordResponse",
                "An identical retry returned the existing immutable comparison definition",
              ),
              "201": comparisonJsonResponse(
                "PublishComparisonRecordResponse",
                "A new immutable comparison definition was published",
              ),
              ...problemResponses,
              "409": comparisonConflictResponse,
              "503": comparisonStorageUnavailableResponse,
            },
            security: browserSecurity,
            summary: "Publish an exact comparison definition",
            tags: ["Comparison"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/comparisons/evidence-snapshots/{snapshotId}":
        {
          post: {
            description:
              "Freezes one server-derived bounded projection of the exact baseline or candidate evidence named by a comparison definition. Callers submit only immutable references; trace, usage, safety, omission, artifact, and assessment values are resolved authoritatively and cannot be caller-authored. Requires non-delegable comparison:manage authority.",
            operationId: "createComparisonEvidenceSnapshot",
            parameters: [
              projectParameter,
              environmentParameter,
              comparisonSnapshotParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("CreateComparisonEvidenceSnapshotRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": comparisonJsonResponse(
                "PublishComparisonRecordResponse",
                "An identical retry returned the existing immutable evidence snapshot",
              ),
              "201": comparisonJsonResponse(
                "PublishComparisonRecordResponse",
                "A new immutable comparison evidence snapshot was frozen",
              ),
              ...problemResponses,
              "409": comparisonConflictResponse,
              "503": comparisonStorageUnavailableResponse,
            },
            security: browserSecurity,
            summary: "Freeze exact comparison evidence",
            tags: ["Comparison"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/comparisons/results/{resultId}": {
        post: {
          description:
            "Derives one immutable policy-independent result from exact baseline and candidate evidence snapshots using bounded case pairing and exact arithmetic. The caller cannot submit metric values, a verdict, or release authority. Requires non-delegable comparison:manage authority.",
          operationId: "deriveComparisonResult",
          parameters: [
            projectParameter,
            environmentParameter,
            comparisonResultParameter,
            ...browserMutationParameters,
          ],
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("DeriveComparisonResultRequest") },
            },
            required: true,
          },
          responses: {
            "200": comparisonJsonResponse(
              "PublishComparisonRecordResponse",
              "An identical retry returned the existing immutable comparison result",
            ),
            "201": comparisonJsonResponse(
              "PublishComparisonRecordResponse",
              "A new immutable comparison result was derived",
            ),
            ...problemResponses,
            "409": comparisonConflictResponse,
            "503": comparisonStorageUnavailableResponse,
          },
          security: browserSecurity,
          summary: "Derive an exact comparison result",
          tags: ["Comparison"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/comparisons/records/{kind}/{recordId}":
        {
          get: {
            description:
              "Returns one exact immutable comparison definition, evidence snapshot, or result by strict kind and identifier. Cross-scope and absent records share the same not-found response. There is no latest alias.",
            operationId: "getComparisonRecord",
            parameters: [
              projectParameter,
              environmentParameter,
              comparisonRecordKindParameter,
              comparisonRecordParameter,
            ],
            responses: {
              "200": comparisonJsonResponse(
                "ReadComparisonRecordResponse",
                "The exact immutable comparison record",
              ),
              ...problemResponses,
              "404": comparisonNotFoundResponse,
              "503": comparisonStorageUnavailableResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Read an exact comparison record",
            tags: ["Comparison"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/definitions/{recordId}":
        {
          post: {
            description:
              "Publishes one exact immutable model profile, evaluator, independence declaration, calibration report, blind plan, qualification suite, human-review protocol, or reviewer-independence declaration. Execution and human-review records are rejected here. Requires non-delegable evaluation:manage authority.",
            operationId: "publishModelAssuranceDefinition",
            parameters: [
              projectParameter,
              environmentParameter,
              modelAssuranceRecordParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("PublishModelAssuranceDefinitionRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": modelAssuranceJsonResponse(
                "PublishModelAssuranceRecordResponse",
                "An identical retry returned the existing immutable definition",
              ),
              "201": modelAssuranceJsonResponse(
                "PublishModelAssuranceRecordResponse",
                "A new immutable model-assurance definition was published",
              ),
              ...problemResponses,
              "409": modelAssuranceConflictResponse,
              "503": modelAssuranceStorageUnavailableResponse,
            },
            security: browserSecurity,
            summary: "Publish an exact model-assurance definition",
            tags: ["Model assurance"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/executions/{recordId}":
        {
          post: {
            description:
              "Records one exact preauthorized blinded result, independent critique, or model-qualification report. The route accepts strict artifact references rather than arbitrary prompts or destinations and requires evaluation:model:run workload authority.",
            operationId: "recordModelAssuranceExecution",
            parameters: [projectParameter, environmentParameter, modelAssuranceRecordParameter],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("RecordModelAssuranceExecutionRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": modelAssuranceJsonResponse(
                "PublishModelAssuranceRecordResponse",
                "An identical retry returned the existing immutable execution record",
              ),
              "201": modelAssuranceJsonResponse(
                "PublishModelAssuranceRecordResponse",
                "A new immutable model-assurance execution record was appended",
              ),
              ...problemResponses,
              "409": modelAssuranceConflictResponse,
              "503": modelAssuranceStorageUnavailableResponse,
            },
            security: bearerSecurity,
            summary: "Record bounded model-assurance execution evidence",
            tags: ["Model assurance"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/human-reviews/{recordId}":
        {
          post: {
            description:
              "Appends one authenticated human review under an exact protocol and reviewer session. Reviews remain evidence, cannot overwrite dissent, and cannot grant release authority. Requires user-only evaluation:human:review authority.",
            operationId: "recordModelAssuranceHumanReview",
            parameters: [
              projectParameter,
              environmentParameter,
              modelAssuranceRecordParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": { schema: schemaReference("RecordHumanReviewRequest") },
              },
              required: true,
            },
            responses: {
              "200": modelAssuranceJsonResponse(
                "PublishModelAssuranceRecordResponse",
                "An identical retry returned the existing immutable human review",
              ),
              "201": modelAssuranceJsonResponse(
                "PublishModelAssuranceRecordResponse",
                "A new immutable human review was appended",
              ),
              ...problemResponses,
              "409": modelAssuranceConflictResponse,
              "503": modelAssuranceStorageUnavailableResponse,
            },
            security: browserSecurity,
            summary: "Append an accountable human review",
            tags: ["Model assurance"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/assessments/{recordId}":
        {
          post: {
            description:
              "Creates one conservative model-assurance assessment from exact retained evidence. Eligibility, reasons, and evaluation time are derived by the server and do not grant policy, approval, deployment, or release authority. Requires evaluation:manage.",
            operationId: "createModelAssuranceAssessment",
            parameters: [
              projectParameter,
              environmentParameter,
              modelAssuranceRecordParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: schemaReference("CreateModelAssuranceAssessmentRequest"),
                },
              },
              required: true,
            },
            responses: {
              "200": modelAssuranceJsonResponse(
                "PublishModelAssuranceRecordResponse",
                "An identical retry returned the existing immutable assessment",
              ),
              "201": modelAssuranceJsonResponse(
                "PublishModelAssuranceRecordResponse",
                "A new immutable model-assurance assessment was created",
              ),
              ...problemResponses,
              "409": modelAssuranceConflictResponse,
              "503": modelAssuranceStorageUnavailableResponse,
            },
            security: browserSecurity,
            summary: "Create a conservative model-assurance assessment",
            tags: ["Model assurance"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/model-assurance/records/{kind}/{recordId}":
        {
          get: {
            description:
              "Returns one exact immutable model-assurance record by strict kind and identifier. Cross-scope records and absent records share the not-found response. There is no latest alias.",
            operationId: "getModelAssuranceRecord",
            parameters: [
              projectParameter,
              environmentParameter,
              modelAssuranceRecordKindParameter,
              modelAssuranceRecordParameter,
            ],
            responses: {
              "200": modelAssuranceJsonResponse(
                "ReadModelAssuranceRecordResponse",
                "The exact immutable model-assurance record",
              ),
              ...problemResponses,
              "404": modelAssuranceNotFoundResponse,
              "503": modelAssuranceStorageUnavailableResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Read an exact model-assurance record",
            tags: ["Model assurance"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/replay-targets/{targetId}/releases/{targetReleaseId}":
        {
          post: {
            description:
              "Publishes one exact immutable target release with server-authored time, principal, and canonical definition digest. Requires replay:manage, which is not workload-delegable. An equivalent retry returns the original release.",
            operationId: "publishTargetRelease",
            parameters: [
              projectParameter,
              environmentParameter,
              targetParameter,
              targetReleaseParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": { schema: schemaReference("TargetReleaseDefinition") },
              },
              required: true,
            },
            responses: {
              "200": replayJsonResponse(
                "PublishTargetReleaseResponse",
                "An identical retry returned the existing immutable target release",
              ),
              "201": replayJsonResponse(
                "PublishTargetReleaseResponse",
                "A new immutable target release was published",
              ),
              ...problemResponses,
              "409": replayConflictResponse,
            },
            security: browserSecurity,
            summary: "Publish an exact target release",
            tags: ["Replay"],
          },
          get: {
            description:
              "Returns one exact immutable target release after scope authorization. Logical-target mismatch and absence share the same scope-safe not-found response.",
            operationId: "getTargetRelease",
            parameters: [
              projectParameter,
              environmentParameter,
              targetParameter,
              targetReleaseParameter,
            ],
            responses: {
              "200": replayJsonResponse(
                "ReadTargetReleaseResponse",
                "The exact immutable target release",
              ),
              ...problemResponses,
              "404": replayNotFoundResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Read an exact target release",
            tags: ["Replay"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/replay-plans/{planId}/versions/{planVersionId}":
        {
          post: {
            description:
              "Publishes one exact immutable replay plan pinned to an existing target release and finite execution controls. Requires replay:manage, which is not workload-delegable. An equivalent retry returns the original plan.",
            operationId: "publishReplayPlan",
            parameters: [
              projectParameter,
              environmentParameter,
              replayPlanParameter,
              replayPlanVersionParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": { schema: schemaReference("ReplayPlanDefinition") },
              },
              required: true,
            },
            responses: {
              "200": replayJsonResponse(
                "PublishReplayPlanResponse",
                "An identical retry returned the existing immutable replay plan",
              ),
              "201": replayJsonResponse(
                "PublishReplayPlanResponse",
                "A new immutable replay plan was published",
              ),
              ...problemResponses,
              "409": replayConflictResponse,
            },
            security: browserSecurity,
            summary: "Publish an exact replay plan",
            tags: ["Replay"],
          },
          get: {
            description:
              "Returns one exact immutable replay plan and its pinned release, fixture, runtime, isolation, budget, retry, boundary, and side-effect declarations.",
            operationId: "getReplayPlan",
            parameters: [
              projectParameter,
              environmentParameter,
              replayPlanParameter,
              replayPlanVersionParameter,
            ],
            responses: {
              "200": replayJsonResponse(
                "ReadReplayPlanResponse",
                "The exact immutable replay plan",
              ),
              ...problemResponses,
              "404": replayNotFoundResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Read an exact replay plan",
            tags: ["Replay"],
          },
        },
      "/v1/projects/{projectId}/environments/{environmentId}/replay-jobs/{jobId}": {
        post: {
          description:
            "Creates one durable queued job from an exact published plan reference. The route never executes work synchronously; a separately authorized worker claims it later. An equivalent retry returns the existing snapshot.",
          operationId: "createReplayJob",
          parameters: [
            projectParameter,
            environmentParameter,
            replayJobParameter,
            ...browserMutationParameters,
          ],
          requestBody: {
            content: {
              "application/json": { schema: schemaReference("CreateReplayJobRequest") },
            },
            required: true,
          },
          responses: {
            "200": replayJsonResponse(
              "CreateReplayJobResponse",
              "An identical retry returned the existing durable replay job",
            ),
            "201": replayJsonResponse(
              "CreateReplayJobResponse",
              "A new durable queued replay job was created",
            ),
            ...problemResponses,
            "409": replayConflictResponse,
          },
          security: userOrWorkloadSecurity,
          summary: "Create a durable replay job",
          tags: ["Replay"],
        },
        get: {
          description:
            "Returns one exact validated durable snapshot including attempts, budget ledger, cancellation history, usage, and execution observations without protected plaintext.",
          operationId: "getReplayJob",
          parameters: [projectParameter, environmentParameter, replayJobParameter],
          responses: {
            "200": replayJsonResponse(
              "ReadReplayJobResponse",
              "The complete exact durable replay job snapshot",
            ),
            ...problemResponses,
            "404": replayNotFoundResponse,
          },
          security: userOrWorkloadSecurity,
          summary: "Read an exact durable replay job",
          tags: ["Replay"],
        },
      },
      "/v1/projects/{projectId}/environments/{environmentId}/replay-jobs/{jobId}/cancellation-requests/{cancellationId}":
        {
          post: {
            description:
              "Records the first authorized immutable cancellation request. The route and body cancellation IDs must match. A queued job may terminalize atomically; a running worker observes and acknowledges the request through its separately fenced authority.",
            operationId: "requestReplayCancellation",
            parameters: [
              projectParameter,
              environmentParameter,
              replayJobParameter,
              replayCancellationParameter,
              ...browserMutationParameters,
            ],
            requestBody: {
              content: {
                "application/json": { schema: schemaReference("RequestReplayCancellation") },
              },
              required: true,
            },
            responses: {
              "200": replayJsonResponse(
                "RequestReplayCancellationResponse",
                "An identical retry or terminal race returned the durable job snapshot",
              ),
              "201": replayJsonResponse(
                "RequestReplayCancellationResponse",
                "A new immutable cancellation request was committed",
              ),
              ...problemResponses,
              "404": replayNotFoundResponse,
              "409": replayConflictResponse,
            },
            security: userOrWorkloadSecurity,
            summary: "Request durable replay cancellation",
            tags: ["Replay"],
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
      {
        description:
          "Exact immutable replay definitions and durable bounded job control without synchronous execution",
        name: "Replay",
      },
      {
        description:
          "Exact immutable evaluation definitions, lifecycle decisions, assessments, and graph reads",
        name: "Evaluation",
      },
      {
        description:
          "Policy-independent exact baseline/candidate evidence snapshots and derived results",
        name: "Comparison",
      },
      {
        description:
          "Exact model and human evaluation evidence with separated management, workload, and reviewer authority",
        name: "Model assurance",
      },
      { description: "OpenTelemetry-compatible ingestion", name: "Telemetry" },
    ],
    "x-proofstack-evidence-schema-version": EVIDENCE_SCHEMA_VERSION,
  };
}
