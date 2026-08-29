import {
  ApiKeyValueSchema,
  OpaqueIdSchema,
  type ProblemDocument,
  ProblemDocumentSchema,
  type PublishRegressionDatasetVersionRequest,
  PublishRegressionDatasetVersionRequestSchema,
  type PublishRegressionDatasetVersionResponse,
  PublishRegressionDatasetVersionResponseSchema,
  type PublishRegressionFixtureVersionRequest,
  PublishRegressionFixtureVersionRequestSchema,
  type PublishRegressionFixtureVersionResponse,
  PublishRegressionFixtureVersionResponseSchema,
  type ReadRegressionDatasetVersionResponse,
  ReadRegressionDatasetVersionResponseSchema,
  type ReadRegressionFixtureVersionResponse,
  ReadRegressionFixtureVersionResponseSchema,
} from "@proofstack/contracts";

const MAX_CONTROL_PLANE_RESPONSE_BYTES = 1024 * 1024;

interface ResponseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { readonly data: Output; readonly success: true }
    | { readonly error: unknown; readonly success: false };
}

export interface ProofStackRegressionClientOptions {
  readonly apiKey?: string;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

export interface PublishRegressionFixtureVersionInput {
  readonly fixtureId: string;
  readonly request: PublishRegressionFixtureVersionRequest;
}

export interface ReadRegressionFixtureVersionInput {
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
}

export interface PublishRegressionDatasetVersionInput {
  readonly datasetId: string;
  readonly request: PublishRegressionDatasetVersionRequest;
}

export interface ReadRegressionDatasetVersionInput {
  readonly datasetId: string;
  readonly datasetVersionId: string;
}

export class ProofStackApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProofStackApiError";
  }
}

export class ProofStackProblemError extends ProofStackApiError {
  readonly code: string;
  readonly detail: string;
  readonly problemType: string;
  readonly requestId: string;
  readonly title: string;

  constructor(problem: ProblemDocument) {
    super(`ProofStack API rejected the request with ${problem.code}`, problem.status);
    this.name = "ProofStackProblemError";
    this.code = problem.code;
    this.detail = problem.detail;
    this.problemType = problem.type;
    this.requestId = problem.requestId;
    this.title = problem.title;
  }
}

function validatedIdentifier(value: unknown, name: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (!parsed.success) throw new ProofStackApiError(`${name} failed local validation`);
  return parsed.data;
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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
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

async function readBoundedResponseBody(response: Response): Promise<string> {
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
      if (receivedBytes > MAX_CONTROL_PLANE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProofStackApiError(
          `ProofStack API response exceeded ${MAX_CONTROL_PLANE_RESPONSE_BYTES} bytes`,
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

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProofStackApiError("ProofStack API returned invalid JSON", status, { cause });
  }
}

/**
 * Fail-closed client for immutable regression control-plane operations.
 *
 * Publication calls are never retried automatically. Callers may safely retry the same immutable
 * definition and inspect the returned `created` marker.
 */
export class ProofStackRegressionClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: URL;
  private readonly environmentId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: ProofStackRegressionClientOptions) {
    this.baseUrl = validatedEndpoint(options.endpoint);
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
    if (options.apiKey !== undefined) {
      const apiKey = ApiKeyValueSchema.safeParse(options.apiKey);
      if (!apiKey.success) throw new ProofStackApiError("apiKey failed local validation");
      this.apiKey = apiKey.data;
    }
  }

  async publishFixtureVersion(
    input: PublishRegressionFixtureVersionInput,
  ): Promise<PublishRegressionFixtureVersionResponse> {
    const fixtureId = validatedIdentifier(input.fixtureId, "fixtureId");
    const request = PublishRegressionFixtureVersionRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Regression fixture publication failed local validation");
    }
    const result = await this.request<PublishRegressionFixtureVersionResponse>(
      ["regression-fixtures", fixtureId, "versions"],
      "POST",
      request.data,
      PublishRegressionFixtureVersionResponseSchema,
      [200, 201],
    );
    this.assertPublicationStatus(result.value.created, result.status);
    return result.value;
  }

  async readFixtureVersion(
    input: ReadRegressionFixtureVersionInput,
  ): Promise<ReadRegressionFixtureVersionResponse> {
    const fixtureId = validatedIdentifier(input.fixtureId, "fixtureId");
    const fixtureVersionId = validatedIdentifier(input.fixtureVersionId, "fixtureVersionId");
    return (
      await this.request<ReadRegressionFixtureVersionResponse>(
        ["regression-fixtures", fixtureId, "versions", fixtureVersionId],
        "GET",
        undefined,
        ReadRegressionFixtureVersionResponseSchema,
        [200],
      )
    ).value;
  }

  async publishDatasetVersion(
    input: PublishRegressionDatasetVersionInput,
  ): Promise<PublishRegressionDatasetVersionResponse> {
    const datasetId = validatedIdentifier(input.datasetId, "datasetId");
    const request = PublishRegressionDatasetVersionRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Regression dataset publication failed local validation");
    }
    const result = await this.request<PublishRegressionDatasetVersionResponse>(
      ["regression-datasets", datasetId, "versions"],
      "POST",
      request.data,
      PublishRegressionDatasetVersionResponseSchema,
      [200, 201],
    );
    this.assertPublicationStatus(result.value.created, result.status);
    return result.value;
  }

  async readDatasetVersion(
    input: ReadRegressionDatasetVersionInput,
  ): Promise<ReadRegressionDatasetVersionResponse> {
    const datasetId = validatedIdentifier(input.datasetId, "datasetId");
    const datasetVersionId = validatedIdentifier(input.datasetVersionId, "datasetVersionId");
    return (
      await this.request<ReadRegressionDatasetVersionResponse>(
        ["regression-datasets", datasetId, "versions", datasetVersionId],
        "GET",
        undefined,
        ReadRegressionDatasetVersionResponseSchema,
        [200],
      )
    ).value;
  }

  private assertPublicationStatus(created: boolean, status: number): void {
    if ((created && status !== 201) || (!created && status !== 200)) {
      throw new ProofStackApiError(
        "ProofStack API returned an inconsistent regression publication status",
        status,
      );
    }
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
        headers: {
          accept: "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
        signal: controller.signal,
      });
      const responseText = await readBoundedResponseBody(response);
      if (!response.ok) {
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
      const responseBody = parseJson(responseText, response.status);
      const parsed = responseSchema.safeParse(responseBody);
      if (!parsed.success) {
        throw new ProofStackApiError(
          "ProofStack API returned a response that violates the published contract",
          response.status,
          { cause: parsed.error },
        );
      }
      return { status: response.status, value: parsed.data };
    } catch (cause) {
      if (cause instanceof ProofStackApiError) throw cause;
      if (controller.signal.aborted) {
        throw new ProofStackApiError(
          `ProofStack API request timed out after ${this.timeoutMs}ms`,
          undefined,
          { cause },
        );
      }
      throw new ProofStackApiError("ProofStack API request failed", undefined, { cause });
    } finally {
      clearTimeout(timeout);
    }
  }
}
