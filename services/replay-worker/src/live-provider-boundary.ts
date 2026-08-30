import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  ReplayBoundaryDeclarationSchema,
  type ReplayBoundaryExecutionRequest,
  ReplayBoundaryExecutionRequestSchema,
  type ReplayBoundaryExecutionResult,
  ReplayBoundaryExecutionResultSchema,
  type ReplayBoundaryExecutionUsage,
  ReplayBoundaryExecutionUsageSchema,
  type ReplayBoundaryNormalizedResponse,
  ReplayBoundaryNormalizedResponseSchema,
  ReplayWorkerMutationFenceSchema,
  Sha256Schema,
} from "@proofstack/contracts";
import {
  ReplayLiveProviderBoundaryError,
  type ReplayLiveProviderBoundaryErrorCode,
  type ReplayLiveProviderBoundaryErrorEvidence,
} from "./errors.js";

type LiveDeclaration = Extract<
  ReturnType<typeof ReplayBoundaryDeclarationSchema.parse>,
  { readonly mode: "live_provider" }
>;

export type ReplayLiveProviderPortErrorCode =
  | "credential_unavailable"
  | "provider_failed"
  | "rate_limited"
  | "request_rejected"
  | "temporarily_unavailable";

export class ReplayLiveProviderPortError extends Error {
  readonly code: ReplayLiveProviderPortErrorCode;
  readonly requestStarted: boolean;

  constructor(code: ReplayLiveProviderPortErrorCode, requestStarted: boolean) {
    super(`Replay live-provider port failed: ${code}`);
    this.name = "ReplayLiveProviderPortError";
    this.code = code;
    this.requestStarted = requestStarted;
  }
}

export interface ReplayLiveProviderRegistryQuery {
  readonly destination: LiveDeclaration["destination"];
  readonly endpointProfile: LiveDeclaration["endpointProfile"];
  readonly operation: string;
  readonly sideEffect: LiveDeclaration["sideEffect"];
}

export interface ReplayLiveProviderInvocation {
  readonly credential: LiveDeclaration["credential"];
  readonly idempotencyKey?: string;
  readonly request: ReplayBoundaryExecutionRequest;
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
  readonly signal: AbortSignal;
}

export interface ReplayLiveProviderOutcome {
  readonly response: ReplayBoundaryNormalizedResponse;
  readonly usage: ReplayBoundaryExecutionUsage;
}

export interface ResolvedReplayLiveProvider extends ReplayLiveProviderRegistryQuery {
  readonly destinationIdempotency?: {
    readonly evidenceSha256: string;
    readonly idempotencyKeyScheme: string;
  };
  execute(input: ReplayLiveProviderInvocation): Promise<unknown>;
}

export interface ReplayLiveProviderRegistry {
  resolve(
    query: ReplayLiveProviderRegistryQuery,
    signal: AbortSignal,
  ): Promise<ResolvedReplayLiveProvider | null>;
}

export interface ExecuteLiveProviderBoundaryOptions {
  readonly declaration: unknown;
  readonly registry: ReplayLiveProviderRegistry;
  readonly request: unknown;
  readonly scope: unknown;
  readonly signal?: AbortSignal;
  readonly workerFence: unknown;
}

interface LiveContext {
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
  readonly workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>;
}

type LiveRetrySafety = NonNullable<ReplayLiveProviderBoundaryErrorEvidence["effectRetrySafety"]>;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function noEffect(): ReplayLiveProviderBoundaryErrorEvidence {
  return { effectCertainty: "none" };
}

function throwBoundary(
  code: ReplayLiveProviderBoundaryErrorCode,
  evidence: ReplayLiveProviderBoundaryErrorEvidence = noEffect(),
): never {
  throw new ReplayLiveProviderBoundaryError(code, evidence);
}

function parseDeclaration(input: unknown): LiveDeclaration {
  const parsed = ReplayBoundaryDeclarationSchema.safeParse(input);
  if (!parsed.success || parsed.data.mode !== "live_provider") {
    throwBoundary("invalid_declaration");
  }
  if (parsed.data.sideEffect.kind === "non_idempotent_write") {
    throwBoundary("non_idempotent_write_denied");
  }
  return parsed.data;
}

function parseRequest(input: unknown): ReplayBoundaryExecutionRequest {
  const parsed = ReplayBoundaryExecutionRequestSchema.safeParse(input);
  if (!parsed.success) throwBoundary("invalid_request");
  return Object.freeze({
    ...parsed.data,
    normalizedRequest: Object.freeze({
      ...parsed.data.normalizedRequest,
      adapter: Object.freeze({ ...parsed.data.normalizedRequest.adapter }),
    }),
  });
}

function parseContext(options: ExecuteLiveProviderBoundaryOptions): LiveContext {
  const scope = EvidenceScopeSchema.safeParse(options.scope);
  const workerFence = ReplayWorkerMutationFenceSchema.safeParse(options.workerFence);
  if (!scope.success || !workerFence.success) throwBoundary("invalid_context");
  return Object.freeze({ scope: scope.data, workerFence: workerFence.data });
}

function query(declaration: LiveDeclaration): ReplayLiveProviderRegistryQuery {
  return Object.freeze({
    destination: Object.freeze({ ...declaration.destination }),
    endpointProfile: Object.freeze({ ...declaration.endpointProfile }),
    operation: declaration.operation,
    sideEffect: Object.freeze({ ...declaration.sideEffect }),
  });
}

function exactProvider(
  resolved: ResolvedReplayLiveProvider,
  expected: ReplayLiveProviderRegistryQuery,
): boolean {
  const destinationIdempotencyMatches =
    expected.sideEffect.kind === "idempotent_write"
      ? resolved.destinationIdempotency?.idempotencyKeyScheme ===
          expected.sideEffect.idempotencyKeyScheme &&
        Sha256Schema.safeParse(resolved.destinationIdempotency.evidenceSha256).success
      : resolved.destinationIdempotency === undefined;
  return (
    typeof resolved?.execute === "function" &&
    sameJson(resolved.destination, expected.destination) &&
    sameJson(resolved.endpointProfile, expected.endpointProfile) &&
    resolved.operation === expected.operation &&
    sameJson(resolved.sideEffect, expected.sideEffect) &&
    destinationIdempotencyMatches
  );
}

function requestBytes(request: ReplayBoundaryExecutionRequest): Buffer {
  return Buffer.from(request.normalizedRequest.bytes, "base64url");
}

function idempotencyKey(
  declaration: LiveDeclaration,
  request: ReplayBoundaryExecutionRequest,
  context: LiveContext,
): string | undefined {
  if (declaration.sideEffect.kind !== "idempotent_write") return undefined;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        boundaryId: declaration.boundaryId,
        idempotencyKeyScheme: declaration.sideEffect.idempotencyKeyScheme,
        jobId: context.workerFence.jobId,
        normalizedRequestSha256: createHash("sha256").update(requestBytes(request)).digest("hex"),
        scope: [context.scope.tenantId, context.scope.projectId, context.scope.environmentId],
      }),
      "utf8",
    )
    .digest("hex");
  return `psk_${digest}`;
}

function idempotencyEvidence(key: string, destinationEvidenceSha256: string) {
  return Object.freeze({
    evidenceSha256: destinationEvidenceSha256,
    idempotencyKeySha256: createHash("sha256").update(key, "utf8").digest("hex"),
    kind: "destination_idempotency_verified" as const,
  });
}

function failureEvidence(
  declaration: LiveDeclaration,
  retrySafety: ReplayLiveProviderBoundaryErrorEvidence["effectRetrySafety"],
  requestStarted: boolean,
): ReplayLiveProviderBoundaryErrorEvidence {
  if (!requestStarted || declaration.sideEffect.kind === "read_only") return noEffect();
  // Preflight rejects non-idempotent writes, so every started write has a derived stable key.
  return {
    effectCertainty: "may_have_occurred",
    effectRetrySafety: retrySafety as LiveRetrySafety,
  };
}

const errorCodeByPortCode: Readonly<
  Record<ReplayLiveProviderPortErrorCode, ReplayLiveProviderBoundaryErrorCode>
> = Object.freeze({
  credential_unavailable: "credential_unavailable",
  provider_failed: "provider_failed",
  rate_limited: "provider_rate_limited",
  request_rejected: "request_rejected",
  temporarily_unavailable: "provider_temporarily_unavailable",
});

function providerFailure(
  error: unknown,
  declaration: LiveDeclaration,
  retrySafety: ReplayLiveProviderBoundaryErrorEvidence["effectRetrySafety"],
  signal: AbortSignal,
): never {
  if (error instanceof ReplayLiveProviderPortError) {
    if (error.code === "credential_unavailable" && error.requestStarted) {
      throwBoundary("provider_contract_failed", failureEvidence(declaration, retrySafety, true));
    }
    throwBoundary(
      signal.aborted ? "cancelled" : errorCodeByPortCode[error.code],
      failureEvidence(declaration, retrySafety, error.requestStarted),
    );
  }
  throwBoundary(
    signal.aborted ? "cancelled" : "provider_failed",
    failureEvidence(declaration, retrySafety, true),
  );
}

function parseOutcome(
  input: unknown,
  declaration: LiveDeclaration,
  request: ReplayBoundaryExecutionRequest,
): ReplayLiveProviderOutcome {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throwBoundary("invalid_provider_result");
  }
  const candidate = input as { readonly response: unknown; readonly usage: unknown };
  if (
    Object.keys(candidate).length !== 2 ||
    !("response" in candidate) ||
    !("usage" in candidate)
  ) {
    throwBoundary("invalid_provider_result");
  }
  const response = ReplayBoundaryNormalizedResponseSchema.safeParse(candidate.response);
  const usage = ReplayBoundaryExecutionUsageSchema.safeParse(candidate.usage);
  if (!response.success || !usage.success) throwBoundary("invalid_provider_result");
  const bytes = Buffer.from(response.data.bytes, "base64url");
  const validUsage = usage.data.every(({ usage: measurement }) =>
    declaration.usageSource === "unavailable"
      ? measurement.status === "unavailable"
      : measurement.status === "observed" && measurement.source === declaration.usageSource,
  );
  if (
    !sameJson(response.data.adapter, request.normalizedRequest.adapter) ||
    bytes.byteLength !== response.data.sizeBytes ||
    bytes.byteLength > declaration.requestLimits.responseBytes ||
    createHash("sha256").update(bytes).digest("hex") !== response.data.normalizedResponseSha256 ||
    !validUsage
  ) {
    throwBoundary("invalid_provider_result");
  }
  return Object.freeze({ response: response.data, usage: usage.data });
}

function actualRequest(request: ReplayBoundaryExecutionRequest) {
  const bytes = requestBytes(request);
  return Object.freeze({
    adapter: request.normalizedRequest.adapter,
    boundaryRequestId: request.boundaryRequestId,
    kind: request.kind,
    normalizedRequestSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  });
}

/** Executes one allowlisted live operation without exposing credential values to the worker. */
export async function executeLiveProviderBoundary(
  options: ExecuteLiveProviderBoundaryOptions,
): Promise<ReplayBoundaryExecutionResult> {
  const declaration = parseDeclaration(options.declaration);
  const request = parseRequest(options.request);
  const context = parseContext(options);
  if (request.kind !== declaration.kind) throwBoundary("request_kind_mismatch");
  if (requestBytes(request).byteLength > declaration.requestLimits.requestBytes) {
    throwBoundary("request_too_large");
  }
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) throwBoundary("cancelled");
  const expected = query(declaration);
  let provider: ResolvedReplayLiveProvider | null;
  try {
    provider = await options.registry.resolve(expected, signal);
  } catch {
    throwBoundary("provider_unavailable");
  }
  if (signal.aborted) throwBoundary("cancelled");
  if (provider === null) throwBoundary("provider_unavailable");
  if (!exactProvider(provider, expected)) throwBoundary("provider_identity_mismatch");
  const key = idempotencyKey(declaration, request, context);
  const retrySafety =
    key === undefined
      ? undefined
      : idempotencyEvidence(
          key,
          (
            provider.destinationIdempotency as NonNullable<
              ResolvedReplayLiveProvider["destinationIdempotency"]
            >
          ).evidenceSha256,
        );
  let candidate: unknown;
  try {
    candidate = await provider.execute({
      credential: Object.freeze({ ...declaration.credential }),
      ...(key === undefined ? {} : { idempotencyKey: key }),
      request,
      scope: Object.freeze({ ...context.scope }),
      signal,
    });
  } catch (error) {
    providerFailure(error, declaration, retrySafety, signal);
  }
  const outcome = parseOutcome(candidate, declaration, request);
  const effect =
    key === undefined
      ? noEffect()
      : ({
          effectCertainty: "confirmed",
          effectRetrySafety: retrySafety as LiveRetrySafety,
        } satisfies ReplayLiveProviderBoundaryErrorEvidence);
  return Object.freeze(
    ReplayBoundaryExecutionResultSchema.parse({
      actualRequest: actualRequest(request),
      boundaryId: declaration.boundaryId,
      declaration,
      effectCertainty: effect.effectCertainty,
      ...(effect.effectRetrySafety === undefined
        ? {}
        : { effectRetrySafety: effect.effectRetrySafety }),
      executionOrigin: "live",
      mode: "live_provider",
      output: { kind: "normalized_response", response: outcome.response },
      schemaVersion: "0.1",
      usage: outcome.usage,
    }),
  );
}
