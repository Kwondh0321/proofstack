import { z } from "zod";
import { RegisteredEvaluationImplementationSchema } from "./evaluation-spec.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const EVALUATION_IMPLEMENTATION_REGISTRATION_SCHEMA_VERSION = "0.1" as const;

/** Retained installation registration data, not executable code or qualification approval. */
export const EvaluationImplementationRegistrationDefinitionSchema = z
  .object({
    implementation: RegisteredEvaluationImplementationSchema,
    recordKind: z.literal("evaluation_implementation_registration"),
  })
  .strict();

export const EvaluationImplementationRegistrationRecordSchema =
  EvaluationImplementationRegistrationDefinitionSchema.extend({
    definitionSha256: Sha256Schema,
    registeredAt: UtcMillisecondTimestampSchema,
    registeredByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(EVALUATION_IMPLEMENTATION_REGISTRATION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  }).strict();

export type EvaluationImplementationRegistrationDefinition = z.infer<
  typeof EvaluationImplementationRegistrationDefinitionSchema
>;
export type EvaluationImplementationRegistrationRecord = z.infer<
  typeof EvaluationImplementationRegistrationRecordSchema
>;
