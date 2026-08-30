import {
  type ReplayBoundaryDeclaration,
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  type TargetReleaseDefinition,
  TargetReleaseDefinitionSchema,
  type TargetReleaseReference,
} from "@proofstack/contracts";

export const TARGET_RELEASE_DEFINITION_DOMAIN = "proofstack.target-release.v1" as const;
export const REPLAY_PLAN_DEFINITION_DOMAIN = "proofstack.replay-plan.v1" as const;
export const RECORDED_BOUNDARY_REPLAY_INVOCATION_DOMAIN =
  "proofstack.recorded-boundary-replay.v1" as const;

const MAX_UNSIGNED_32 = 0xffff_ffff;
const textEncoder = new TextEncoder();

export class ReplayDefinitionDigestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReplayDefinitionDigestError";
  }
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function encodeBoolean(value: boolean): Uint8Array {
  if (typeof value !== "boolean") {
    throw new TypeError("Replay definition encoding requires a boolean");
  }
  return Uint8Array.of(value ? 1 : 0);
}

function encodeUnsigned32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UNSIGNED_32) {
    throw new RangeError("Replay definition encoding requires an unsigned 32-bit integer");
  }
  const encoded = new Uint8Array(4);
  new DataView(encoded.buffer).setUint32(0, value, false);
  return encoded;
}

function encodeUnsignedSafeInteger(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Replay definition encoding requires a nonnegative safe integer");
  }
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, BigInt(value), false);
  return encoded;
}

function encodeBytes(value: Uint8Array): Uint8Array {
  return concatenateBytes([encodeUnsigned32(value.byteLength), value]);
}

function encodeString(value: string): Uint8Array {
  return encodeBytes(textEncoder.encode(value));
}

function encodeOptional<T>(value: T | undefined, encode: (present: T) => Uint8Array): Uint8Array {
  return value === undefined
    ? Uint8Array.of(0)
    : concatenateBytes([Uint8Array.of(1), encode(value)]);
}

function encodeSequence<T>(values: readonly T[], encode: (value: T) => Uint8Array): Uint8Array {
  return concatenateBytes([encodeUnsigned32(values.length), ...values.map(encode)]);
}

function encodeScope(scope: TargetReleaseDefinition["scope"]): Uint8Array {
  return concatenateBytes([
    encodeString(scope.tenantId),
    encodeString(scope.projectId),
    encodeString(scope.environmentId),
  ]);
}

function encodeArtifactReference(
  reference: TargetReleaseDefinition["build"]["provenance"],
): Uint8Array {
  return concatenateBytes([
    encodeString(reference.artifactId),
    encodeString(reference.classification),
    encodeString(reference.mediaType),
    encodeOptional(reference.redactedAt, encodeString),
    encodeString(reference.sha256),
    encodeUnsignedSafeInteger(reference.sizeBytes),
  ]);
}

function encodeWorkerProtocol(protocol: TargetReleaseDefinition["workerProtocol"]): Uint8Array {
  return concatenateBytes([encodeString(protocol.name), encodeString(protocol.version)]);
}

function encodeTargetAdapter(adapter: TargetReleaseDefinition["targetAdapter"]): Uint8Array {
  return concatenateBytes([
    encodeString(adapter.name),
    encodeString(adapter.version),
    encodeString(adapter.protocolVersion),
  ]);
}

function encodeTargetReleaseReference(reference: TargetReleaseReference): Uint8Array {
  return concatenateBytes([
    encodeString(reference.targetId),
    encodeString(reference.targetReleaseId),
    encodeString(reference.definitionSha256),
    encodeTargetAdapter(reference.targetAdapter),
    encodeWorkerProtocol(reference.workerProtocol),
  ]);
}

function encodeTargetExecution(execution: TargetReleaseDefinition["execution"]): Uint8Array {
  if (execution.kind === "artifact") {
    return concatenateBytes([
      encodeString(execution.kind),
      encodeString(execution.bundleFormat),
      encodeArtifactReference(execution.artifact),
    ]);
  }
  return concatenateBytes([
    encodeString(execution.kind),
    encodeString(execution.implementationId),
    encodeString(execution.implementationSha256),
  ]);
}

function encodeSubprocessPolicy(policy: TargetReleaseDefinition["subprocessPolicy"]): Uint8Array {
  if (policy.mode === "denied") return encodeString(policy.mode);
  return concatenateBytes([
    encodeString(policy.mode),
    encodeSequence(policy.allowedImplementations, (implementation) =>
      concatenateBytes([
        encodeString(implementation.implementationId),
        encodeString(implementation.executableSha256),
      ]),
    ),
  ]);
}

export function encodeTargetReleaseDefinition(input: TargetReleaseDefinition): Uint8Array {
  const definition = TargetReleaseDefinitionSchema.parse(input);
  return concatenateBytes([
    encodeString(TARGET_RELEASE_DEFINITION_DOMAIN),
    encodeString(definition.schemaVersion),
    encodeScope(definition.scope),
    encodeString(definition.targetId),
    encodeString(definition.targetReleaseId),
    encodeTargetAdapter(definition.targetAdapter),
    encodeString(definition.source.repositoryUrl),
    encodeString(definition.source.revision),
    encodeString(definition.build.builderId),
    encodeString(definition.build.invocationSha256),
    encodeString(definition.build.executableSha256),
    encodeString(definition.build.dependencySnapshotSha256),
    encodeArtifactReference(definition.build.provenance),
    encodeTargetExecution(definition.execution),
    encodeString(definition.runtime.family),
    encodeString(definition.runtime.version),
    encodeString(definition.runtime.platform),
    encodeString(definition.runtime.architecture),
    encodeString(definition.runtime.entryPoint),
    encodeSequence(definition.environmentVariableNames, encodeString),
    encodeSequence(definition.mounts, (mount) =>
      concatenateBytes([
        encodeString(mount.mountId),
        encodeString(mount.targetPath),
        encodeString(mount.access),
      ]),
    ),
    encodeSubprocessPolicy(definition.subprocessPolicy),
    encodeUnsignedSafeInteger(definition.outputLimits.stdoutBytes),
    encodeUnsignedSafeInteger(definition.outputLimits.stderrBytes),
    encodeUnsignedSafeInteger(definition.outputLimits.emittedArtifactBytes),
    encodeSequence(definition.supportedBoundaryKinds, encodeString),
    encodeSequence(definition.supportedBoundaryModes, encodeString),
    encodeWorkerProtocol(definition.workerProtocol),
  ]);
}

function encodeVersionedDefinitionReference(reference: {
  readonly definitionSha256: string;
  readonly id: string;
  readonly version: string;
}): Uint8Array {
  return concatenateBytes([
    encodeString(reference.id),
    encodeString(reference.version),
    encodeString(reference.definitionSha256),
  ]);
}

function encodeReplayBudget(budget: ReplayPlanDefinition["budget"]): Uint8Array {
  return concatenateBytes(
    [
      budget.concurrentInteractions,
      budget.elapsedMilliseconds,
      budget.emittedArtifactBytes,
      budget.inputTokens,
      budget.jobAttempts,
      budget.modelRequests,
      budget.outputTokens,
      budget.providerCostMicrounits,
      budget.retrievedBytes,
      budget.toolCalls,
    ].map((dimension) =>
      concatenateBytes([
        encodeUnsignedSafeInteger(dimension.limit),
        encodeString(dimension.measurement),
      ]),
    ),
  );
}

function encodeRetryPolicy(policy: ReplayPlanDefinition["retryPolicy"]): Uint8Array {
  let backoff: Uint8Array;
  if (policy.backoff.kind === "none") {
    backoff = encodeString(policy.backoff.kind);
  } else if (policy.backoff.kind === "fixed") {
    backoff = concatenateBytes([
      encodeString(policy.backoff.kind),
      encodeUnsignedSafeInteger(policy.backoff.delayMilliseconds),
    ]);
  } else {
    backoff = concatenateBytes([
      encodeString(policy.backoff.kind),
      encodeUnsignedSafeInteger(policy.backoff.initialDelayMilliseconds),
      encodeUnsignedSafeInteger(policy.backoff.maximumDelayMilliseconds),
      encodeUnsignedSafeInteger(policy.backoff.multiplier),
    ]);
  }
  return concatenateBytes([
    encodeBoolean(policy.automatic),
    encodeUnsignedSafeInteger(policy.maxAttempts),
    encodeUnsignedSafeInteger(policy.perAttemptTimeoutMilliseconds),
    encodeUnsignedSafeInteger(policy.totalDeadlineMilliseconds),
    encodeString(policy.idempotencyRequirement),
    encodeSequence(policy.retryableErrors, encodeString),
    backoff,
  ]);
}

function encodeRecordedBoundaryReplayInvocationDefinition(
  input: Extract<ReplayBoundaryDeclaration, { readonly mode: "recorded_stub" }>["invocation"],
): Uint8Array {
  return concatenateBytes([
    encodeString(RECORDED_BOUNDARY_REPLAY_INVOCATION_DOMAIN),
    encodeString(input.schemaVersion),
    encodeString(input.invocationId),
    encodeString(input.fixture.fixtureId),
    encodeString(input.fixture.fixtureVersionId),
    encodeString(input.fixture.definitionSha256),
    encodeString(input.targetAdapter.name),
    encodeString(input.targetAdapter.version),
    encodeString(input.runtime.boundaryMode),
    encodeString(input.runtime.clock.mode),
    encodeString(input.runtime.clock.instant),
    encodeString(input.runtime.random.mode),
    encodeString(input.runtime.random.algorithm),
    encodeString(input.runtime.random.seedHex),
    encodeString(input.runtime.locale),
    encodeString(input.runtime.timeZone),
    encodeString(input.runtime.network.policy),
    encodeString(input.runtime.isolation.mode),
  ]);
}

function encodeLiveSideEffect(
  sideEffect: Extract<ReplayBoundaryDeclaration, { readonly mode: "live_provider" }>["sideEffect"],
): Uint8Array {
  if (sideEffect.kind === "read_only") return encodeString(sideEffect.kind);
  if (sideEffect.kind === "idempotent_write") {
    return concatenateBytes([
      encodeString(sideEffect.kind),
      encodeBoolean(sideEffect.sandboxDestination),
      encodeString(sideEffect.idempotencyKeyScheme),
    ]);
  }
  return concatenateBytes([
    encodeString(sideEffect.kind),
    encodeBoolean(sideEffect.automaticRetry),
    encodeArtifactReference(sideEffect.riskAcceptance),
  ]);
}

function encodeBoundary(boundary: ReplayBoundaryDeclaration): Uint8Array {
  const common = [
    encodeString(boundary.boundaryId),
    encodeString(boundary.kind),
    encodeString(boundary.mode),
  ];
  if (boundary.mode === "recorded_stub") {
    return concatenateBytes([
      ...common,
      encodeString(boundary.invocationDefinitionSha256),
      encodeBytes(encodeRecordedBoundaryReplayInvocationDefinition(boundary.invocation)),
    ]);
  }
  if (boundary.mode === "simulation") {
    return concatenateBytes([
      ...common,
      encodeTargetReleaseReference(boundary.simulatorRelease),
      encodeString(boundary.configurationSha256),
      encodeString(boundary.seedHex),
      encodeArtifactReference(boundary.qualification),
    ]);
  }
  return concatenateBytes([
    ...common,
    encodeString(boundary.endpointProfile.endpointProfileId),
    encodeString(boundary.endpointProfile.endpointProfileVersion),
    encodeString(boundary.endpointProfile.definitionSha256),
    encodeString(boundary.operation),
    encodeString(boundary.credential.credentialId),
    encodeString(boundary.credential.credentialVersionId),
    encodeString(boundary.destination.scheme),
    encodeString(boundary.destination.hostname),
    encodeUnsignedSafeInteger(boundary.destination.port),
    encodeUnsignedSafeInteger(boundary.requestLimits.requestBytes),
    encodeUnsignedSafeInteger(boundary.requestLimits.responseBytes),
    encodeString(boundary.usageSource),
    encodeLiveSideEffect(boundary.sideEffect),
  ]);
}

export function encodeReplayPlanDefinition(input: ReplayPlanDefinition): Uint8Array {
  const definition = ReplayPlanDefinitionSchema.parse(input);
  return concatenateBytes([
    encodeString(REPLAY_PLAN_DEFINITION_DOMAIN),
    encodeString(definition.schemaVersion),
    encodeScope(definition.scope),
    encodeString(definition.planId),
    encodeString(definition.planVersionId),
    encodeTargetReleaseReference(definition.targetRelease),
    encodeString(definition.dataset.datasetId),
    encodeString(definition.dataset.datasetVersionId),
    encodeString(definition.dataset.definitionSha256),
    encodeVersionedDefinitionReference(definition.runtimeProfile),
    encodeString(definition.runtimeProfile.family),
    encodeVersionedDefinitionReference(definition.isolationProfile),
    encodeString(definition.isolationProfile.kind),
    encodeReplayBudget(definition.budget),
    encodeRetryPolicy(definition.retryPolicy),
    encodeSequence(definition.boundaries, encodeBoundary),
    encodeWorkerProtocol(definition.workerProtocol),
  ]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ReplayDefinitionDigestError(
      "Web Crypto is required to verify replay definition integrity",
    );
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  } catch (cause) {
    throw new ReplayDefinitionDigestError("Replay definition digest calculation failed", {
      cause,
    });
  }
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestTargetReleaseDefinition(
  input: TargetReleaseDefinition,
): Promise<string> {
  return sha256Hex(encodeTargetReleaseDefinition(input));
}

export async function digestReplayPlanDefinition(input: ReplayPlanDefinition): Promise<string> {
  return sha256Hex(encodeReplayPlanDefinition(input));
}
