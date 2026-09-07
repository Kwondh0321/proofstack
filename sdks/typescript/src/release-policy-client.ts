import {
  ApiKeyValueSchema,
  type EvidenceScope,
  MAX_RELEASE_POLICY_REQUEST_BYTES,
  MAX_RELEASE_POLICY_RESPONSE_BYTES,
  OpaqueIdSchema,
  ProblemDocumentSchema,
  type PublishReleasePolicyLifecycleRequest,
  PublishReleasePolicyLifecycleRequestSchema,
  type PublishReleasePolicyLifecycleResponse,
  PublishReleasePolicyLifecycleResponseSchema,
  type PublishReleasePolicyRequest,
  PublishReleasePolicyRequestSchema,
  type PublishReleasePolicyResponse,
  PublishReleasePolicyResponseSchema,
  type ReadReleasePolicyLifecycleResponse,
  ReadReleasePolicyLifecycleResponseSchema,
  type ReadReleasePolicyResponse,
  ReadReleasePolicyResponseSchema,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  type ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";
import { digestReleasePolicyDefinition } from "./release-policy-definition-digest.js";

export {
  MAX_RELEASE_POLICY_REQUEST_BYTES,
  MAX_RELEASE_POLICY_RESPONSE_BYTES,
} from "@proofstack/contracts";
export const MAX_RELEASE_POLICY_REDIRECTS = 0;

const BROWSER_CSRF_TOKEN_PATTERN = /^psc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

interface ResponseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { readonly data: Output; readonly success: true }
    | { readonly error: unknown; readonly success: false };
}

export type ProofStackReleasePolicyAuthentication =
  | { readonly csrfToken: string; readonly mode: "browser" }
  | { readonly mode: "development" }
  | { readonly apiKey: string; readonly mode: "workload" };

export interface ProofStackReleasePolicyClientOptions {
  readonly authentication: ProofStackReleasePolicyAuthentication;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

export interface PublishReleasePolicyInput {
  readonly policyId: string;
  readonly request: PublishReleasePolicyRequest;
}

export interface ReadReleasePolicyInput {
  readonly policyId: string;
  readonly policyVersionId: string;
}

export interface PublishReleasePolicyLifecycleInput extends ReadReleasePolicyInput {
  readonly request: PublishReleasePolicyLifecycleRequest;
}

export interface ReadReleasePolicyLifecycleInput extends ReadReleasePolicyInput {
  readonly eventId: string;
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
  authentication: ProofStackReleasePolicyAuthentication,
): ProofStackReleasePolicyAuthentication {
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
  throw new ProofStackApiError("ProofStack release policy authentication mode is invalid");
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
        `ProofStack release policy response exceeded ${maxBytes} bytes`,
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
          `ProofStack release policy response exceeded ${maxBytes} bytes`,
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

function definitionFromPolicy(policy: ReleasePolicy): ReleasePolicyDefinition {
  const definition = structuredClone(policy) as unknown as Record<string, unknown>;
  for (const key of [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ]) {
    delete definition[key];
  }
  return definition as unknown as ReleasePolicyDefinition;
}

/**
 * Strict exact-version client for immutable release policy authoring and lifecycle records.
 *
 * Mutations are never retried automatically and cannot use workload credentials. Every response
 * is bounded, non-cacheable, redirect-free, schema-validated, and route-bound. Policy definitions
 * are independently digest-verified. This client does not evaluate a candidate, approve a release,
 * select a mutable policy alias, or execute a deployment.
 */
export class ProofStackReleasePolicyClient {
  private readonly authentication: ProofStackReleasePolicyAuthentication;
  private readonly baseUrl: URL;
  private readonly environmentId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly maxResponseBytes: number;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: ProofStackReleasePolicyClientOptions) {
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
    if (!this.fetchImplementation) {
      throw new ProofStackApiError("No fetch implementation is available");
    }
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ProofStackApiError("timeoutMs must be a positive integer");
    }
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RELEASE_POLICY_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0 ||
      this.maxResponseBytes > MAX_RELEASE_POLICY_RESPONSE_BYTES
    ) {
      throw new ProofStackApiError(
        `maxResponseBytes must be a positive integer no greater than ${MAX_RELEASE_POLICY_RESPONSE_BYTES}`,
      );
    }
  }

  async publishPolicy(input: PublishReleasePolicyInput): Promise<PublishReleasePolicyResponse> {
    this.requireAuthorAuthority();
    const policyId = validatedIdentifier(input.policyId, "policyId");
    const request = PublishReleasePolicyRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Release policy publication failed local validation");
    }
    const response = await this.request<PublishReleasePolicyResponse>(
      ["release-policies", policyId, "versions", request.data.policyVersionId],
      "POST",
      request.data,
      PublishReleasePolicyResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(response.value.created, response.status, "policy publication");
    await this.verifyPolicy(
      response.value.policy,
      policyId,
      request.data.policyVersionId,
      "publication",
    );
    await this.assertRequestedPolicySemantics(response.value.policy, policyId, request.data);
    return response.value;
  }

  async readPolicy(input: ReadReleasePolicyInput): Promise<ReadReleasePolicyResponse> {
    const policyId = validatedIdentifier(input.policyId, "policyId");
    const policyVersionId = validatedIdentifier(input.policyVersionId, "policyVersionId");
    const response = (
      await this.request<ReadReleasePolicyResponse>(
        ["release-policies", policyId, "versions", policyVersionId],
        "GET",
        undefined,
        ReadReleasePolicyResponseSchema,
        [200],
      )
    ).value;
    await this.verifyPolicy(response.policy, policyId, policyVersionId, "read");
    return response;
  }

  async publishLifecycleEvent(
    input: PublishReleasePolicyLifecycleInput,
  ): Promise<PublishReleasePolicyLifecycleResponse> {
    this.requireAuthorAuthority();
    const policyId = validatedIdentifier(input.policyId, "policyId");
    const policyVersionId = validatedIdentifier(input.policyVersionId, "policyVersionId");
    const request = PublishReleasePolicyLifecycleRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Release policy lifecycle publication failed local validation");
    }
    const response = await this.request<PublishReleasePolicyLifecycleResponse>(
      ["release-policies", policyId, "versions", policyVersionId, "lifecycle-events"],
      "POST",
      request.data,
      PublishReleasePolicyLifecycleResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(response.value.created, response.status, "lifecycle publication");
    this.verifyLifecycleEvent(
      response.value.event,
      policyId,
      policyVersionId,
      request.data.eventId,
      "publication",
    );
    this.assertRequestedLifecycleSemantics(response.value.event, request.data);
    return response.value;
  }

  async readLifecycleEvent(
    input: ReadReleasePolicyLifecycleInput,
  ): Promise<ReadReleasePolicyLifecycleResponse> {
    const policyId = validatedIdentifier(input.policyId, "policyId");
    const policyVersionId = validatedIdentifier(input.policyVersionId, "policyVersionId");
    const eventId = validatedIdentifier(input.eventId, "eventId");
    const response = (
      await this.request<ReadReleasePolicyLifecycleResponse>(
        ["release-policies", policyId, "versions", policyVersionId, "lifecycle-events", eventId],
        "GET",
        undefined,
        ReadReleasePolicyLifecycleResponseSchema,
        [200],
      )
    ).value;
    this.verifyLifecycleEvent(response.event, policyId, policyVersionId, eventId, "read");
    return response;
  }

  private requireAuthorAuthority(): void {
    if (this.authentication.mode === "workload") {
      throw new ProofStackApiError(
        "Release policy authoring requires user authority and is not workload-delegable",
      );
    }
  }

  private async verifyPolicy(
    policy: ReleasePolicy,
    policyId: string,
    policyVersionId: string,
    operation: string,
  ): Promise<void> {
    if (policy.policyId !== policyId || policy.policyVersionId !== policyVersionId) {
      throw new ProofStackApiError(
        `ProofStack API returned a release policy ${operation} identity that contradicts the requested resource`,
      );
    }
    this.assertRequestedScope(policy.scope, `policy ${operation}`);
    const actualDigest = await digestReleasePolicyDefinition(
      policy.scope,
      definitionFromPolicy(policy),
    );
    if (actualDigest !== policy.definitionSha256) {
      throw new ProofStackApiError(
        `ProofStack API returned a release policy ${operation} with an invalid public definition digest`,
      );
    }
  }

  private async assertRequestedPolicySemantics(
    policy: ReleasePolicy,
    policyId: string,
    request: PublishReleasePolicyRequest,
  ): Promise<void> {
    const { policyVersionId, predecessorVersionId, ...requestDefinition } = request;
    const predecessor = policy.predecessor;
    if (
      (predecessorVersionId === undefined && predecessor !== undefined) ||
      (predecessorVersionId !== undefined &&
        (predecessor === undefined ||
          predecessor.policyId !== policyId ||
          predecessor.policyVersionId !== predecessorVersionId))
    ) {
      throw new ProofStackApiError(
        "ProofStack API returned release policy lineage that contradicts the request",
      );
    }
    const expectedDefinition: ReleasePolicyDefinition = {
      ...requestDefinition,
      issuerPrincipalId: policy.issuerPrincipalId,
      policyId,
      policyVersionId,
      ...(predecessor ? { predecessor } : {}),
    };
    const expectedDigest = await digestReleasePolicyDefinition(policy.scope, expectedDefinition);
    if (expectedDigest !== policy.definitionSha256) {
      throw new ProofStackApiError(
        "ProofStack API returned release policy semantics that contradict the request",
      );
    }
  }

  private verifyLifecycleEvent(
    event: ReleasePolicyLifecycleEvent,
    policyId: string,
    policyVersionId: string,
    eventId: string,
    operation: string,
  ): void {
    if (
      event.eventId !== eventId ||
      event.policy.policyId !== policyId ||
      event.policy.policyVersionId !== policyVersionId
    ) {
      throw new ProofStackApiError(
        `ProofStack API returned a release policy lifecycle ${operation} identity that contradicts the requested resource`,
      );
    }
    this.assertRequestedScope(event.scope, `lifecycle ${operation}`);
  }

  private assertRequestedLifecycleSemantics(
    event: ReleasePolicyLifecycleEvent,
    request: PublishReleasePolicyLifecycleRequest,
  ): void {
    if (event.kind !== request.kind || event.reason !== request.reason) {
      throw new ProofStackApiError(
        "ProofStack API returned release policy lifecycle semantics that contradict the request",
      );
    }
    if (
      request.kind === "superseded" &&
      (event.kind !== "superseded" ||
        event.successor.policyId !== event.policy.policyId ||
        event.successor.policyVersionId !== request.successorPolicyVersionId)
    ) {
      throw new ProofStackApiError(
        "ProofStack API returned release policy successor lineage that contradicts the request",
      );
    }
  }

  private assertRequestedScope(scope: EvidenceScope, operation: string): void {
    if (scope.projectId !== this.projectId || scope.environmentId !== this.environmentId) {
      throw new ProofStackApiError(
        `ProofStack API returned a release policy ${operation} scope that contradicts the requested resource`,
      );
    }
  }

  private assertCreatedStatus(created: boolean, status: number, operation: string): void {
    if ((created && status !== 201) || (!created && status !== 200)) {
      throw new ProofStackApiError(
        `ProofStack API returned an inconsistent release policy ${operation} status`,
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
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    if (
      encodedBody !== undefined &&
      new TextEncoder().encode(encodedBody).byteLength > MAX_RELEASE_POLICY_REQUEST_BYTES
    ) {
      throw new ProofStackApiError(
        `ProofStack release policy request exceeded ${MAX_RELEASE_POLICY_REQUEST_BYTES} bytes`,
      );
    }
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
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
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
          `ProofStack release policy requests permit ${MAX_RELEASE_POLICY_REDIRECTS} redirects`,
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
          "ProofStack release policy response omitted the required no-store cache boundary",
          response.status,
        );
      }
      const parsed = responseSchema.safeParse(parseJson(responseText, response.status));
      if (!parsed.success) {
        throw new ProofStackApiError(
          "ProofStack API returned a response that violates the published release policy contract",
          response.status,
          { cause: parsed.error },
        );
      }
      return { status: response.status, value: parsed.data };
    } catch (cause) {
      if (cause instanceof ProofStackApiError) throw cause;
      if (controller.signal.aborted) {
        throw new ProofStackApiError(
          `ProofStack release policy request timed out after ${this.timeoutMs}ms`,
          undefined,
          { cause },
        );
      }
      throw new ProofStackApiError("ProofStack release policy request failed", undefined, {
        cause,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
