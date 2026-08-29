import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { RecordedBoundaryReplayInvocationDefinitionSchema } from "./replay.js";

export const TARGET_RELEASE_SCHEMA_VERSION = "0.1" as const;
export const REPLAY_PLAN_SCHEMA_VERSION = "0.1" as const;
export const MAX_TARGET_ENVIRONMENT_NAMES = 64;
export const MAX_TARGET_MOUNTS = 16;
export const MAX_TARGET_SUBPROCESSES = 32;
export const MAX_REPLAY_BOUNDARIES = 64;
export const MAX_REPLAY_ATTEMPTS = 32;
export const MAX_REPLAY_BUDGET_VALUE = Number.MAX_SAFE_INTEGER;

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

const EnvironmentVariableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/);

const RelativeEntryPointSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/);

const SandboxMountPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/proofstack\/(?:inputs|outputs)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);

const HttpsRepositoryUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => value.startsWith("https://"), "Repository URL must use HTTPS");

const DnsHostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function sortedUniqueStrings<T extends z.ZodType<string>>(item: T, maximum: number, label: string) {
  return z
    .array(item)
    .max(maximum)
    .refine(isStrictlySortedUnique, `${label} must be unique and sorted`);
}

export const ReplayBoundaryKindSchema = z.enum(["data", "model", "retrieval", "tool"]);
export const ReplayBoundaryModeSchema = z.enum(["live_provider", "recorded_stub", "simulation"]);

export const ReplayReleaseTargetAdapterReferenceSchema = z
  .object({
    name: ProtocolTokenSchema,
    protocolVersion: ProtocolVersionSchema,
    version: ProtocolVersionSchema,
  })
  .strict();

export const WorkerProtocolReferenceSchema = z
  .object({
    name: ProtocolTokenSchema,
    version: ProtocolVersionSchema,
  })
  .strict();

export const TargetReleaseReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    targetAdapter: ReplayReleaseTargetAdapterReferenceSchema,
    targetId: OpaqueIdSchema,
    targetReleaseId: OpaqueIdSchema,
    workerProtocol: WorkerProtocolReferenceSchema,
  })
  .strict();

const TargetExecutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      artifact: ArtifactContentReferenceSchema,
      bundleFormat: z.enum(["tar_gzip", "zip"]),
      kind: z.literal("artifact"),
    })
    .strict(),
  z
    .object({
      implementationId: OpaqueIdSchema,
      implementationSha256: Sha256Schema,
      kind: z.literal("preinstalled"),
    })
    .strict(),
]);

const TargetMountSchema = z
  .object({
    access: z.enum(["read_only", "read_write"]),
    mountId: OpaqueIdSchema,
    targetPath: SandboxMountPathSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.access === "read_write" && !value.targetPath.startsWith("/proofstack/outputs")) {
      context.addIssue({
        code: "custom",
        message: "Writable mounts must be confined to /proofstack/outputs",
        path: ["targetPath"],
      });
    }
  });

const SubprocessPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("denied") }).strict(),
  z
    .object({
      allowedImplementations: z
        .array(
          z
            .object({
              executableSha256: Sha256Schema,
              implementationId: OpaqueIdSchema,
            })
            .strict(),
        )
        .min(1)
        .max(MAX_TARGET_SUBPROCESSES)
        .refine(
          (values) =>
            isStrictlySortedUnique(values.map(({ implementationId }) => implementationId)),
          "Allowed subprocess implementations must be unique and sorted by implementationId",
        ),
      mode: z.literal("allowlisted"),
    })
    .strict(),
]);

const targetReleaseDefinitionShape = {
  build: z
    .object({
      builderId: ProtocolTokenSchema,
      dependencySnapshotSha256: Sha256Schema,
      executableSha256: Sha256Schema,
      invocationSha256: Sha256Schema,
      provenance: ArtifactContentReferenceSchema,
    })
    .strict(),
  environmentVariableNames: sortedUniqueStrings(
    EnvironmentVariableNameSchema,
    MAX_TARGET_ENVIRONMENT_NAMES,
    "Environment variable names",
  ),
  execution: TargetExecutionSchema,
  mounts: z
    .array(TargetMountSchema)
    .max(MAX_TARGET_MOUNTS)
    .refine(
      (values) => isStrictlySortedUnique(values.map(({ mountId }) => mountId)),
      "Mounts must be unique and sorted by mountId",
    )
    .refine(
      (values) => new Set(values.map(({ targetPath }) => targetPath)).size === values.length,
      "Mount target paths must be unique",
    ),
  outputLimits: z
    .object({
      emittedArtifactBytes: z.number().int().positive().max(MAX_REPLAY_BUDGET_VALUE),
      stderrBytes: z.number().int().positive().max(MAX_REPLAY_BUDGET_VALUE),
      stdoutBytes: z.number().int().positive().max(MAX_REPLAY_BUDGET_VALUE),
    })
    .strict(),
  runtime: z
    .object({
      architecture: z.enum(["arm64", "x64"]),
      entryPoint: RelativeEntryPointSchema,
      family: ProtocolTokenSchema,
      platform: z.enum(["darwin", "linux"]),
      version: ProtocolVersionSchema,
    })
    .strict(),
  schemaVersion: z.literal(TARGET_RELEASE_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
  source: z
    .object({
      repositoryUrl: HttpsRepositoryUrlSchema,
      revision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    })
    .strict(),
  subprocessPolicy: SubprocessPolicySchema,
  supportedBoundaryKinds: sortedUniqueStrings(
    ReplayBoundaryKindSchema,
    ReplayBoundaryKindSchema.options.length,
    "Supported boundary kinds",
  ).min(1),
  supportedBoundaryModes: sortedUniqueStrings(
    ReplayBoundaryModeSchema,
    ReplayBoundaryModeSchema.options.length,
    "Supported boundary modes",
  ).min(1),
  targetAdapter: ReplayReleaseTargetAdapterReferenceSchema,
  targetId: OpaqueIdSchema,
  targetReleaseId: OpaqueIdSchema,
  workerProtocol: WorkerProtocolReferenceSchema,
};

export const TargetReleaseDefinitionSchema = z.object(targetReleaseDefinitionShape).strict();

export const TargetReleaseSchema = z
  .object({
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    ...targetReleaseDefinitionShape,
  })
  .strict();

const ReplayDatasetReferenceSchema = z
  .object({
    datasetId: OpaqueIdSchema,
    datasetVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

const VersionedDefinitionReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    id: OpaqueIdSchema,
    version: ProtocolVersionSchema,
  })
  .strict();

export const ReplayRuntimeProfileReferenceSchema = VersionedDefinitionReferenceSchema.extend({
  family: ProtocolTokenSchema,
}).strict();

export const ReplayIsolationProfileReferenceSchema = VersionedDefinitionReferenceSchema.extend({
  kind: z.enum(["container", "local_child_process"]),
}).strict();

const RecordedBoundaryDeclarationSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    invocation: RecordedBoundaryReplayInvocationDefinitionSchema,
    invocationDefinitionSha256: Sha256Schema,
    kind: z.enum(["model", "tool"]),
    mode: z.literal("recorded_stub"),
  })
  .strict();

const SimulationBoundaryDeclarationSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    configurationSha256: Sha256Schema,
    kind: ReplayBoundaryKindSchema,
    mode: z.literal("simulation"),
    qualification: ArtifactContentReferenceSchema,
    seedHex: Sha256Schema,
    simulatorRelease: TargetReleaseReferenceSchema,
  })
  .strict();

const LiveSideEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read_only") }).strict(),
  z
    .object({
      idempotencyKeyScheme: ProtocolTokenSchema,
      kind: z.literal("idempotent_write"),
      sandboxDestination: z.literal(true),
    })
    .strict(),
  z
    .object({
      automaticRetry: z.literal(false),
      kind: z.literal("non_idempotent_write"),
      riskAcceptance: ArtifactContentReferenceSchema,
    })
    .strict(),
]);

const LiveProviderBoundaryDeclarationSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    credential: z
      .object({
        credentialId: OpaqueIdSchema,
        credentialVersionId: OpaqueIdSchema,
      })
      .strict(),
    destination: z
      .object({
        hostname: DnsHostnameSchema,
        port: z.literal(443),
        scheme: z.literal("https"),
      })
      .strict(),
    endpointProfile: z
      .object({
        definitionSha256: Sha256Schema,
        endpointProfileId: OpaqueIdSchema,
        endpointProfileVersion: ProtocolVersionSchema,
      })
      .strict(),
    kind: ReplayBoundaryKindSchema,
    mode: z.literal("live_provider"),
    operation: ProtocolTokenSchema,
    requestLimits: z
      .object({
        requestBytes: z.number().int().positive().max(MAX_REPLAY_BUDGET_VALUE),
        responseBytes: z.number().int().positive().max(MAX_REPLAY_BUDGET_VALUE),
      })
      .strict(),
    sideEffect: LiveSideEffectSchema,
    usageSource: z.enum(["estimated", "measured", "provider_reported", "unavailable"]),
  })
  .strict();

export const ReplayBoundaryDeclarationSchema = z.discriminatedUnion("mode", [
  LiveProviderBoundaryDeclarationSchema,
  RecordedBoundaryDeclarationSchema,
  SimulationBoundaryDeclarationSchema,
]);

export const ReplayBudgetMeasurementSchema = z.enum([
  "estimated",
  "measured",
  "provider_reported",
  "unavailable",
]);

const BudgetLimitSchema = z
  .object({
    limit: z.number().int().positive().max(MAX_REPLAY_BUDGET_VALUE),
    measurement: ReplayBudgetMeasurementSchema,
  })
  .strict();

export const ReplayBudgetSchema = z
  .object({
    concurrentInteractions: BudgetLimitSchema,
    elapsedMilliseconds: BudgetLimitSchema,
    emittedArtifactBytes: BudgetLimitSchema,
    inputTokens: BudgetLimitSchema,
    jobAttempts: BudgetLimitSchema,
    modelRequests: BudgetLimitSchema,
    outputTokens: BudgetLimitSchema,
    providerCostMicrounits: BudgetLimitSchema,
    retrievedBytes: BudgetLimitSchema,
    toolCalls: BudgetLimitSchema,
  })
  .strict();

export const ReplayRetryableErrorSchema = z.enum([
  "boundary_rate_limited",
  "boundary_temporarily_unavailable",
  "target_process_interrupted",
  "target_temporary_failure",
]);

const ReplayBackoffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      delayMilliseconds: z.number().int().positive().max(3_600_000),
      kind: z.literal("fixed"),
    })
    .strict(),
  z
    .object({
      initialDelayMilliseconds: z.number().int().positive().max(3_600_000),
      kind: z.literal("exponential"),
      maximumDelayMilliseconds: z.number().int().positive().max(3_600_000),
      multiplier: z.number().int().min(2).max(16),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.maximumDelayMilliseconds < value.initialDelayMilliseconds) {
        context.addIssue({
          code: "custom",
          message: "Maximum backoff delay must not be below its initial delay",
          path: ["maximumDelayMilliseconds"],
        });
      }
    }),
]);

export const ReplayRetryPolicySchema = z
  .object({
    automatic: z.boolean(),
    backoff: ReplayBackoffSchema,
    idempotencyRequirement: z.enum(["destination_supported", "no_external_effect", "read_only"]),
    maxAttempts: z.number().int().positive().max(MAX_REPLAY_ATTEMPTS),
    perAttemptTimeoutMilliseconds: z.number().int().positive().max(MAX_REPLAY_BUDGET_VALUE),
    retryableErrors: sortedUniqueStrings(
      ReplayRetryableErrorSchema,
      ReplayRetryableErrorSchema.options.length,
      "Retryable errors",
    ),
    totalDeadlineMilliseconds: z.number().int().positive().max(MAX_REPLAY_BUDGET_VALUE),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.perAttemptTimeoutMilliseconds > value.totalDeadlineMilliseconds) {
      context.addIssue({
        code: "custom",
        message: "Per-attempt timeout must not exceed the total deadline",
        path: ["perAttemptTimeoutMilliseconds"],
      });
    }
    if (value.maxAttempts === 1 && value.automatic) {
      context.addIssue({
        code: "custom",
        message: "Single-attempt policies cannot enable automatic retry",
        path: ["automatic"],
      });
    }
    if (!value.automatic && value.retryableErrors.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Disabled automatic retry cannot declare retryable errors",
        path: ["retryableErrors"],
      });
    }
    if (!value.automatic && value.backoff.kind !== "none") {
      context.addIssue({
        code: "custom",
        message: "Disabled automatic retry requires no backoff",
        path: ["backoff"],
      });
    }
  });

const replayPlanDefinitionShape = {
  boundaries: z
    .array(ReplayBoundaryDeclarationSchema)
    .min(1)
    .max(MAX_REPLAY_BOUNDARIES)
    .refine(
      (values) => isStrictlySortedUnique(values.map(({ boundaryId }) => boundaryId)),
      "Boundaries must be unique and sorted by boundaryId",
    ),
  budget: ReplayBudgetSchema,
  dataset: ReplayDatasetReferenceSchema,
  isolationProfile: ReplayIsolationProfileReferenceSchema,
  planId: OpaqueIdSchema,
  planVersionId: OpaqueIdSchema,
  retryPolicy: ReplayRetryPolicySchema,
  runtimeProfile: ReplayRuntimeProfileReferenceSchema,
  schemaVersion: z.literal(REPLAY_PLAN_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
  targetRelease: TargetReleaseReferenceSchema,
  workerProtocol: WorkerProtocolReferenceSchema,
};

function refineReplayPlan(
  value: z.infer<z.ZodObject<typeof replayPlanDefinitionShape>>,
  context: z.RefinementCtx,
): void {
  if (
    value.workerProtocol.name !== value.targetRelease.workerProtocol.name ||
    value.workerProtocol.version !== value.targetRelease.workerProtocol.version
  ) {
    context.addIssue({
      code: "custom",
      message: "Plan and target release worker protocols must match exactly",
      path: ["workerProtocol"],
    });
  }
  if (value.retryPolicy.maxAttempts > value.budget.jobAttempts.limit) {
    context.addIssue({
      code: "custom",
      message: "Retry attempts must fit within the job-attempt budget",
      path: ["retryPolicy", "maxAttempts"],
    });
  }
  if (value.retryPolicy.totalDeadlineMilliseconds > value.budget.elapsedMilliseconds.limit) {
    context.addIssue({
      code: "custom",
      message: "Retry deadline must fit within the elapsed-time budget",
      path: ["retryPolicy", "totalDeadlineMilliseconds"],
    });
  }

  for (const [index, boundary] of value.boundaries.entries()) {
    if (boundary.mode === "recorded_stub") {
      const planAdapter = value.targetRelease.targetAdapter;
      const invocationAdapter = boundary.invocation.targetAdapter;
      if (
        planAdapter.name !== invocationAdapter.name ||
        planAdapter.version !== invocationAdapter.version
      ) {
        context.addIssue({
          code: "custom",
          message: "Recorded invocation target adapter must match the exact target release",
          path: ["boundaries", index, "invocation", "targetAdapter"],
        });
      }
    }
    if (boundary.mode === "live_provider" && boundary.sideEffect.kind === "non_idempotent_write") {
      if (value.retryPolicy.automatic || value.retryPolicy.maxAttempts !== 1) {
        context.addIssue({
          code: "custom",
          message: "Non-idempotent live writes prohibit automatic or multi-attempt execution",
          path: ["boundaries", index, "sideEffect"],
        });
      }
    }
    if (
      boundary.mode === "live_provider" &&
      boundary.sideEffect.kind === "idempotent_write" &&
      value.retryPolicy.automatic &&
      value.retryPolicy.idempotencyRequirement !== "destination_supported"
    ) {
      context.addIssue({
        code: "custom",
        message: "Retrying live writes requires destination-supported idempotency",
        path: ["retryPolicy", "idempotencyRequirement"],
      });
    }
  }
}

export const ReplayPlanDefinitionSchema = z
  .object(replayPlanDefinitionShape)
  .strict()
  .superRefine(refineReplayPlan);

export const ReplayPlanSchema = z
  .object({
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    ...replayPlanDefinitionShape,
  })
  .strict()
  .superRefine(refineReplayPlan);

export type ReplayBoundaryDeclaration = z.infer<typeof ReplayBoundaryDeclarationSchema>;
export type ReplayBoundaryKind = z.infer<typeof ReplayBoundaryKindSchema>;
export type ReplayBoundaryMode = z.infer<typeof ReplayBoundaryModeSchema>;
export type ReplayBudget = z.infer<typeof ReplayBudgetSchema>;
export type ReplayBudgetMeasurement = z.infer<typeof ReplayBudgetMeasurementSchema>;
export type ReplayIsolationProfileReference = z.infer<typeof ReplayIsolationProfileReferenceSchema>;
export type ReplayPlan = z.infer<typeof ReplayPlanSchema>;
export type ReplayPlanDefinition = z.infer<typeof ReplayPlanDefinitionSchema>;
export type ReplayRetryPolicy = z.infer<typeof ReplayRetryPolicySchema>;
export type ReplayRetryableError = z.infer<typeof ReplayRetryableErrorSchema>;
export type ReplayRuntimeProfileReference = z.infer<typeof ReplayRuntimeProfileReferenceSchema>;
export type ReplayReleaseTargetAdapterReference = z.infer<
  typeof ReplayReleaseTargetAdapterReferenceSchema
>;
export type TargetRelease = z.infer<typeof TargetReleaseSchema>;
export type TargetReleaseDefinition = z.infer<typeof TargetReleaseDefinitionSchema>;
export type TargetReleaseReference = z.infer<typeof TargetReleaseReferenceSchema>;
export type WorkerProtocolReference = z.infer<typeof WorkerProtocolReferenceSchema>;
