import { createHash } from "node:crypto";
import {
  type ReplayBoundaryDeclaration,
  ReplayBoundaryDeclarationSchema,
  type ReplayBoundaryExecutionRequest,
  ReplayBoundaryExecutionRequestSchema,
  type ReplayBoundaryExecutionResult,
  ReplayBoundaryExecutionResultSchema,
} from "@proofstack/contracts";
import { ReplayBoundaryDispatchError } from "./errors.js";
import {
  executeLiveProviderBoundary,
  type ReplayLiveProviderRegistry,
} from "./live-provider-boundary.js";
import { executeSimulationBoundary, type ReplaySimulatorRegistry } from "./simulation-boundary.js";

type RecordedDeclaration = Extract<ReplayBoundaryDeclaration, { readonly mode: "recorded_stub" }>;

export interface ReplayRecordedStubBoundaryInvocation {
  readonly declaration: RecordedDeclaration;
  readonly request: ReplayBoundaryExecutionRequest;
  readonly signal: AbortSignal;
}

export interface ReplayRecordedStubBoundaryExecutor {
  execute(input: ReplayRecordedStubBoundaryInvocation): Promise<unknown>;
}

export interface ReplayBoundaryExecutorPorts {
  readonly liveProvider?: ReplayLiveProviderRegistry;
  readonly recordedStub?: ReplayRecordedStubBoundaryExecutor;
  readonly simulation?: ReplaySimulatorRegistry;
}

export interface DispatchReplayBoundaryOptions {
  readonly declaration: unknown;
  readonly ports?: ReplayBoundaryExecutorPorts;
  readonly request: unknown;
  readonly scope?: unknown;
  readonly signal?: AbortSignal;
  readonly workerFence?: unknown;
}

function fail(code: ConstructorParameters<typeof ReplayBoundaryDispatchError>[0]): never {
  throw new ReplayBoundaryDispatchError(code);
}

function parseDeclaration(input: unknown): ReplayBoundaryDeclaration {
  const parsed = ReplayBoundaryDeclarationSchema.safeParse(input);
  if (!parsed.success) fail("invalid_declaration");
  return parsed.data;
}

function parseRequest(input: unknown): ReplayBoundaryExecutionRequest {
  const parsed = ReplayBoundaryExecutionRequestSchema.safeParse(input);
  if (!parsed.success) fail("invalid_request");
  return Object.freeze({
    ...parsed.data,
    normalizedRequest: Object.freeze({
      ...parsed.data.normalizedRequest,
      adapter: Object.freeze({ ...parsed.data.normalizedRequest.adapter }),
    }),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedActualRequest(request: ReplayBoundaryExecutionRequest) {
  const bytes = Buffer.from(request.normalizedRequest.bytes, "base64url");
  return {
    adapter: request.normalizedRequest.adapter,
    boundaryRequestId: request.boundaryRequestId,
    kind: request.kind,
    normalizedRequestSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function exactResult(
  candidate: unknown,
  declaration: ReplayBoundaryDeclaration,
  request: ReplayBoundaryExecutionRequest,
): ReplayBoundaryExecutionResult {
  const parsed = ReplayBoundaryExecutionResultSchema.safeParse(candidate);
  if (
    !parsed.success ||
    !sameJson(parsed.data.declaration, declaration) ||
    !sameJson(parsed.data.actualRequest, expectedActualRequest(request))
  ) {
    fail("result_mismatch");
  }
  return Object.freeze(parsed.data);
}

/** Dispatches one immutable boundary mode exactly once and never changes mode on failure. */
export async function dispatchReplayBoundary(
  options: DispatchReplayBoundaryOptions,
): Promise<ReplayBoundaryExecutionResult> {
  const declaration = parseDeclaration(options.declaration);
  const request = parseRequest(options.request);
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) fail("cancelled");

  let candidate: unknown;
  if (declaration.mode === "recorded_stub") {
    const executor = options.ports?.recordedStub;
    if (typeof executor?.execute !== "function") fail("selected_executor_unavailable");
    candidate = await executor.execute({ declaration, request, signal });
  } else if (declaration.mode === "simulation") {
    const registry = options.ports?.simulation;
    if (typeof registry?.resolve !== "function") fail("selected_executor_unavailable");
    candidate = await executeSimulationBoundary({ declaration, registry, request, signal });
  } else {
    const registry = options.ports?.liveProvider;
    if (typeof registry?.resolve !== "function") fail("selected_executor_unavailable");
    candidate = await executeLiveProviderBoundary({
      declaration,
      registry,
      request,
      scope: options.scope,
      signal,
      workerFence: options.workerFence,
    });
  }

  return exactResult(candidate, declaration, request);
}
