import {
  ApiKeyValueSchema,
  type CreateModelAssuranceAssessmentRequest,
  CreateModelAssuranceAssessmentRequestSchema,
  type EvidenceScope,
  type ModelAssuranceRecordEnvelope,
  type ModelAssuranceRecordKind,
  ModelAssuranceRecordKindSchema,
  OpaqueIdSchema,
  ProblemDocumentSchema,
  type PublishModelAssuranceDefinitionRequest,
  PublishModelAssuranceDefinitionRequestSchema,
  type PublishModelAssuranceRecordResponse,
  PublishModelAssuranceRecordResponseSchema,
  type ReadModelAssuranceRecordResponse,
  ReadModelAssuranceRecordResponseSchema,
  type RecordHumanReviewRequest,
  RecordHumanReviewRequestSchema,
  type RecordModelAssuranceExecutionRequest,
  RecordModelAssuranceExecutionRequestSchema,
} from "@proofstack/contracts";
import { digestModelAssuranceDefinition } from "./model-assurance-definition-digest.js";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";

export const MAX_MODEL_ASSURANCE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_MODEL_ASSURANCE_REDIRECTS = 0;

const BROWSER_CSRF_TOKEN_PATTERN = /^psc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

interface ResponseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { readonly data: Output; readonly success: true }
    | { readonly error: unknown; readonly success: false };
}

export type ProofStackModelAssuranceAuthentication =
  | { readonly csrfToken: string; readonly mode: "browser" }
  | { readonly mode: "development" }
  | { readonly apiKey: string; readonly mode: "workload" };

export interface ProofStackModelAssuranceClientOptions {
  readonly authentication: ProofStackModelAssuranceAuthentication;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

export interface PublishModelAssuranceDefinitionInput {
  readonly recordId: string;
  readonly request: PublishModelAssuranceDefinitionRequest;
}

export interface RecordModelAssuranceExecutionInput {
  readonly recordId: string;
  readonly request: RecordModelAssuranceExecutionRequest;
}

export interface RecordModelAssuranceHumanReviewInput {
  readonly recordId: string;
  readonly request: RecordHumanReviewRequest;
}

export interface CreateModelAssuranceAssessmentInput {
  readonly recordId: string;
  readonly request: CreateModelAssuranceAssessmentRequest;
}

export interface ReadModelAssuranceRecordInput {
  readonly kind: ModelAssuranceRecordKind;
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
  authentication: ProofStackModelAssuranceAuthentication,
): ProofStackModelAssuranceAuthentication {
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
  throw new ProofStackApiError("ProofStack model-assurance authentication mode is invalid");
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
        `ProofStack model-assurance response exceeded ${maxBytes} bytes`,
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
          `ProofStack model-assurance response exceeded ${maxBytes} bytes`,
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

function receiptKeys(kind: ModelAssuranceRecordKind): readonly string[] {
  switch (kind) {
    case "blinded_evaluation_plan":
    case "human_review_protocol":
    case "model_assisted_evaluator":
    case "model_evaluator_profile":
    case "model_qualification_suite":
      return [...commonReceiptKeys, "publishedAt", "publishedByPrincipalId"];
    case "blinded_evaluation_result":
    case "independent_critique":
      return [...commonReceiptKeys, "recordedAt", "recordedByPrincipalId"];
    case "calibration_report":
    case "human_review_record":
    case "human_reviewer_independence":
    case "independence_declaration":
    case "model_assurance_assessment":
    case "model_qualification_report":
      return [...commonReceiptKeys, "recordedAt"];
  }
}

function recordId(kind: ModelAssuranceRecordKind, record: Record<string, unknown>): unknown {
  const idFields: Record<ModelAssuranceRecordKind, string> = {
    blinded_evaluation_plan: "blindedPlanVersionId",
    blinded_evaluation_result: "resultId",
    calibration_report: "calibrationReportId",
    human_review_protocol: "protocolVersionId",
    human_review_record: "reviewId",
    human_reviewer_independence: "declarationId",
    independence_declaration: "independenceDeclarationId",
    independent_critique: "critiqueId",
    model_assisted_evaluator: "evaluatorVersionId",
    model_assurance_assessment: "assessmentExtensionId",
    model_evaluator_profile: "modelProfileVersionId",
    model_qualification_report: "reportId",
    model_qualification_suite: "suiteVersionId",
  };
  return record[idFields[kind]];
}

function definitionFromRecord(
  kind: ModelAssuranceRecordKind,
  record: ModelAssuranceRecordEnvelope["record"],
): Record<string, unknown> {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of receiptKeys(kind)) Reflect.deleteProperty(definition, key);
  return definition;
}

/** Strict exact-version client for model and human evaluation evidence. */
export class ProofStackModelAssuranceClient {
  private readonly authentication: ProofStackModelAssuranceAuthentication;
  private readonly baseUrl: URL;
  private readonly environmentId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly maxResponseBytes: number;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: ProofStackModelAssuranceClientOptions) {
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
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_MODEL_ASSURANCE_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0 ||
      this.maxResponseBytes > MAX_MODEL_ASSURANCE_RESPONSE_BYTES
    ) {
      throw new ProofStackApiError(
        `maxResponseBytes must be a positive integer no greater than ${MAX_MODEL_ASSURANCE_RESPONSE_BYTES}`,
      );
    }
  }

  async publishDefinition(
    input: PublishModelAssuranceDefinitionInput,
  ): Promise<PublishModelAssuranceRecordResponse> {
    this.requireUserAuthority("Model-assurance definition publication");
    return this.mutate(
      "definitions",
      input.recordId,
      input.request,
      PublishModelAssuranceDefinitionRequestSchema,
      "model-assurance definition publication",
      true,
    );
  }

  async recordExecution(
    input: RecordModelAssuranceExecutionInput,
  ): Promise<PublishModelAssuranceRecordResponse> {
    if (this.authentication.mode === "browser") {
      throw new ProofStackApiError("Model-assurance execution requires workload authority");
    }
    return this.mutate(
      "executions",
      input.recordId,
      input.request,
      RecordModelAssuranceExecutionRequestSchema,
      "model-assurance execution",
      true,
    );
  }

  async recordHumanReview(
    input: RecordModelAssuranceHumanReviewInput,
  ): Promise<PublishModelAssuranceRecordResponse> {
    this.requireUserAuthority("Human review publication");
    return this.mutate(
      "human-reviews",
      input.recordId,
      input.request,
      RecordHumanReviewRequestSchema,
      "human review publication",
      true,
    );
  }

  async createAssessment(
    input: CreateModelAssuranceAssessmentInput,
  ): Promise<PublishModelAssuranceRecordResponse> {
    this.requireUserAuthority("Model-assurance assessment creation");
    return this.mutate(
      "assessments",
      input.recordId,
      input.request,
      CreateModelAssuranceAssessmentRequestSchema,
      "model-assurance assessment creation",
      false,
    );
  }

  async readRecord(
    input: ReadModelAssuranceRecordInput,
  ): Promise<ReadModelAssuranceRecordResponse> {
    const kind = ModelAssuranceRecordKindSchema.safeParse(input.kind);
    if (!kind.success) throw new ProofStackApiError("kind failed local validation");
    const id = validatedIdentifier(input.recordId, "recordId");
    const response = (
      await this.request<ReadModelAssuranceRecordResponse>(
        ["model-assurance", "records", kind.data, id],
        "GET",
        undefined,
        ReadModelAssuranceRecordResponseSchema,
        [200],
      )
    ).value;
    await this.verifyResult(response.result, kind.data, id, "model-assurance record read");
    return response;
  }

  private async mutate<
    Request extends { readonly definition: unknown; readonly kind: ModelAssuranceRecordKind },
  >(
    segment: string,
    recordIdInput: string,
    requestInput: Request,
    requestSchema: ResponseSchema<Request>,
    operation: string,
    requestDefinesStoredRecord: boolean,
  ): Promise<PublishModelAssuranceRecordResponse> {
    const id = validatedIdentifier(recordIdInput, "recordId");
    const request = requestSchema.safeParse(requestInput);
    if (!request.success) throw new ProofStackApiError(`${operation} failed local validation`);
    const response = await this.request<PublishModelAssuranceRecordResponse>(
      ["model-assurance", segment, id],
      "POST",
      request.data,
      PublishModelAssuranceRecordResponseSchema,
      [200, 201],
    );
    this.assertCreatedStatus(response.value.created, response.status, operation);
    const expectedDigest = requestDefinesStoredRecord
      ? await digestModelAssuranceDefinition(
          request.data.kind,
          response.value.result.record.scope,
          request.data.definition,
        )
      : undefined;
    await this.verifyResult(
      response.value.result,
      request.data.kind,
      id,
      operation,
      expectedDigest,
    );
    return response.value;
  }

  private requireUserAuthority(operation: string): void {
    if (this.authentication.mode === "workload") {
      throw new ProofStackApiError(
        `${operation} requires user authority and is not workload-delegable`,
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
    result: ModelAssuranceRecordEnvelope,
    expectedKind: ModelAssuranceRecordKind,
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
    const actualDigest = await digestModelAssuranceDefinition(
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
          `ProofStack model-assurance requests permit ${MAX_MODEL_ASSURANCE_REDIRECTS} redirects`,
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
          "ProofStack model-assurance response omitted the required no-store cache boundary",
          response.status,
        );
      }
      const parsed = responseSchema.safeParse(parseJson(responseText, response.status));
      if (!parsed.success) {
        throw new ProofStackApiError(
          "ProofStack API returned a response that violates the published model-assurance contract",
          response.status,
          { cause: parsed.error },
        );
      }
      return { status: response.status, value: parsed.data };
    } catch (cause) {
      if (cause instanceof ProofStackApiError) throw cause;
      if (controller.signal.aborted) {
        throw new ProofStackApiError(
          `ProofStack model-assurance request timed out after ${this.timeoutMs}ms`,
          undefined,
          { cause },
        );
      }
      throw new ProofStackApiError("ProofStack model-assurance request failed", undefined, {
        cause,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
