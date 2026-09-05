import {
  ApiKeyValueSchema,
  type ComparisonRecordEnvelope,
  type ComparisonRecordKind,
  ComparisonRecordKindSchema,
  type CreateComparisonEvidenceSnapshotRequest,
  CreateComparisonEvidenceSnapshotRequestSchema,
  type DeriveComparisonResultRequest,
  DeriveComparisonResultRequestSchema,
  type EvidenceScope,
  OpaqueIdSchema,
  ProblemDocumentSchema,
  type PublishComparisonDefinitionRequest,
  PublishComparisonDefinitionRequestSchema,
  type PublishComparisonRecordResponse,
  PublishComparisonRecordResponseSchema,
  type ReadComparisonRecordResponse,
  ReadComparisonRecordResponseSchema,
} from "@proofstack/contracts";
import { digestComparisonDefinition } from "./comparison-definition-digest.js";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";

export const MAX_COMPARISON_CONTROL_RESPONSE_BYTES = 1024 * 1024;
export const MAX_COMPARISON_CONTROL_REDIRECTS = 0;

const BROWSER_CSRF_TOKEN_PATTERN = /^psc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

interface ResponseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { readonly data: Output; readonly success: true }
    | { readonly error: unknown; readonly success: false };
}

export type ProofStackComparisonAuthentication =
  | { readonly csrfToken: string; readonly mode: "browser" }
  | { readonly mode: "development" }
  | { readonly apiKey: string; readonly mode: "workload" };

export interface ProofStackComparisonClientOptions {
  readonly authentication: ProofStackComparisonAuthentication;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

export interface PublishComparisonDefinitionInput {
  readonly comparisonId: string;
  readonly request: PublishComparisonDefinitionRequest;
}

export interface CreateComparisonEvidenceSnapshotInput {
  readonly request: CreateComparisonEvidenceSnapshotRequest;
  readonly snapshotId: string;
}

export interface DeriveComparisonResultInput {
  readonly request: DeriveComparisonResultRequest;
  readonly resultId: string;
}

export interface ReadComparisonRecordInput {
  readonly kind: ComparisonRecordKind;
  readonly recordId: string;
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
  authentication: ProofStackComparisonAuthentication,
): ProofStackComparisonAuthentication {
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
  throw new ProofStackApiError("ProofStack comparison authentication mode is invalid");
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

function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel();
      throw new ProofStackApiError(
        `ProofStack comparison response exceeded ${maxBytes} bytes`,
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
          `ProofStack comparison response exceeded ${maxBytes} bytes`,
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

function recordId(kind: ComparisonRecordKind, record: Record<string, unknown>): unknown {
  switch (kind) {
    case "comparison_definition":
      return field(record, "comparisonVersionId");
    case "comparison_evidence_snapshot":
      return field(record, "snapshotId");
    case "comparison_result":
      return field(record, "resultId");
  }
}

function definitionFromRecord(record: ComparisonRecordEnvelope["record"]): Record<string, unknown> {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of [
    "createdAt",
    "createdByPrincipalId",
    "definitionSha256",
    "schemaVersion",
    "scope",
  ]) {
    delete definition[key];
  }
  return definition;
}

function sameComparisonReference(
  left: {
    readonly comparisonId: string;
    readonly comparisonVersionId: string;
    readonly definitionSha256: string;
  },
  right: {
    readonly comparisonId: string;
    readonly comparisonVersionId: string;
    readonly definitionSha256: string;
  },
): boolean {
  return (
    left.comparisonId === right.comparisonId &&
    left.comparisonVersionId === right.comparisonVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

/**
 * Strict exact-version client for policy-independent comparison control.
 *
 * It follows zero redirects, bounds and validates every response, requires no-store, checks route
 * identity and source bindings, and independently recomputes each returned definition digest.
 * Management mutations are deliberately unavailable to workload credentials.
 */
export class ProofStackComparisonClient {
  private readonly authentication: ProofStackComparisonAuthentication;
  private readonly baseUrl: URL;
  private readonly environmentId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly maxResponseBytes: number;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: ProofStackComparisonClientOptions) {
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
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_COMPARISON_CONTROL_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0 ||
      this.maxResponseBytes > MAX_COMPARISON_CONTROL_RESPONSE_BYTES
    ) {
      throw new ProofStackApiError(
        `maxResponseBytes must be a positive integer no greater than ${MAX_COMPARISON_CONTROL_RESPONSE_BYTES}`,
      );
    }
  }

  async publishDefinition(
    input: PublishComparisonDefinitionInput,
  ): Promise<PublishComparisonRecordResponse> {
    this.requireManagementAuthority("Comparison definition publication");
    const comparisonId = validatedIdentifier(input.comparisonId, "comparisonId");
    const request = PublishComparisonDefinitionRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Comparison definition publication failed local validation");
    }
    const response = await this.mutate(
      ["comparisons", comparisonId, "definitions", request.data.comparisonVersionId],
      request.data,
      "comparison_definition",
      request.data.comparisonVersionId,
      "comparison definition publication",
    );
    if (response.result.kind !== "comparison_definition") {
      throw new ProofStackApiError(
        "ProofStack API returned comparison definition lineage that contradicts the request",
      );
    }
    const returned = response.result.record;
    if (
      returned.comparisonId !== comparisonId ||
      returned.predecessor?.comparisonVersionId !== request.data.predecessorVersionId
    ) {
      throw new ProofStackApiError(
        "ProofStack API returned comparison definition lineage that contradicts the request",
      );
    }
    const { predecessorVersionId: _predecessorVersionId, ...requestDefinition } = request.data;
    const expectedDigest = await digestComparisonDefinition(
      "comparison_definition",
      returned.scope,
      {
        ...requestDefinition,
        comparisonId,
        ...(returned.predecessor ? { predecessor: returned.predecessor } : {}),
      },
    );
    if (expectedDigest !== returned.definitionSha256) {
      throw new ProofStackApiError(
        "ProofStack API returned comparison definition semantics that contradict the request",
      );
    }
    return response;
  }

  async createEvidenceSnapshot(
    input: CreateComparisonEvidenceSnapshotInput,
  ): Promise<PublishComparisonRecordResponse> {
    this.requireManagementAuthority("Comparison evidence snapshot creation");
    const snapshotId = validatedIdentifier(input.snapshotId, "snapshotId");
    const request = CreateComparisonEvidenceSnapshotRequestSchema.safeParse(input.request);
    if (!request.success || request.data.snapshotId !== snapshotId) {
      throw new ProofStackApiError("Comparison evidence snapshot creation failed local validation");
    }
    const response = await this.mutate(
      ["comparisons", "evidence-snapshots", snapshotId],
      request.data,
      "comparison_evidence_snapshot",
      snapshotId,
      "comparison evidence snapshot creation",
    );
    if (
      response.result.kind !== "comparison_evidence_snapshot" ||
      response.result.record.role !== request.data.role ||
      !sameComparisonReference(response.result.record.comparison, request.data.comparison)
    ) {
      throw new ProofStackApiError(
        "ProofStack API returned comparison evidence lineage that contradicts the request",
      );
    }
    return response;
  }

  async deriveResult(input: DeriveComparisonResultInput): Promise<PublishComparisonRecordResponse> {
    this.requireManagementAuthority("Comparison result derivation");
    const resultId = validatedIdentifier(input.resultId, "resultId");
    const request = DeriveComparisonResultRequestSchema.safeParse(input.request);
    if (!request.success || request.data.resultId !== resultId) {
      throw new ProofStackApiError("Comparison result derivation failed local validation");
    }
    const response = await this.mutate(
      ["comparisons", "results", resultId],
      request.data,
      "comparison_result",
      resultId,
      "comparison result derivation",
    );
    if (
      response.result.kind !== "comparison_result" ||
      !sameComparisonReference(response.result.record.comparison, request.data.comparison) ||
      response.result.record.baselineSnapshot.snapshotId !==
        request.data.baselineSnapshot.snapshotId ||
      response.result.record.baselineSnapshot.definitionSha256 !==
        request.data.baselineSnapshot.definitionSha256 ||
      response.result.record.candidateSnapshot.snapshotId !==
        request.data.candidateSnapshot.snapshotId ||
      response.result.record.candidateSnapshot.definitionSha256 !==
        request.data.candidateSnapshot.definitionSha256
    ) {
      throw new ProofStackApiError(
        "ProofStack API returned comparison result lineage that contradicts the request",
      );
    }
    return response;
  }

  async readRecord(input: ReadComparisonRecordInput): Promise<ReadComparisonRecordResponse> {
    const kind = ComparisonRecordKindSchema.safeParse(input.kind);
    if (!kind.success) throw new ProofStackApiError("kind failed local validation");
    const recordId = validatedIdentifier(input.recordId, "recordId");
    const response = (
      await this.request<ReadComparisonRecordResponse>(
        ["comparisons", "records", kind.data, recordId],
        "GET",
        undefined,
        ReadComparisonRecordResponseSchema,
        [200],
      )
    ).value;
    await this.verifyResult(response.result, kind.data, recordId, "comparison record read");
    return response;
  }

  private async mutate(
    path: readonly string[],
    body: unknown,
    expectedKind: ComparisonRecordKind,
    expectedId: string,
    operation: string,
  ): Promise<PublishComparisonRecordResponse> {
    const response = await this.request<PublishComparisonRecordResponse>(
      path,
      "POST",
      body,
      PublishComparisonRecordResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(response.value.created, response.status, operation);
    await this.verifyResult(response.value.result, expectedKind, expectedId, operation);
    return response.value;
  }

  private requireManagementAuthority(operation: string): void {
    if (this.authentication.mode === "workload") {
      throw new ProofStackApiError(
        `${operation} requires user management authority and is not workload-delegable`,
      );
    }
  }

  private async verifyResult(
    result: ComparisonRecordEnvelope,
    expectedKind: ComparisonRecordKind,
    expectedId: string,
    operation: string,
  ): Promise<void> {
    if (result.kind !== expectedKind) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} kind that contradicts the requested resource`,
      );
    }
    if (recordId(result.kind, result.record as unknown as Record<string, unknown>) !== expectedId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} identity that contradicts the requested resource`,
      );
    }
    this.assertRequestedScope(result.record.scope, operation);
    const actualDigest = await digestComparisonDefinition(
      result.kind,
      result.record.scope,
      definitionFromRecord(result.record),
    );
    if (actualDigest !== result.record.definitionSha256) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} with an invalid public definition digest`,
      );
    }
  }

  private assertRequestedScope(scope: EvidenceScope, operation: string): void {
    if (scope.projectId !== this.projectId || scope.environmentId !== this.environmentId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} scope that contradicts the requested resource`,
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
          `ProofStack comparison requests permit ${MAX_COMPARISON_CONTROL_REDIRECTS} redirects`,
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
          "ProofStack comparison response omitted the required no-store cache boundary",
          response.status,
        );
      }
      const parsed = responseSchema.safeParse(parseJson(responseText, response.status));
      if (!parsed.success) {
        throw new ProofStackApiError(
          "ProofStack API returned a response that violates the published comparison contract",
          response.status,
          { cause: parsed.error },
        );
      }
      return { status: response.status, value: parsed.data };
    } catch (cause) {
      if (cause instanceof ProofStackApiError) throw cause;
      if (controller.signal.aborted) {
        throw new ProofStackApiError(
          `ProofStack comparison request timed out after ${this.timeoutMs}ms`,
          undefined,
          { cause },
        );
      }
      throw new ProofStackApiError("ProofStack comparison request failed", undefined, { cause });
    } finally {
      clearTimeout(timeout);
    }
  }
}
