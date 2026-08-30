import { createHash } from "node:crypto";
import {
  ReplayBoundaryDeclarationSchema,
  type ReplayBoundaryExecutionRequest,
  ReplayBoundaryExecutionRequestSchema,
  type ReplayBoundaryExecutionResult,
  ReplayBoundaryExecutionResultSchema,
  type ReplayBoundaryExecutionUsage,
  ReplayBoundaryExecutionUsageSchema,
  type ReplayBoundaryNormalizedResponse,
  ReplayBoundaryNormalizedResponseSchema,
  type TargetReleaseReference,
} from "@proofstack/contracts";
import { ReplaySimulationBoundaryError } from "./errors.js";

type SimulationDeclaration = Extract<
  ReturnType<typeof ReplayBoundaryDeclarationSchema.parse>,
  { readonly mode: "simulation" }
>;

export interface ReplaySimulatorRegistryQuery {
  readonly configurationSha256: string;
  readonly qualification: SimulationDeclaration["qualification"];
  readonly simulatorRelease: TargetReleaseReference;
}

export interface ReplaySimulatorInvocation {
  readonly configurationSha256: string;
  readonly request: ReplayBoundaryExecutionRequest;
  readonly seedHex: string;
  readonly signal: AbortSignal;
}

export interface ReplaySimulatorOutcome {
  readonly response: ReplayBoundaryNormalizedResponse;
  readonly usage: ReplayBoundaryExecutionUsage;
}

export interface ResolvedReplaySimulator extends ReplaySimulatorRegistryQuery {
  simulate(input: ReplaySimulatorInvocation): Promise<unknown>;
}

export interface ReplaySimulatorRegistry {
  resolve(
    query: ReplaySimulatorRegistryQuery,
    signal: AbortSignal,
  ): Promise<ResolvedReplaySimulator | null>;
}

export interface ExecuteSimulationBoundaryOptions {
  readonly declaration: unknown;
  readonly registry: ReplaySimulatorRegistry;
  readonly request: unknown;
  readonly signal?: AbortSignal;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cancelled(signal: AbortSignal): never {
  throw new ReplaySimulationBoundaryError("cancelled", { cause: signal.reason });
}

function parseDeclaration(input: unknown): SimulationDeclaration {
  const parsed = ReplayBoundaryDeclarationSchema.safeParse(input);
  if (!parsed.success || parsed.data.mode !== "simulation") {
    throw new ReplaySimulationBoundaryError("invalid_declaration", {
      ...(parsed.success ? {} : { cause: parsed.error }),
    });
  }
  return parsed.data;
}

function parseRequest(input: unknown): ReplayBoundaryExecutionRequest {
  const parsed = ReplayBoundaryExecutionRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReplaySimulationBoundaryError("invalid_request", { cause: parsed.error });
  }
  return Object.freeze({
    ...parsed.data,
    normalizedRequest: Object.freeze({
      ...parsed.data.normalizedRequest,
      adapter: Object.freeze({ ...parsed.data.normalizedRequest.adapter }),
    }),
  });
}

function registryQuery(declaration: SimulationDeclaration): ReplaySimulatorRegistryQuery {
  return Object.freeze({
    configurationSha256: declaration.configurationSha256,
    qualification: Object.freeze({ ...declaration.qualification }),
    simulatorRelease: Object.freeze({
      ...declaration.simulatorRelease,
      targetAdapter: Object.freeze({ ...declaration.simulatorRelease.targetAdapter }),
      workerProtocol: Object.freeze({ ...declaration.simulatorRelease.workerProtocol }),
    }),
  });
}

function exactSimulator(
  resolved: ResolvedReplaySimulator,
  query: ReplaySimulatorRegistryQuery,
): boolean {
  return (
    typeof resolved?.simulate === "function" &&
    resolved.configurationSha256 === query.configurationSha256 &&
    sameJson(resolved.qualification, query.qualification) &&
    sameJson(resolved.simulatorRelease, query.simulatorRelease)
  );
}

function parseOutcome(
  input: unknown,
  request: ReplayBoundaryExecutionRequest,
): ReplaySimulatorOutcome {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("Simulator outcome is not an object");
    }
    const candidate = input as { readonly response: unknown; readonly usage: unknown };
    if (
      Object.keys(candidate).length !== 2 ||
      !("response" in candidate) ||
      !("usage" in candidate)
    ) {
      throw new TypeError("Simulator outcome has an unexpected shape");
    }
    const response = ReplayBoundaryNormalizedResponseSchema.parse(candidate.response);
    const usage = ReplayBoundaryExecutionUsageSchema.parse(candidate.usage);
    const responseBytes = Buffer.from(response.bytes, "base64url");
    if (
      !sameJson(response.adapter, request.normalizedRequest.adapter) ||
      responseBytes.byteLength !== response.sizeBytes ||
      createHash("sha256").update(responseBytes).digest("hex") !==
        response.normalizedResponseSha256 ||
      usage.some(
        ({ usage: measurement }) =>
          measurement.status === "observed" && measurement.source === "provider_reported",
      )
    ) {
      throw new TypeError("Simulator outcome evidence is inconsistent");
    }
    return Object.freeze({ response, usage });
  } catch (error) {
    /* v8 ignore next -- Every constituent contract was parsed before this defensive projection. */
    throw new ReplaySimulationBoundaryError("invalid_simulator_result", { cause: error });
  }
}

function actualRequest(request: ReplayBoundaryExecutionRequest) {
  const bytes = Buffer.from(request.normalizedRequest.bytes, "base64url");
  return Object.freeze({
    adapter: request.normalizedRequest.adapter,
    boundaryRequestId: request.boundaryRequestId,
    kind: request.kind,
    normalizedRequestSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  });
}

/** Executes one exact deterministic simulator without any recorded or live fallback. */
export async function executeSimulationBoundary(
  options: ExecuteSimulationBoundaryOptions,
): Promise<ReplayBoundaryExecutionResult> {
  const declaration = parseDeclaration(options.declaration);
  const request = parseRequest(options.request);
  if (request.kind !== declaration.kind) {
    throw new ReplaySimulationBoundaryError("request_kind_mismatch");
  }
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) cancelled(signal);
  const query = registryQuery(declaration);
  let resolved: ResolvedReplaySimulator | null;
  try {
    resolved = await options.registry.resolve(query, signal);
  } catch (error) {
    throw new ReplaySimulationBoundaryError("simulator_unavailable", { cause: error });
  }
  if (signal.aborted) cancelled(signal);
  if (resolved === null) {
    throw new ReplaySimulationBoundaryError("simulator_unavailable");
  }
  if (!exactSimulator(resolved, query)) {
    throw new ReplaySimulationBoundaryError("simulator_identity_mismatch");
  }
  let candidate: unknown;
  try {
    candidate = await resolved.simulate({
      configurationSha256: declaration.configurationSha256,
      request,
      seedHex: declaration.seedHex,
      signal,
    });
  } catch (error) {
    if (signal.aborted) cancelled(signal);
    throw new ReplaySimulationBoundaryError("simulator_failed", { cause: error });
  }
  if (signal.aborted) cancelled(signal);
  const outcome = parseOutcome(candidate, request);
  return Object.freeze(
    ReplayBoundaryExecutionResultSchema.parse({
      actualRequest: actualRequest(request),
      boundaryId: declaration.boundaryId,
      declaration,
      effectCertainty: "none",
      executionOrigin: "simulated",
      mode: "simulation",
      output: { kind: "normalized_response", response: outcome.response },
      schemaVersion: "0.1",
      usage: outcome.usage,
    }),
  );
}
