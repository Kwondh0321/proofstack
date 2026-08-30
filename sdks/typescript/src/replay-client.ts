import {
  ApiKeyValueSchema,
  type CreateReplayJobRequest,
  CreateReplayJobRequestSchema,
  type CreateReplayJobResponse,
  CreateReplayJobResponseSchema,
  OpaqueIdSchema,
  ProblemDocumentSchema,
  type PublishReplayPlanResponse,
  PublishReplayPlanResponseSchema,
  type PublishTargetReleaseResponse,
  PublishTargetReleaseResponseSchema,
  type ReadReplayJobResponse,
  ReadReplayJobResponseSchema,
  type ReadReplayPlanResponse,
  ReadReplayPlanResponseSchema,
  type ReadTargetReleaseResponse,
  ReadTargetReleaseResponseSchema,
  type ReplayJobSnapshot,
  type ReplayPlan,
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  type RequestReplayCancellation,
  type RequestReplayCancellationResponse,
  RequestReplayCancellationResponseSchema,
  RequestReplayCancellationSchema,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseDefinitionSchema,
} from "@proofstack/contracts";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "./replay-definition-digest.js";

export const MAX_REPLAY_CONTROL_RESPONSE_BYTES = 1024 * 1024;
export const MAX_REPLAY_CONTROL_REDIRECTS = 0;

const BROWSER_CSRF_TOKEN_PATTERN = /^psc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

interface ResponseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { readonly data: Output; readonly success: true }
    | { readonly error: unknown; readonly success: false };
}

export type ProofStackReplayAuthentication =
  | {
      readonly csrfToken: string;
      readonly mode: "browser";
    }
  | {
      readonly mode: "development";
    }
  | {
      readonly apiKey: string;
      readonly mode: "workload";
    };

export interface ProofStackReplayClientOptions {
  readonly authentication: ProofStackReplayAuthentication;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

export interface PublishTargetReleaseInput {
  readonly definition: TargetReleaseDefinition;
}

export interface ReadTargetReleaseInput {
  readonly targetId: string;
  readonly targetReleaseId: string;
}

export interface PublishReplayPlanInput {
  readonly definition: ReplayPlanDefinition;
}

export interface ReadReplayPlanInput {
  readonly planId: string;
  readonly planVersionId: string;
}

export interface CreateReplayJobInput {
  readonly jobId: string;
  readonly request: CreateReplayJobRequest;
}

export interface ReadReplayJobInput {
  readonly jobId: string;
}

export interface RequestReplayCancellationInput {
  readonly jobId: string;
  readonly request: RequestReplayCancellation;
}

function validatedIdentifier(value: unknown, name: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (!parsed.success) throw new ProofStackApiError(`${name} failed local validation`);
  return parsed.data;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

function validatedEndpoint(endpoint: string | URL): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (cause) {
    throw new ProofStackApiError("ProofStack endpoint must be an absolute URL", undefined, {
      cause,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProofStackApiError("ProofStack endpoint must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new ProofStackApiError("ProofStack endpoint must not contain embedded credentials");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new ProofStackApiError(
      "Unencrypted ProofStack endpoints must use an explicit loopback host",
    );
  }
  url.search = "";
  url.hash = "";
  return url;
}

function validatedAuthentication(
  authentication: ProofStackReplayAuthentication,
): ProofStackReplayAuthentication {
  if (authentication.mode === "development") return { mode: "development" };
  if (authentication.mode === "browser") {
    if (!BROWSER_CSRF_TOKEN_PATTERN.test(authentication.csrfToken)) {
      throw new ProofStackApiError("Browser CSRF token failed local validation");
    }
    return { csrfToken: authentication.csrfToken, mode: "browser" };
  }
  if (authentication.mode === "workload") {
    const apiKey = ApiKeyValueSchema.safeParse(authentication.apiKey);
    if (!apiKey.success) throw new ProofStackApiError("Workload API key failed local validation");
    return { apiKey: apiKey.data, mode: "workload" };
  }
  throw new ProofStackApiError("ProofStack replay authentication mode is invalid");
}

function scopedUrl(baseUrl: URL, pathSegments: readonly string[]): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/${pathSegments.map(encodeURIComponent).join("/")}`;
  return url;
}

function hasJsonMediaType(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json";
}

function hasNoStore(response: Response): boolean {
  return (
    response.headers
      .get("cache-control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store") ?? false
  );
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProofStackApiError("ProofStack API returned invalid JSON", status, { cause });
  }
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel();
      throw new ProofStackApiError(
        `ProofStack replay response exceeded ${maxBytes} bytes`,
        response.status,
      );
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new ProofStackApiError(
          `ProofStack replay response exceeded ${maxBytes} bytes`,
          response.status,
        );
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function targetDefinitionFromRelease(release: TargetRelease): TargetReleaseDefinition {
  const { createdAt: _, createdByPrincipalId: __, definitionSha256: ___, ...definition } = release;
  return TargetReleaseDefinitionSchema.parse(definition);
}

function planDefinitionFromPlan(plan: ReplayPlan): ReplayPlanDefinition {
  const { createdAt: _, createdByPrincipalId: __, definitionSha256: ___, ...definition } = plan;
  return ReplayPlanDefinitionSchema.parse(definition);
}

/**
 * Strict fail-closed client for the durable replay control plane.
 *
 * The client performs no automatic mutation retry, follows zero redirects, bounds every response,
 * parses strict public contracts before use, and independently verifies immutable definition
 * digests. It only exposes exact IDs and never asks the API for mutable aliases or plaintext worker
 * inputs.
 */
export class ProofStackReplayClient {
  private readonly authentication: ProofStackReplayAuthentication;
  private readonly baseUrl: URL;
  private readonly environmentId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly maxResponseBytes: number;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: ProofStackReplayClientOptions) {
    this.baseUrl = validatedEndpoint(options.endpoint);
    this.authentication = validatedAuthentication(options.authentication);
    if (this.authentication.mode === "development" && !isLoopbackHostname(this.baseUrl.hostname)) {
      throw new ProofStackApiError(
        "Development authentication requires an explicit loopback endpoint",
      );
    }
    this.environmentId = validatedIdentifier(options.environmentId, "environmentId");
    this.projectId = validatedIdentifier(options.projectId, "projectId");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!this.fetchImplementation)
      throw new ProofStackApiError("No fetch implementation is available");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ProofStackApiError("timeoutMs must be a positive integer");
    }
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_REPLAY_CONTROL_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0 ||
      this.maxResponseBytes > MAX_REPLAY_CONTROL_RESPONSE_BYTES
    ) {
      throw new ProofStackApiError(
        `maxResponseBytes must be a positive integer no greater than ${MAX_REPLAY_CONTROL_RESPONSE_BYTES}`,
      );
    }
  }

  async publishTargetRelease(
    input: PublishTargetReleaseInput,
  ): Promise<PublishTargetReleaseResponse> {
    this.requireManagementAuthority();
    const definition = TargetReleaseDefinitionSchema.safeParse(input.definition);
    if (!definition.success) {
      throw new ProofStackApiError("Target-release publication failed local validation");
    }
    this.assertRequestedScope(definition.data.scope, "target-release publication input");
    const result = await this.request<PublishTargetReleaseResponse>(
      ["replay-targets", definition.data.targetId, "releases", definition.data.targetReleaseId],
      "POST",
      definition.data,
      PublishTargetReleaseResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(result.value.created, result.status, "target-release publication");
    await this.verifyTargetRelease(
      result.value.release,
      definition.data.targetId,
      definition.data.targetReleaseId,
      "target-release publication",
      await digestTargetReleaseDefinition(definition.data),
    );
    return result.value;
  }

  async readTargetRelease(input: ReadTargetReleaseInput): Promise<ReadTargetReleaseResponse> {
    const targetId = validatedIdentifier(input.targetId, "targetId");
    const targetReleaseId = validatedIdentifier(input.targetReleaseId, "targetReleaseId");
    const result = (
      await this.request<ReadTargetReleaseResponse>(
        ["replay-targets", targetId, "releases", targetReleaseId],
        "GET",
        undefined,
        ReadTargetReleaseResponseSchema,
        [200],
      )
    ).value;
    await this.verifyTargetRelease(
      result.release,
      targetId,
      targetReleaseId,
      "target-release read",
    );
    return result;
  }

  async publishReplayPlan(input: PublishReplayPlanInput): Promise<PublishReplayPlanResponse> {
    this.requireManagementAuthority();
    const definition = ReplayPlanDefinitionSchema.safeParse(input.definition);
    if (!definition.success) {
      throw new ProofStackApiError("Replay-plan publication failed local validation");
    }
    this.assertRequestedScope(definition.data.scope, "replay-plan publication input");
    const result = await this.request<PublishReplayPlanResponse>(
      ["replay-plans", definition.data.planId, "versions", definition.data.planVersionId],
      "POST",
      definition.data,
      PublishReplayPlanResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(result.value.created, result.status, "replay-plan publication");
    await this.verifyReplayPlan(
      result.value.plan,
      definition.data.planId,
      definition.data.planVersionId,
      "replay-plan publication",
      await digestReplayPlanDefinition(definition.data),
    );
    return result.value;
  }

  async readReplayPlan(input: ReadReplayPlanInput): Promise<ReadReplayPlanResponse> {
    const planId = validatedIdentifier(input.planId, "planId");
    const planVersionId = validatedIdentifier(input.planVersionId, "planVersionId");
    const result = (
      await this.request<ReadReplayPlanResponse>(
        ["replay-plans", planId, "versions", planVersionId],
        "GET",
        undefined,
        ReadReplayPlanResponseSchema,
        [200],
      )
    ).value;
    await this.verifyReplayPlan(result.plan, planId, planVersionId, "replay-plan read");
    return result;
  }

  async createReplayJob(input: CreateReplayJobInput): Promise<CreateReplayJobResponse> {
    const jobId = validatedIdentifier(input.jobId, "jobId");
    const request = CreateReplayJobRequestSchema.safeParse(input.request);
    if (!request.success || request.data.jobId !== jobId) {
      throw new ProofStackApiError("Replay-job creation failed local validation");
    }
    const result = await this.request<CreateReplayJobResponse>(
      ["replay-jobs", jobId],
      "POST",
      request.data,
      CreateReplayJobResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(result.value.created, result.status, "replay-job creation");
    this.verifySnapshot(result.value.snapshot, jobId, "replay-job creation", request.data.plan);
    return result.value;
  }

  async readReplayJob(input: ReadReplayJobInput): Promise<ReadReplayJobResponse> {
    const jobId = validatedIdentifier(input.jobId, "jobId");
    const result = (
      await this.request<ReadReplayJobResponse>(
        ["replay-jobs", jobId],
        "GET",
        undefined,
        ReadReplayJobResponseSchema,
        [200],
      )
    ).value;
    this.verifySnapshot(result.snapshot, jobId, "replay-job read");
    return result;
  }

  async requestReplayCancellation(
    input: RequestReplayCancellationInput,
  ): Promise<RequestReplayCancellationResponse> {
    const jobId = validatedIdentifier(input.jobId, "jobId");
    const request = RequestReplayCancellationSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Replay cancellation failed local validation");
    }
    const result = await this.request<RequestReplayCancellationResponse>(
      ["replay-jobs", jobId, "cancellation-requests", request.data.cancellationId],
      "POST",
      request.data,
      RequestReplayCancellationResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(result.value.created, result.status, "replay cancellation");
    this.verifySnapshot(result.value.snapshot, jobId, "replay cancellation");
    const committed = result.value.snapshot.cancellationRequest;
    if (result.value.created && !committed) {
      throw new ProofStackApiError(
        "ProofStack API reported a created replay cancellation without a durable request",
      );
    }
    if (
      committed &&
      (committed.cancellationId !== request.data.cancellationId ||
        committed.reason !== request.data.reason ||
        committed.reasonCode !== request.data.reasonCode)
    ) {
      throw new ProofStackApiError(
        "ProofStack API returned a replay cancellation that contradicts the request",
      );
    }
    return result.value;
  }

  private requireManagementAuthority(): void {
    if (this.authentication.mode === "workload") {
      throw new ProofStackApiError(
        "Replay definition publication requires user management authority and is not workload-delegable",
      );
    }
  }

  private assertRequestedScope(
    scope: { readonly environmentId: string; readonly projectId: string },
    operation: string,
  ): void {
    if (scope.projectId !== this.projectId || scope.environmentId !== this.environmentId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} scope that contradicts the requested resource`,
      );
    }
  }

  private async verifyTargetRelease(
    release: TargetRelease,
    targetId: string,
    targetReleaseId: string,
    operation: string,
    expectedDigest?: string,
  ): Promise<void> {
    this.assertRequestedScope(release.scope, operation);
    if (release.targetId !== targetId || release.targetReleaseId !== targetReleaseId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} identity that contradicts the requested resource`,
      );
    }
    const actualDigest = await digestTargetReleaseDefinition(targetDefinitionFromRelease(release));
    if (
      actualDigest !== release.definitionSha256 ||
      (expectedDigest && actualDigest !== expectedDigest)
    ) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} with an invalid public definition digest`,
      );
    }
  }

  private async verifyReplayPlan(
    plan: ReplayPlan,
    planId: string,
    planVersionId: string,
    operation: string,
    expectedDigest?: string,
  ): Promise<void> {
    this.assertRequestedScope(plan.scope, operation);
    if (plan.planId !== planId || plan.planVersionId !== planVersionId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} identity that contradicts the requested resource`,
      );
    }
    const actualDigest = await digestReplayPlanDefinition(planDefinitionFromPlan(plan));
    if (
      actualDigest !== plan.definitionSha256 ||
      (expectedDigest && actualDigest !== expectedDigest)
    ) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} with an invalid public definition digest`,
      );
    }
  }

  private verifySnapshot(
    snapshot: ReplayJobSnapshot,
    jobId: string,
    operation: string,
    expectedPlan?: CreateReplayJobRequest["plan"],
  ): void {
    this.assertRequestedScope(snapshot.job.scope, operation);
    if (snapshot.job.jobId !== jobId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} identity that contradicts the requested resource`,
      );
    }
    if (
      expectedPlan &&
      (snapshot.job.plan.planId !== expectedPlan.planId ||
        snapshot.job.plan.planVersionId !== expectedPlan.planVersionId ||
        snapshot.job.plan.definitionSha256 !== expectedPlan.definitionSha256)
    ) {
      throw new ProofStackApiError(
        "ProofStack API returned a replay job pinned to a plan that contradicts the creation request",
      );
    }
  }

  private assertCreatedStatus(created: boolean, status: number, operation: string): void {
    if ((created && status !== 201) || (!created && status !== 200)) {
      throw new ProofStackApiError(
        `ProofStack API returned an inconsistent ${operation} status`,
        status,
      );
    }
  }

  private throwRejectedResponse(response: Response, responseText: string): never {
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      throw new ProofStackApiError(
        `ProofStack API rejected the request with HTTP ${response.status}`,
        response.status,
      );
    }
    const problem = ProblemDocumentSchema.safeParse(responseBody);
    if (problem.success && problem.data.status === response.status) {
      throw new ProofStackProblemError(problem.data);
    }
    throw new ProofStackApiError(
      `ProofStack API rejected the request with HTTP ${response.status}`,
      response.status,
    );
  }

  private async request<Output>(
    resourcePath: readonly string[],
    method: "GET" | "POST",
    body: unknown,
    responseSchema: ResponseSchema<Output>,
    expectedStatuses: readonly number[],
  ): Promise<{ readonly status: number; readonly value: Output }> {
    const url = scopedUrl(this.baseUrl, [
      "v1",
      "projects",
      this.projectId,
      "environments",
      this.environmentId,
      ...resourcePath,
    ]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: this.authentication.mode === "browser" ? "include" : "omit",
        headers: {
          accept: "application/json",
          ...(this.authentication.mode === "workload"
            ? { authorization: `Bearer ${this.authentication.apiKey}` }
            : {}),
          ...(this.authentication.mode === "browser" && method === "POST"
            ? { "x-proofstack-csrf": this.authentication.csrfToken }
            : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
        redirect: "manual",
        signal: controller.signal,
      });
      if (
        response.redirected ||
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel();
        throw new ProofStackApiError(
          `ProofStack replay requests permit ${MAX_REPLAY_CONTROL_REDIRECTS} redirects`,
          response.status || undefined,
        );
      }
      const responseText = await readBoundedResponseBody(response, this.maxResponseBytes);
      if (!response.ok) this.throwRejectedResponse(response, responseText);
      if (!expectedStatuses.includes(response.status)) {
        throw new ProofStackApiError(
          `ProofStack API returned unexpected HTTP ${response.status}`,
          response.status,
        );
      }
      if (!hasJsonMediaType(response)) {
        throw new ProofStackApiError(
          "ProofStack API returned an unexpected media type",
          response.status,
        );
      }
      if (!hasNoStore(response)) {
        throw new ProofStackApiError(
          "ProofStack replay response omitted the required no-store cache boundary",
          response.status,
        );
      }
      const parsed = responseSchema.safeParse(parseJson(responseText, response.status));
      if (!parsed.success) {
        throw new ProofStackApiError(
          "ProofStack API returned a response that violates the published replay contract",
          response.status,
          { cause: parsed.error },
        );
      }
      return { status: response.status, value: parsed.data };
    } catch (cause) {
      if (cause instanceof ProofStackApiError) throw cause;
      if (controller.signal.aborted) {
        throw new ProofStackApiError(
          `ProofStack replay request timed out after ${this.timeoutMs}ms`,
          undefined,
          { cause },
        );
      }
      throw new ProofStackApiError("ProofStack replay request failed", undefined, { cause });
    } finally {
      clearTimeout(timeout);
    }
  }
}
