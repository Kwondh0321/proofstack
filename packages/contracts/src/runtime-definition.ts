import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { AssuranceSummarySchema } from "./evaluation-source.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReleaseCandidateAdapterReferenceSchema } from "./release-candidate.js";
import {
  ReplayBoundaryKindSchema,
  ReplayIsolationProfileReferenceSchema,
  ReplayReleaseTargetAdapterReferenceSchema,
  ReplayRuntimeProfileReferenceSchema,
  TargetReleaseSchema,
} from "./replay-plan.js";

export const RUNTIME_DEFINITION_SCHEMA_VERSION = "0.1" as const;
export const MAX_RUNTIME_DEFINITION_LIMITATIONS = 32;

const sorted = (values: readonly string[]) =>
  values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);

// These are retained definition dependencies, not locators, launch commands, or credentials.
const common = {
  configuration: ArtifactContentReferenceSchema,
  implementation: ArtifactContentReferenceSchema,
  limitations: z
    .array(AssuranceSummarySchema)
    .max(MAX_RUNTIME_DEFINITION_LIMITATIONS)
    .refine(sorted, {
      message: "Runtime definition limitations must be unique and ordered",
    }),
};

export const ReplayRuntimeProfileDefinitionSchema = z
  .object({
    ...common,
    ...ReplayRuntimeProfileReferenceSchema.omit({ definitionSha256: true }).shape,
    recordKind: z.literal("replay_runtime_profile"),
    runtime: TargetReleaseSchema.shape.runtime.omit({ entryPoint: true, family: true }).strict(),
  })
  .strict();

export const ReplayIsolationProfileDefinitionSchema = z
  .object({
    ...common,
    ...ReplayIsolationProfileReferenceSchema.omit({ definitionSha256: true }).shape,
    recordKind: z.literal("replay_isolation_profile"),
  })
  .strict();

export const RuntimeAdapterDefinitionSchema = z
  .object({
    ...common,
    ...ReleaseCandidateAdapterReferenceSchema.omit({ definitionSha256: true }).shape,
    boundaryKinds: z
      .array(ReplayBoundaryKindSchema)
      .min(1)
      .max(ReplayBoundaryKindSchema.options.length)
      .refine(sorted, { message: "Runtime adapter boundary kinds must be unique and ordered" }),
    interfaceContract: ArtifactContentReferenceSchema,
    protocol: z
      .object({
        name: ReplayReleaseTargetAdapterReferenceSchema.shape.name,
        version: ReplayReleaseTargetAdapterReferenceSchema.shape.protocolVersion,
      })
      .strict(),
    recordKind: z.literal("runtime_adapter"),
  })
  .strict();

export const RuntimeDefinitionSchema = z.discriminatedUnion("recordKind", [
  ReplayRuntimeProfileDefinitionSchema,
  ReplayIsolationProfileDefinitionSchema,
  RuntimeAdapterDefinitionSchema,
]);

const receipt = {
  definitionSha256: Sha256Schema,
  registeredAt: UtcMillisecondTimestampSchema,
  registeredByPrincipalId: OpaqueIdSchema,
  schemaVersion: z.literal(RUNTIME_DEFINITION_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
};

export const RuntimeDefinitionRecordSchema = z.discriminatedUnion("recordKind", [
  ReplayRuntimeProfileDefinitionSchema.extend(receipt).strict(),
  ReplayIsolationProfileDefinitionSchema.extend(receipt).strict(),
  RuntimeAdapterDefinitionSchema.extend(receipt).strict(),
]);

export type RuntimeDefinition = z.infer<typeof RuntimeDefinitionSchema>;
export type RuntimeDefinitionRecord = z.infer<typeof RuntimeDefinitionRecordSchema>;
export type RuntimeDefinitionKind = RuntimeDefinition["recordKind"];
