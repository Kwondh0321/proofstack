import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { AssuranceSummarySchema } from "./evaluation-source.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  InteractionCaptureSourceSchema,
  InteractionNormalizedRequestReferenceSchema,
} from "./interaction.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReplayTargetAdapterReferenceSchema } from "./replay.js";
import {
  ReplayReleaseTargetAdapterReferenceSchema,
  WorkerProtocolReferenceSchema,
} from "./replay-plan.js";
import { RuntimeAdapterDefinitionSchema } from "./runtime-definition.js";

export const PROTOCOL_DEFINITION_SCHEMA_VERSION = "0.1" as const;
export const MAX_PROTOCOL_DEFINITION_LIMITATIONS = 32;

function ordered(values: readonly string[]): boolean {
  let previous = "";
  for (const value of values) {
    if (value <= previous) return false;
    previous = value;
  }
  return true;
}

// Equal wire shapes do not make these declarations interchangeable.
const capture = z
  .object({
    family: z.literal("capture_adapter"),
    descriptor: InteractionCaptureSourceSchema.shape.captureAdapter,
  })
  .strict();
const sourceFormat = z
  .object({
    family: z.literal("source_format"),
    descriptor: InteractionCaptureSourceSchema.shape.sourceFormat,
  })
  .strict();
const normalizer = z
  .object({
    family: z.literal("request_normalizer"),
    descriptor: z
      .object({
        name: InteractionNormalizedRequestReferenceSchema.shape.adapterName,
        version: InteractionNormalizedRequestReferenceSchema.shape.adapterVersion,
      })
      .strict(),
  })
  .strict();
const recorded = z
  .object({
    family: z.literal("recorded_target_adapter"),
    descriptor: ReplayTargetAdapterReferenceSchema,
  })
  .strict();
const released = z
  .object({
    family: z.literal("released_target_adapter"),
    descriptor: ReplayReleaseTargetAdapterReferenceSchema,
  })
  .strict();
const worker = z
  .object({
    family: z.literal("worker_protocol"),
    descriptor: WorkerProtocolReferenceSchema,
  })
  .strict();
const runtime = z
  .object({
    family: z.literal("runtime_protocol"),
    descriptor: RuntimeAdapterDefinitionSchema.shape.protocol,
  })
  .strict();

export const ProtocolDefinitionSelectorSchema = z.discriminatedUnion("family", [
  capture,
  sourceFormat,
  normalizer,
  recorded,
  released,
  worker,
  runtime,
]);

const definition = {
  recordKind: z.literal("protocol_definition"),
  // A retained storage identity, never a truncated/lowercased protocol name or requested hash.
  protocolDefinitionId: OpaqueIdSchema,
  specification: ArtifactContentReferenceSchema,
  limitations: z
    .array(AssuranceSummarySchema)
    .max(MAX_PROTOCOL_DEFINITION_LIMITATIONS)
    .refine(ordered, { message: "Protocol limitations must be unique and ordered" }),
};
const adapter = {
  implementation: ArtifactContentReferenceSchema,
  configuration: ArtifactContentReferenceSchema,
};

// Pure format/wire definitions declare specifications, without invented executables/configuration.
export const ProtocolDefinitionSchema = z.discriminatedUnion("family", [
  capture.extend({ ...definition, ...adapter }).strict(),
  sourceFormat.extend(definition).strict(),
  normalizer.extend({ ...definition, ...adapter }).strict(),
  recorded.extend({ ...definition, ...adapter }).strict(),
  released.extend({ ...definition, ...adapter }).strict(),
  worker.extend(definition).strict(),
  runtime.extend(definition).strict(),
]);

const receipt = {
  definitionSha256: Sha256Schema,
  registeredAt: UtcMillisecondTimestampSchema,
  registeredByPrincipalId: OpaqueIdSchema,
  schemaVersion: z.literal(PROTOCOL_DEFINITION_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
};

export const ProtocolDefinitionRecordSchema = z.discriminatedUnion("family", [
  capture.extend({ ...definition, ...adapter, ...receipt }).strict(),
  sourceFormat.extend({ ...definition, ...receipt }).strict(),
  normalizer.extend({ ...definition, ...adapter, ...receipt }).strict(),
  recorded.extend({ ...definition, ...adapter, ...receipt }).strict(),
  released.extend({ ...definition, ...adapter, ...receipt }).strict(),
  worker.extend({ ...definition, ...receipt }).strict(),
  runtime.extend({ ...definition, ...receipt }).strict(),
]);

export const ProtocolDefinitionReferenceSchema = z
  .object({ protocolDefinitionId: OpaqueIdSchema, definitionSha256: Sha256Schema })
  .strict();

export type ProtocolDefinitionSelector = z.infer<typeof ProtocolDefinitionSelectorSchema>;
export type ProtocolDefinition = z.infer<typeof ProtocolDefinitionSchema>;
export type ProtocolDefinitionRecord = z.infer<typeof ProtocolDefinitionRecordSchema>;
export type ProtocolDefinitionReference = z.infer<typeof ProtocolDefinitionReferenceSchema>;
