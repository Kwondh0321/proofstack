import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { ModelInteractionAttemptSchema } from "./interaction.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReplayBoundaryDeclarationSchema, ReplayBoundaryKindSchema } from "./replay-plan.js";

export const ENDPOINT_PROFILE_SCHEMA_VERSION = "0.1" as const;
export const MAX_ENDPOINT_PROFILE_OPERATIONS = 64;

const liveBoundary = ReplayBoundaryDeclarationSchema.options[0];
const ordered = (values: readonly string[]) =>
  values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);

/** Reuses the existing exact live-boundary reference without changing plans or captures. */
export const EndpointProfileReferenceSchema = liveBoundary.shape.endpointProfile;

/** Retained declarations and exact bytes, not provider identity, credentials or execution authority. */
export const EndpointProfileDefinitionSchema = z
  .object({
    ...EndpointProfileReferenceSchema.omit({ definitionSha256: true }).shape,
    boundaryKinds: z
      .array(ReplayBoundaryKindSchema)
      .min(1)
      .max(ReplayBoundaryKindSchema.options.length)
      .refine(ordered, { message: "Endpoint boundary kinds must be unique and ordered" }),
    configuration: ArtifactContentReferenceSchema,
    destination: liveBoundary.shape.destination,
    operations: z
      .array(liveBoundary.shape.operation)
      .min(1)
      .max(MAX_ENDPOINT_PROFILE_OPERATIONS)
      .refine(ordered, { message: "Endpoint operations must be unique and ordered" }),
    provider: ModelInteractionAttemptSchema.shape.provider.shape.name,
    recordKind: z.literal("endpoint_profile"),
  })
  .strict();

export const EndpointProfileRecordSchema = EndpointProfileDefinitionSchema.extend({
  definitionSha256: Sha256Schema,
  registeredAt: UtcMillisecondTimestampSchema,
  registeredByPrincipalId: OpaqueIdSchema,
  schemaVersion: z.literal(ENDPOINT_PROFILE_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
}).strict();

export type EndpointProfileDefinition = z.infer<typeof EndpointProfileDefinitionSchema>;
export type EndpointProfileRecord = z.infer<typeof EndpointProfileRecordSchema>;
export type EndpointProfileReference = z.infer<typeof EndpointProfileReferenceSchema>;
