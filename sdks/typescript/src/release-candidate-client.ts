import {
  ApiKeyValueSchema,
  type EvidenceScope,
  OpaqueIdSchema,
  ProblemDocumentSchema,
  type PublishReleaseCandidateRequest,
  PublishReleaseCandidateRequestSchema,
  type PublishReleaseCandidateResponse,
  PublishReleaseCandidateResponseSchema,
  type ReadReleaseCandidateResponse,
  ReadReleaseCandidateResponseSchema,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
} from "@proofstack/contracts";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";
import { digestReleaseCandidateDefinition } from "./release-candidate-definition-digest.js";

export const MAX_RELEASE_CANDIDATE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RELEASE_CANDIDATE_REDIRECTS = 0;

const BROWSER_CSRF_TOKEN_PATTERN = /^psc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

interface ResponseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { readonly data: Output; readonly success: true }
    | { readonly error: unknown; readonly success: false };
}

export type ProofStackReleaseCandidateAuthentication =
  | { readonly csrfToken: string; readonly mode: "browser" }
  | { readonly mode: "development" }
  | { readonly apiKey: string; readonly mode: "workload" };

export interface ProofStackReleaseCandidateClientOptions {
  readonly authentication: ProofStackReleaseCandidateAuthentication;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

export interface PublishReleaseCandidateInput {
  readonly candidateId: string;
  readonly request: PublishReleaseCandidateRequest;
}

export interface ReadReleaseCandidateInput {
  readonly candidateId: string;
  readonly candidateVersionId: string;
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
  authentication: ProofStackReleaseCandidateAuthentication,
): ProofStackReleaseCandidateAuthentication {
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
  throw new ProofStackApiError("ProofStack release candidate authentication mode is invalid");
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
        `ProofStack release candidate response exceeded ${maxBytes} bytes`,
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
          `ProofStack release candidate response exceeded ${maxBytes} bytes`,
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

function definitionFromCandidate(candidate: ReleaseCandidate): ReleaseCandidateDefinition {
  const definition = structuredClone(candidate) as unknown as Record<string, unknown>;
  for (const key of [
    "createdAt",
    "createdByPrincipalId",
    "definitionSha256",
    "schemaVersion",
    "scope",
  ]) {
    delete definition[key];
  }
  return definition as unknown as ReleaseCandidateDefinition;
}

/**
 * Strict exact-version client for immutable release candidate publication and reads.
 *
 * Mutations are never retried automatically and cannot use workload credentials. Every response
 * is bounded, non-cacheable, redirect-free, schema-validated, route-bound, and independently
 * digest-verified. This client exposes no policy, approval, credential, or deployment action.
 */
export class ProofStackReleaseCandidateClient {
  private readonly authentication: ProofStackReleaseCandidateAuthentication;
  private readonly baseUrl: URL;
  private readonly environmentId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly maxResponseBytes: number;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: ProofStackReleaseCandidateClientOptions) {
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
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RELEASE_CANDIDATE_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0 ||
      this.maxResponseBytes > MAX_RELEASE_CANDIDATE_RESPONSE_BYTES
    ) {
      throw new ProofStackApiError(
        `maxResponseBytes must be a positive integer no greater than ${MAX_RELEASE_CANDIDATE_RESPONSE_BYTES}`,
      );
    }
  }

  async publishCandidate(
    input: PublishReleaseCandidateInput,
  ): Promise<PublishReleaseCandidateResponse> {
    this.requireManagementAuthority();
    const candidateId = validatedIdentifier(input.candidateId, "candidateId");
    const request = PublishReleaseCandidateRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Release candidate publication failed local validation");
    }
    const response = await this.request<PublishReleaseCandidateResponse>(
      ["release-candidates", candidateId, "versions", request.data.candidateVersionId],
      "POST",
      request.data,
      PublishReleaseCandidateResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(response.value.created, response.status);
    await this.verifyCandidate(
      response.value.candidate,
      candidateId,
      request.data.candidateVersionId,
      "publication",
    );
    await this.assertRequestedSemantics(response.value.candidate, candidateId, request.data);
    return response.value;
  }

  async readCandidate(input: ReadReleaseCandidateInput): Promise<ReadReleaseCandidateResponse> {
    const candidateId = validatedIdentifier(input.candidateId, "candidateId");
    const candidateVersionId = validatedIdentifier(input.candidateVersionId, "candidateVersionId");
    const response = (
      await this.request<ReadReleaseCandidateResponse>(
        ["release-candidates", candidateId, "versions", candidateVersionId],
        "GET",
        undefined,
        ReadReleaseCandidateResponseSchema,
        [200],
      )
    ).value;
    await this.verifyCandidate(response.candidate, candidateId, candidateVersionId, "read");
    return response;
  }

  private requireManagementAuthority(): void {
    if (this.authentication.mode === "workload") {
      throw new ProofStackApiError(
        "Release candidate publication requires user management authority and is not workload-delegable",
      );
    }
  }

  private async verifyCandidate(
    candidate: ReleaseCandidate,
    candidateId: string,
    candidateVersionId: string,
    operation: string,
  ): Promise<void> {
    if (
      candidate.candidateId !== candidateId ||
      candidate.candidateVersionId !== candidateVersionId
    ) {
      throw new ProofStackApiError(
        `ProofStack API returned a release candidate ${operation} identity that contradicts the requested resource`,
      );
    }
    this.assertRequestedScope(candidate.scope, operation);
    const actualDigest = await digestReleaseCandidateDefinition(
      candidate.scope,
      definitionFromCandidate(candidate),
    );
    if (actualDigest !== candidate.definitionSha256) {
      throw new ProofStackApiError(
        `ProofStack API returned a release candidate ${operation} with an invalid public definition digest`,
      );
    }
  }

  private async assertRequestedSemantics(
    candidate: ReleaseCandidate,
    candidateId: string,
    request: PublishReleaseCandidateRequest,
  ): Promise<void> {
    const { predecessorVersionId, ...requestDefinition } = request;
    const predecessor = candidate.predecessor;
    if (
      (predecessorVersionId === undefined && predecessor !== undefined) ||
      (predecessorVersionId !== undefined &&
        (predecessor === undefined ||
          predecessor.candidateId !== candidateId ||
          predecessor.candidateVersionId !== predecessorVersionId))
    ) {
      throw new ProofStackApiError(
        "ProofStack API returned release candidate lineage that contradicts the request",
      );
    }
    const expectedDefinition: ReleaseCandidateDefinition = {
      ...requestDefinition,
      candidateId,
      ...(predecessor ? { predecessor } : {}),
    };
    const expectedDigest = await digestReleaseCandidateDefinition(
      candidate.scope,
      expectedDefinition,
    );
    if (expectedDigest !== candidate.definitionSha256) {
      throw new ProofStackApiError(
        "ProofStack API returned release candidate semantics that contradict the request",
      );
    }
  }

  private assertRequestedScope(scope: EvidenceScope, operation: string): void {
    if (scope.projectId !== this.projectId || scope.environmentId !== this.environmentId) {
      throw new ProofStackApiError(
        `ProofStack API returned a release candidate ${operation} scope that contradicts the requested resource`,
      );
    }
  }

  private assertCreatedStatus(created: boolean, status: number): void {
    if ((created && status !== 201) || (!created && status !== 200)) {
      throw new ProofStackApiError(
        "ProofStack API returned an inconsistent release candidate publication status",
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
          `ProofStack release candidate requests permit ${MAX_RELEASE_CANDIDATE_REDIRECTS} redirects`,
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
          "ProofStack release candidate response omitted the required no-store cache boundary",
          response.status,
        );
      }
      const parsed = responseSchema.safeParse(parseJson(responseText, response.status));
      if (!parsed.success) {
        throw new ProofStackApiError(
          "ProofStack API returned a response that violates the published release candidate contract",
          response.status,
          { cause: parsed.error },
        );
      }
      return { status: response.status, value: parsed.data };
    } catch (cause) {
      if (cause instanceof ProofStackApiError) throw cause;
      if (controller.signal.aborted) {
        throw new ProofStackApiError(
          `ProofStack release candidate request timed out after ${this.timeoutMs}ms`,
          undefined,
          { cause },
        );
      }
      throw new ProofStackApiError("ProofStack release candidate request failed", undefined, {
        cause,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
