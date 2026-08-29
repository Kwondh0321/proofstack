import { z } from "zod";
import { ArtifactContentReferenceSchema, ArtifactRedactionSummarySchema } from "./artifact.js";
import { evidenceTimestampOrderKey } from "./evidence.js";
import { OpaqueIdSchema, PostgresTimestampSchema, Sha256Schema } from "./primitives.js";

export const INTERACTION_CAPTURE_SCHEMA_VERSION = "0.1" as const;
export const MAX_CAPTURE_INTERACTIONS = 512;
export const MAX_CAPTURE_ATTEMPTS = 2_048;
export const MAX_CAPTURE_ATTEMPTS_PER_INTERACTION = 8;
export const MAX_CAPTURE_ARTIFACTS = 2_048;
export const MAX_CAPTURE_TOOL_CONTRACTS = 64;

const ProtocolTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,255}$/);

const ProtocolVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);

const uniqueStrings = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

function isStrictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function isContiguousSequence(values: readonly number[]): boolean {
  return values.every((value, index) => value === index);
}

export const InteractionArtifactRoleSchema = z.enum([
  "model.input_messages",
  "model.normalized_request",
  "model.output_messages",
  "model.provider_configuration",
  "model.provider_request",
  "model.provider_response",
  "model.streaming_frames",
  "model.system_instructions",
  "prompt.template",
  "prompt.variables",
  "tool.arguments",
  "tool.contract",
  "tool.normalized_request",
  "tool.result",
]);

export const InteractionArtifactBindingSchema = z
  .object({
    contentReference: ArtifactContentReferenceSchema,
    redaction: ArtifactRedactionSummarySchema,
    retention: z.object({ mode: z.literal("retain") }).strict(),
    role: InteractionArtifactRoleSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contentReference.classification === "metadata") {
      context.addIssue({
        code: "custom",
        message: "Interaction content artifacts require a non-metadata classification",
        path: ["contentReference", "classification"],
      });
    }

    const latestRedactionStage =
      value.redaction.status === "applied" ? value.redaction.records.at(-1)?.stage : undefined;
    if (value.contentReference.redactedAt !== latestRedactionStage) {
      context.addIssue({
        code: "custom",
        message: "contentReference.redactedAt must equal the latest recorded redaction stage",
        path: ["contentReference", "redactedAt"],
      });
    }
  });

const InteractionArtifactsSchema = z
  .array(InteractionArtifactBindingSchema)
  .min(1)
  .max(MAX_CAPTURE_ARTIFACTS)
  .superRefine((values, context) => {
    const artifactIds = values.map(({ contentReference }) => contentReference.artifactId);
    if (!uniqueStrings(artifactIds)) {
      context.addIssue({ code: "custom", message: "Capture artifactIds must be unique" });
    }
    if (!isStrictlySorted(artifactIds)) {
      context.addIssue({
        code: "custom",
        message: "Capture artifacts must be ordered by artifactId",
      });
    }
  });

export const InteractionAttemptOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "indeterminate",
]);

export const InteractionSideEffectSchema = z.enum([
  "none",
  "read_only",
  "idempotent_write",
  "non_idempotent_write",
  "unknown",
]);

export const InteractionCompletenessLimitationSchema = z.enum([
  "transport_metadata_excluded",
  "provider_internal_state_unobserved",
  "hidden_reasoning_excluded",
  "uninstrumented_subprocesses_unobserved",
  "undeclared_side_effects_unobserved",
]);

const CaptureCompletenessSchema = z
  .object({
    limitations: z
      .array(InteractionCompletenessLimitationSchema)
      .min(1)
      .max(InteractionCompletenessLimitationSchema.options.length)
      .refine(uniqueStrings, { message: "Completeness limitations must be unique" })
      .refine(
        (values) => {
          const rank = new Map(
            InteractionCompletenessLimitationSchema.options.map((value, index) => [value, index]),
          );
          return values.every((value, index) => {
            const previous = values[index - 1];
            return (
              index === 0 ||
              (previous !== undefined && (rank.get(previous) ?? -1) < (rank.get(value) ?? -1))
            );
          });
        },
        { message: "Completeness limitations must use canonical order" },
      ),
    status: z.literal("complete_for_declared_boundary"),
  })
  .strict();

export const InteractionCaptureSourceSchema = z
  .object({
    boundary: z.literal("application_provider_and_tool"),
    captureAdapter: z
      .object({ name: ProtocolTokenSchema, version: ProtocolVersionSchema })
      .strict(),
    completeness: CaptureCompletenessSchema,
    sourceFormat: z.object({ name: ProtocolTokenSchema, version: ProtocolVersionSchema }).strict(),
  })
  .strict();

export const InteractionPromptReferenceSchema = z
  .object({
    artifactId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    promptId: OpaqueIdSchema,
    promptVersion: ProtocolVersionSchema,
  })
  .strict();

export const InteractionToolContractReferenceSchema = z
  .object({
    artifactId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    toolId: OpaqueIdSchema,
    toolVersion: ProtocolVersionSchema,
  })
  .strict();

const InteractionToolContractsSchema = z
  .array(InteractionToolContractReferenceSchema)
  .max(MAX_CAPTURE_TOOL_CONTRACTS)
  .superRefine((values, context) => {
    const toolIds = values.map(({ toolId }) => toolId);
    if (!uniqueStrings(toolIds)) {
      context.addIssue({ code: "custom", message: "Offered toolIds must be unique" });
    }
    if (!isStrictlySorted(toolIds)) {
      context.addIssue({ code: "custom", message: "Offered tools must be ordered by toolId" });
    }
  });

export const InteractionNormalizedRequestReferenceSchema = z
  .object({
    adapterName: ProtocolTokenSchema,
    adapterVersion: ProtocolVersionSchema,
    artifactId: OpaqueIdSchema,
    sha256: Sha256Schema,
  })
  .strict();

const ModelProviderSchema = z
  .object({
    endpointProfileId: OpaqueIdSchema,
    endpointProfileVersion: ProtocolVersionSchema,
    name: ProtocolTokenSchema,
    operation: z.enum(["chat", "generate_content", "text_completion"]),
    requestedModel: ProtocolTokenSchema,
    returnedModel: ProtocolTokenSchema.optional(),
  })
  .strict();

const AttemptBaseShape = {
  attemptId: OpaqueIdSchema,
  endedAt: PostgresTimestampSchema,
  errorType: ProtocolTokenSchema.optional(),
  outcome: InteractionAttemptOutcomeSchema,
  sequence: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_CAPTURE_ATTEMPTS_PER_INTERACTION - 1),
  startedAt: PostgresTimestampSchema,
};

function refineAttempt(
  value: {
    readonly endedAt: string;
    readonly errorType?: string | undefined;
    readonly outcome: z.infer<typeof InteractionAttemptOutcomeSchema>;
    readonly startedAt: string;
  },
  context: z.RefinementCtx,
): void {
  if (evidenceTimestampOrderKey(value.endedAt) < evidenceTimestampOrderKey(value.startedAt)) {
    context.addIssue({
      code: "custom",
      message: "endedAt cannot be earlier than startedAt",
      path: ["endedAt"],
    });
  }
  if (value.outcome === "succeeded" && value.errorType !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Successful attempts cannot carry errorType",
      path: ["errorType"],
    });
  }
  if (value.outcome !== "succeeded" && value.errorType === undefined) {
    context.addIssue({
      code: "custom",
      message: "Unsuccessful attempts require errorType",
      path: ["errorType"],
    });
  }
}

export const ModelInteractionAttemptSchema = z
  .object({
    ...AttemptBaseShape,
    artifacts: z
      .object({
        inputMessagesArtifactId: OpaqueIdSchema,
        outputMessagesArtifactId: OpaqueIdSchema.optional(),
        promptVariablesArtifactId: OpaqueIdSchema.optional(),
        providerConfigurationArtifactId: OpaqueIdSchema,
        providerRequestArtifactId: OpaqueIdSchema,
        providerResponseArtifactId: OpaqueIdSchema.optional(),
        streamingFramesArtifactId: OpaqueIdSchema.optional(),
        systemInstructionsArtifactId: OpaqueIdSchema.optional(),
      })
      .strict(),
    normalizedRequest: InteractionNormalizedRequestReferenceSchema,
    provider: ModelProviderSchema,
    providerMayHaveProcessed: z.boolean(),
    providerRequestId: ProtocolTokenSchema.optional(),
    streaming: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    refineAttempt(value, context);
    const hasResponse = value.artifacts.providerResponseArtifactId !== undefined;
    const hasOutput = value.artifacts.outputMessagesArtifactId !== undefined;
    if (value.outcome === "succeeded" && (!hasResponse || !hasOutput)) {
      context.addIssue({
        code: "custom",
        message: "Successful model attempts require provider response and output messages",
        path: ["artifacts"],
      });
    }
    if (value.streaming !== (value.artifacts.streamingFramesArtifactId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Streaming model attempts require exactly one streaming frames artifact",
        path: ["artifacts", "streamingFramesArtifactId"],
      });
    }
  });

export const ToolInteractionAttemptSchema = z
  .object({
    ...AttemptBaseShape,
    artifacts: z
      .object({
        argumentsArtifactId: OpaqueIdSchema,
        resultArtifactId: OpaqueIdSchema.optional(),
      })
      .strict(),
    effectMayHaveOccurred: z.boolean(),
    normalizedRequest: InteractionNormalizedRequestReferenceSchema,
    sideEffect: InteractionSideEffectSchema,
  })
  .strict()
  .superRefine((value, context) => {
    refineAttempt(value, context);
    if (value.outcome === "succeeded" && value.artifacts.resultArtifactId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Successful tool attempts require a result artifact",
        path: ["artifacts", "resultArtifactId"],
      });
    }
    if (
      (value.sideEffect === "none" || value.sideEffect === "read_only") &&
      value.effectMayHaveOccurred
    ) {
      context.addIssue({
        code: "custom",
        message: "Non-writing tool attempts cannot report that an effect may have occurred",
        path: ["effectMayHaveOccurred"],
      });
    }
    if (
      value.outcome === "succeeded" &&
      (value.sideEffect === "idempotent_write" || value.sideEffect === "non_idempotent_write") &&
      !value.effectMayHaveOccurred
    ) {
      context.addIssue({
        code: "custom",
        message: "Successful writing tool attempts must report that an effect may have occurred",
        path: ["effectMayHaveOccurred"],
      });
    }
  });

export const ModelInteractionSchema = z
  .object({
    attempts: z
      .array(ModelInteractionAttemptSchema)
      .min(1)
      .max(MAX_CAPTURE_ATTEMPTS_PER_INTERACTION),
    interactionId: OpaqueIdSchema,
    kind: z.literal("model"),
    prompt: InteractionPromptReferenceSchema,
    sequence: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CAPTURE_INTERACTIONS - 1),
    terminalOutcome: InteractionAttemptOutcomeSchema,
    toolContracts: InteractionToolContractsSchema,
  })
  .strict();

export const ToolInteractionSchema = z
  .object({
    attempts: z
      .array(ToolInteractionAttemptSchema)
      .min(1)
      .max(MAX_CAPTURE_ATTEMPTS_PER_INTERACTION),
    callId: ProtocolTokenSchema,
    interactionId: OpaqueIdSchema,
    kind: z.literal("tool"),
    sequence: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CAPTURE_INTERACTIONS - 1),
    terminalOutcome: InteractionAttemptOutcomeSchema,
    tool: InteractionToolContractReferenceSchema,
  })
  .strict();

const CapturedInteractionSchema = z.discriminatedUnion("kind", [
  ModelInteractionSchema,
  ToolInteractionSchema,
]);

type ArtifactIndex = ReadonlyMap<string, z.infer<typeof InteractionArtifactBindingSchema>>;

function requireArtifactRole(
  artifacts: ArtifactIndex,
  referencedArtifactIds: Set<string>,
  artifactId: string,
  expectedRole: z.infer<typeof InteractionArtifactRoleSchema>,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  expectedSha256?: string,
): void {
  referencedArtifactIds.add(artifactId);
  const binding = artifacts.get(artifactId);
  if (!binding) {
    context.addIssue({
      code: "custom",
      message: "Referenced interaction artifact does not exist",
      path: [...path],
    });
    return;
  }
  if (binding.role !== expectedRole) {
    context.addIssue({
      code: "custom",
      message: `Interaction artifact requires role ${expectedRole}`,
      path: [...path],
    });
  }
  if (expectedSha256 && binding.contentReference.sha256 !== expectedSha256) {
    context.addIssue({
      code: "custom",
      message: "Interaction artifact digest does not match its versioned reference",
      path: [...path],
    });
  }
}

function requireOptionalArtifactRole(
  artifacts: ArtifactIndex,
  referencedArtifactIds: Set<string>,
  artifactId: string | undefined,
  expectedRole: z.infer<typeof InteractionArtifactRoleSchema>,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (artifactId !== undefined) {
    requireArtifactRole(artifacts, referencedArtifactIds, artifactId, expectedRole, context, path);
  }
}

function registerSemanticReference(
  identities: Map<string, string>,
  artifactId: string,
  identity: string,
  label: string,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  const existing = identities.get(artifactId);
  if (existing !== undefined && existing !== identity) {
    context.addIssue({
      code: "custom",
      message: `${label} artifact references must use one semantic identity`,
      path: [...path],
    });
    return;
  }
  identities.set(artifactId, identity);
}

export const InteractionCaptureManifestSchema = z
  .object({
    artifacts: InteractionArtifactsSchema,
    interactions: z.array(CapturedInteractionSchema).min(1).max(MAX_CAPTURE_INTERACTIONS),
    schemaVersion: z.literal(INTERACTION_CAPTURE_SCHEMA_VERSION),
    source: InteractionCaptureSourceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const interactionIds = value.interactions.map(({ interactionId }) => interactionId);
    if (!uniqueStrings(interactionIds)) {
      context.addIssue({ code: "custom", message: "Interaction IDs must be unique" });
    }
    if (!isContiguousSequence(value.interactions.map(({ sequence }) => sequence))) {
      context.addIssue({
        code: "custom",
        message: "Interactions must use a contiguous zero-based sequence",
      });
    }

    const artifactIndex = new Map(
      value.artifacts.map((artifact) => [artifact.contentReference.artifactId, artifact] as const),
    );
    const referencedArtifactIds = new Set<string>();
    const attemptIds: string[] = [];
    const normalizedRequestIdentities = new Map<string, string>();
    const promptIdentities = new Map<string, string>();
    const toolContractIdentities = new Map<string, string>();
    const toolCallIds: string[] = [];
    let attemptCount = 0;

    value.interactions.forEach((interaction, interactionIndex) => {
      attemptCount += interaction.attempts.length;
      attemptIds.push(...interaction.attempts.map(({ attemptId }) => attemptId));
      if (!isContiguousSequence(interaction.attempts.map(({ sequence }) => sequence))) {
        context.addIssue({
          code: "custom",
          message: "Interaction attempts must use a contiguous zero-based sequence",
          path: ["interactions", interactionIndex, "attempts"],
        });
      }
      if (interaction.attempts.at(-1)?.outcome !== interaction.terminalOutcome) {
        context.addIssue({
          code: "custom",
          message: "terminalOutcome must equal the last physical attempt outcome",
          path: ["interactions", interactionIndex, "terminalOutcome"],
        });
      }

      if (interaction.kind === "model") {
        registerSemanticReference(
          promptIdentities,
          interaction.prompt.artifactId,
          `${interaction.prompt.promptId}\u0000${interaction.prompt.promptVersion}\u0000${interaction.prompt.definitionSha256}`,
          "Prompt",
          context,
          ["interactions", interactionIndex, "prompt", "artifactId"],
        );
        requireArtifactRole(
          artifactIndex,
          referencedArtifactIds,
          interaction.prompt.artifactId,
          "prompt.template",
          context,
          ["interactions", interactionIndex, "prompt", "artifactId"],
          interaction.prompt.definitionSha256,
        );
        interaction.toolContracts.forEach((tool, toolIndex) => {
          registerSemanticReference(
            toolContractIdentities,
            tool.artifactId,
            `${tool.toolId}\u0000${tool.toolVersion}\u0000${tool.definitionSha256}`,
            "Tool contract",
            context,
            ["interactions", interactionIndex, "toolContracts", toolIndex, "artifactId"],
          );
          requireArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            tool.artifactId,
            "tool.contract",
            context,
            ["interactions", interactionIndex, "toolContracts", toolIndex, "artifactId"],
            tool.definitionSha256,
          );
        });
        interaction.attempts.forEach((attempt, attemptIndex) => {
          const basePath = ["interactions", interactionIndex, "attempts", attemptIndex] as const;
          registerSemanticReference(
            normalizedRequestIdentities,
            attempt.normalizedRequest.artifactId,
            `${attempt.normalizedRequest.adapterName}\u0000${attempt.normalizedRequest.adapterVersion}\u0000${attempt.normalizedRequest.sha256}`,
            "Normalized request",
            context,
            [...basePath, "normalizedRequest", "artifactId"],
          );
          requireArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.normalizedRequest.artifactId,
            "model.normalized_request",
            context,
            [...basePath, "normalizedRequest", "artifactId"],
            attempt.normalizedRequest.sha256,
          );
          requireArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.inputMessagesArtifactId,
            "model.input_messages",
            context,
            [...basePath, "artifacts", "inputMessagesArtifactId"],
          );
          requireArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.providerConfigurationArtifactId,
            "model.provider_configuration",
            context,
            [...basePath, "artifacts", "providerConfigurationArtifactId"],
          );
          requireArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.providerRequestArtifactId,
            "model.provider_request",
            context,
            [...basePath, "artifacts", "providerRequestArtifactId"],
          );
          requireOptionalArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.providerResponseArtifactId,
            "model.provider_response",
            context,
            [...basePath, "artifacts", "providerResponseArtifactId"],
          );
          requireOptionalArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.outputMessagesArtifactId,
            "model.output_messages",
            context,
            [...basePath, "artifacts", "outputMessagesArtifactId"],
          );
          requireOptionalArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.promptVariablesArtifactId,
            "prompt.variables",
            context,
            [...basePath, "artifacts", "promptVariablesArtifactId"],
          );
          requireOptionalArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.streamingFramesArtifactId,
            "model.streaming_frames",
            context,
            [...basePath, "artifacts", "streamingFramesArtifactId"],
          );
          requireOptionalArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.systemInstructionsArtifactId,
            "model.system_instructions",
            context,
            [...basePath, "artifacts", "systemInstructionsArtifactId"],
          );
        });
      } else {
        toolCallIds.push(interaction.callId);
        registerSemanticReference(
          toolContractIdentities,
          interaction.tool.artifactId,
          `${interaction.tool.toolId}\u0000${interaction.tool.toolVersion}\u0000${interaction.tool.definitionSha256}`,
          "Tool contract",
          context,
          ["interactions", interactionIndex, "tool", "artifactId"],
        );
        requireArtifactRole(
          artifactIndex,
          referencedArtifactIds,
          interaction.tool.artifactId,
          "tool.contract",
          context,
          ["interactions", interactionIndex, "tool", "artifactId"],
          interaction.tool.definitionSha256,
        );
        interaction.attempts.forEach((attempt, attemptIndex) => {
          const basePath = ["interactions", interactionIndex, "attempts", attemptIndex] as const;
          registerSemanticReference(
            normalizedRequestIdentities,
            attempt.normalizedRequest.artifactId,
            `${attempt.normalizedRequest.adapterName}\u0000${attempt.normalizedRequest.adapterVersion}\u0000${attempt.normalizedRequest.sha256}`,
            "Normalized request",
            context,
            [...basePath, "normalizedRequest", "artifactId"],
          );
          requireArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.normalizedRequest.artifactId,
            "tool.normalized_request",
            context,
            [...basePath, "normalizedRequest", "artifactId"],
            attempt.normalizedRequest.sha256,
          );
          requireArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.argumentsArtifactId,
            "tool.arguments",
            context,
            [...basePath, "artifacts", "argumentsArtifactId"],
          );
          requireOptionalArtifactRole(
            artifactIndex,
            referencedArtifactIds,
            attempt.artifacts.resultArtifactId,
            "tool.result",
            context,
            [...basePath, "artifacts", "resultArtifactId"],
          );
        });
      }
    });

    if (attemptCount > MAX_CAPTURE_ATTEMPTS) {
      context.addIssue({
        code: "custom",
        message: `Capture cannot contain more than ${MAX_CAPTURE_ATTEMPTS} attempts`,
      });
    }
    if (!uniqueStrings(attemptIds)) {
      context.addIssue({ code: "custom", message: "Attempt IDs must be unique" });
    }
    if (!uniqueStrings(toolCallIds)) {
      context.addIssue({ code: "custom", message: "Tool call IDs must be unique" });
    }

    for (const artifact of value.artifacts) {
      if (!referencedArtifactIds.has(artifact.contentReference.artifactId)) {
        context.addIssue({
          code: "custom",
          message: "Every owned interaction artifact must be referenced by the manifest",
          path: ["artifacts"],
        });
      }
    }
  });

export type InteractionArtifactBinding = z.infer<typeof InteractionArtifactBindingSchema>;
export type InteractionArtifactRole = z.infer<typeof InteractionArtifactRoleSchema>;
export type InteractionAttemptOutcome = z.infer<typeof InteractionAttemptOutcomeSchema>;
export type InteractionCaptureManifest = z.infer<typeof InteractionCaptureManifestSchema>;
export type InteractionCaptureSource = z.infer<typeof InteractionCaptureSourceSchema>;
export type InteractionCompletenessLimitation = z.infer<
  typeof InteractionCompletenessLimitationSchema
>;
export type InteractionNormalizedRequestReference = z.infer<
  typeof InteractionNormalizedRequestReferenceSchema
>;
export type InteractionPromptReference = z.infer<typeof InteractionPromptReferenceSchema>;
export type InteractionSideEffect = z.infer<typeof InteractionSideEffectSchema>;
export type InteractionToolContractReference = z.infer<
  typeof InteractionToolContractReferenceSchema
>;
export type ModelInteraction = z.infer<typeof ModelInteractionSchema>;
export type ModelInteractionAttempt = z.infer<typeof ModelInteractionAttemptSchema>;
export type ToolInteraction = z.infer<typeof ToolInteractionSchema>;
export type ToolInteractionAttempt = z.infer<typeof ToolInteractionAttemptSchema>;
