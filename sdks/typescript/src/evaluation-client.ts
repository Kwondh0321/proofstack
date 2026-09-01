import {
  ApiKeyValueSchema,
  type CreateAssessmentRequest,
  CreateAssessmentRequestSchema,
  type EvaluationRecordEnvelope,
  type EvaluationRecordKind,
  EvaluationRecordKindSchema,
  type EvidenceScope,
  OpaqueIdSchema,
  ProblemDocumentSchema,
  type PublishEvaluationDefinitionRequest,
  PublishEvaluationDefinitionRequestSchema,
  type PublishEvaluationRecordResponse,
  PublishEvaluationRecordResponseSchema,
  type ReadEvaluationRecordResponse,
  ReadEvaluationRecordResponseSchema,
  type RecordCriterionSetStatusRequest,
  RecordCriterionSetStatusRequestSchema,
  type RecordEvaluationRunDecisionRequest,
  RecordEvaluationRunDecisionRequestSchema,
} from "@proofstack/contracts";
import { digestEvaluationDefinition } from "./evaluation-definition-digest.js";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";

export const MAX_EVALUATION_CONTROL_RESPONSE_BYTES = 1024 * 1024;
export const MAX_EVALUATION_CONTROL_REDIRECTS = 0;

const BROWSER_CSRF_TOKEN_PATTERN = /^psc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

interface ResponseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { readonly data: Output; readonly success: true }
    | { readonly error: unknown; readonly success: false };
}

export type ProofStackEvaluationAuthentication =
  | { readonly csrfToken: string; readonly mode: "browser" }
  | { readonly mode: "development" }
  | { readonly apiKey: string; readonly mode: "workload" };

export interface ProofStackEvaluationClientOptions {
  readonly authentication: ProofStackEvaluationAuthentication;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

export interface PublishEvaluationDefinitionInput {
  readonly recordId: string;
  readonly request: PublishEvaluationDefinitionRequest;
}

export interface RecordCriterionSetStatusInput {
  readonly recordId: string;
  readonly request: RecordCriterionSetStatusRequest;
}

export interface RecordEvaluationRunDecisionInput {
  readonly recordId: string;
  readonly request: RecordEvaluationRunDecisionRequest;
}

export interface CreateEvaluationAssessmentInput {
  readonly recordId: string;
  readonly request: CreateAssessmentRequest;
}

export interface ReadEvaluationRecordInput {
  readonly kind: EvaluationRecordKind;
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
  authentication: ProofStackEvaluationAuthentication,
): ProofStackEvaluationAuthentication {
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
  throw new ProofStackApiError("ProofStack evaluation authentication mode is invalid");
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
        `ProofStack evaluation response exceeded ${maxBytes} bytes`,
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
          `ProofStack evaluation response exceeded ${maxBytes} bytes`,
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

const commonReceiptKeys = ["definitionSha256", "schemaVersion", "scope"] as const;

function receiptKeys(kind: EvaluationRecordKind): readonly string[] {
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      return [...commonReceiptKeys, "publishedAt", "publishedByPrincipalId"];
    case "assessment":
    case "evaluation_aggregate":
    case "evaluation_run":
      return [...commonReceiptKeys, "createdAt", "createdByPrincipalId"];
    case "criterion_set_status":
    case "discovery_record":
    case "evaluation_run_result":
      return [...commonReceiptKeys, "recordedAt", "recordedByPrincipalId"];
    case "evaluation_run_rejection":
      return [...commonReceiptKeys, "recordedAt", "requestedByPrincipalId"];
    case "qualification_report":
      return [...commonReceiptKeys, "executedByPrincipalId", "recordedAt"];
    case "raw_observation":
      return [...commonReceiptKeys, "recordedAt"];
    case "source_review":
      return [...commonReceiptKeys, "reviewedAt", "reviewedByPrincipalId", "reviewerRole"];
    case "source_snapshot":
      return [...commonReceiptKeys, "publishedByPrincipalId", "recordedAt"];
  }
}

function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function recordId(kind: EvaluationRecordKind, record: Record<string, unknown>): unknown {
  switch (kind) {
    case "aggregation_policy":
      return field(record, "policyVersionId");
    case "assessment":
      return field(record, "assessmentId");
    case "criterion_set":
      return field(record, "criterionSetVersionId");
    case "criterion_set_status":
      return field(record, "statusRecordId");
    case "discovery_record":
      return field(record, "discoveryId");
    case "evaluation_aggregate":
      return field(record, "aggregateId");
    case "evaluation_run":
      return field(record, "evaluationRunId");
    case "evaluation_run_rejection":
      return field(record, "rejectionId");
    case "evaluation_run_result":
      return field(record, "resultId");
    case "evaluator_spec":
      return field(record, "evaluatorVersionId");
    case "oracle_spec":
      return field(record, "oracleVersionId");
    case "qualification_fixture_set":
      return field(record, "fixtureSetVersionId");
    case "qualification_report":
      return field(record, "qualificationReportId");
    case "raw_observation":
      return field(record, "observationId");
    case "source_review":
      return field(record, "sourceReviewId");
    case "source_snapshot":
      return field(record, "sourceSnapshotId");
  }
}

function definitionFromRecord(
  kind: EvaluationRecordKind,
  record: EvaluationRecordEnvelope["record"],
): Record<string, unknown> {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of receiptKeys(kind)) delete definition[key];
  return definition;
}

/**
 * Strict exact-version client for the evaluation control plane.
 *
 * It never retries mutations automatically, follows zero redirects, bounds every response,
 * requires no-store, validates strict contracts, and independently recomputes every returned
 * immutable definition digest. Worker-owned result mutation surfaces are intentionally absent.
 */
export class ProofStackEvaluationClient {
  private readonly authentication: ProofStackEvaluationAuthentication;
  private readonly baseUrl: URL;
  private readonly environmentId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly maxResponseBytes: number;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: ProofStackEvaluationClientOptions) {
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
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_EVALUATION_CONTROL_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0 ||
      this.maxResponseBytes > MAX_EVALUATION_CONTROL_RESPONSE_BYTES
    ) {
      throw new ProofStackApiError(
        `maxResponseBytes must be a positive integer no greater than ${MAX_EVALUATION_CONTROL_RESPONSE_BYTES}`,
      );
    }
  }

  async publishDefinition(
    input: PublishEvaluationDefinitionInput,
  ): Promise<PublishEvaluationRecordResponse> {
    this.requireManagementAuthority("Evaluation definition publication");
    return this.mutate(
      "definitions",
      input.recordId,
      input.request,
      PublishEvaluationDefinitionRequestSchema,
      "evaluation definition publication",
    );
  }

  async recordCriterionSetStatus(
    input: RecordCriterionSetStatusInput,
  ): Promise<PublishEvaluationRecordResponse> {
    this.requireManagementAuthority("Criterion-set status publication");
    return this.mutate(
      "criterion-set-statuses",
      input.recordId,
      input.request,
      RecordCriterionSetStatusRequestSchema,
      "criterion-set status publication",
    );
  }

  async recordRunDecision(
    input: RecordEvaluationRunDecisionInput,
  ): Promise<PublishEvaluationRecordResponse> {
    return this.mutate(
      "run-decisions",
      input.recordId,
      input.request,
      RecordEvaluationRunDecisionRequestSchema,
      "evaluation run decision",
    );
  }

  async createAssessment(
    input: CreateEvaluationAssessmentInput,
  ): Promise<PublishEvaluationRecordResponse> {
    this.requireManagementAuthority("Evaluation assessment creation");
    return this.mutate(
      "assessments",
      input.recordId,
      input.request,
      CreateAssessmentRequestSchema,
      "evaluation assessment creation",
    );
  }

  async readRecord(input: ReadEvaluationRecordInput): Promise<ReadEvaluationRecordResponse> {
    const kind = EvaluationRecordKindSchema.safeParse(input.kind);
    if (!kind.success) throw new ProofStackApiError("kind failed local validation");
    const id = validatedIdentifier(input.recordId, "recordId");
    const response = (
      await this.request<ReadEvaluationRecordResponse>(
        ["evaluations", "records", kind.data, id],
        "GET",
        undefined,
        ReadEvaluationRecordResponseSchema,
        [200],
      )
    ).value;
    await this.verifyResult(response.result, kind.data, id, "evaluation record read");
    return response;
  }

  private async mutate<
    Request extends { readonly definition: unknown; readonly kind: EvaluationRecordKind },
  >(
    segment: string,
    recordIdInput: string,
    requestInput: Request,
    requestSchema: ResponseSchema<Request>,
    operation: string,
  ): Promise<PublishEvaluationRecordResponse> {
    const id = validatedIdentifier(recordIdInput, "recordId");
    const request = requestSchema.safeParse(requestInput);
    if (!request.success) {
      throw new ProofStackApiError(`${operation} failed local validation`);
    }
    const response = await this.request<PublishEvaluationRecordResponse>(
      ["evaluations", segment, id],
      "POST",
      request.data,
      PublishEvaluationRecordResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(response.value.created, response.status, operation);
    const scope = response.value.result.record.scope;
    const expectedDigest = await digestEvaluationDefinition(
      request.data.kind,
      scope,
      request.data.definition,
    );
    await this.verifyResult(
      response.value.result,
      request.data.kind,
      id,
      operation,
      expectedDigest,
    );
    return response.value;
  }

  private requireManagementAuthority(operation: string): void {
    if (this.authentication.mode === "workload") {
      throw new ProofStackApiError(
        `${operation} requires user management authority and is not workload-delegable`,
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

  private async verifyResult(
    result: EvaluationRecordEnvelope,
    expectedKind: EvaluationRecordKind,
    expectedId: string,
    operation: string,
    expectedDigest?: string,
  ): Promise<void> {
    if (result.kind !== expectedKind) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} kind that contradicts the requested resource`,
      );
    }
    const record = result.record as unknown as Record<string, unknown>;
    if (recordId(result.kind, record) !== expectedId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} identity that contradicts the requested resource`,
      );
    }
    this.assertRequestedScope(result.record.scope, operation);
    const actualDigest = await digestEvaluationDefinition(
      result.kind,
      result.record.scope,
      definitionFromRecord(result.kind, result.record),
    );
    if (
      actualDigest !== result.record.definitionSha256 ||
      (expectedDigest !== undefined && actualDigest !== expectedDigest)
    ) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} with an invalid public definition digest`,
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
          `ProofStack evaluation requests permit ${MAX_EVALUATION_CONTROL_REDIRECTS} redirects`,
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
          "ProofStack evaluation response omitted the required no-store cache boundary",
          response.status,
        );
      }
      const parsed = responseSchema.safeParse(parseJson(responseText, response.status));
      if (!parsed.success) {
        throw new ProofStackApiError(
          "ProofStack API returned a response that violates the published evaluation contract",
          response.status,
          { cause: parsed.error },
        );
      }
      return { status: response.status, value: parsed.data };
    } catch (cause) {
      if (cause instanceof ProofStackApiError) throw cause;
      if (controller.signal.aborted) {
        throw new ProofStackApiError(
          `ProofStack evaluation request timed out after ${this.timeoutMs}ms`,
          undefined,
          { cause },
        );
      }
      throw new ProofStackApiError("ProofStack evaluation request failed", undefined, { cause });
    } finally {
      clearTimeout(timeout);
    }
  }
}
