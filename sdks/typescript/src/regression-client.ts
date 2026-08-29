import {
  ApiKeyValueSchema,
  ArtifactMediaTypeSchema,
  type ArtifactRedactionSummary,
  type DataClassification,
  DataClassificationSchema,
  type ExportRecordedInteractionFixtureContentResponse,
  ExportRecordedInteractionFixtureContentRequestSchema,
  ExportRecordedInteractionFixtureContentResponseSchema,
  type ExportRecordedInteractionFixtureMetadataResponse,
  ExportRecordedInteractionFixtureMetadataResponseSchema,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_INTERACTION_CONTENT_EXPORT_BYTES,
  OpaqueIdSchema,
  type ProblemDocument,
  ProblemDocumentSchema,
  type PublishInteractionFixtureVersionRequest,
  PublishInteractionFixtureVersionRequestSchema,
  type PublishRecordedInteractionFixtureVersionResponse,
  PublishRecordedInteractionFixtureVersionResponseSchema,
  type PublishRegressionDatasetVersionRequest,
  PublishRegressionDatasetVersionRequestSchema,
  type PublishRegressionDatasetVersionResponse,
  PublishRegressionDatasetVersionResponseSchema,
  type PublishRegressionFixtureVersionRequest,
  PublishRegressionFixtureVersionRequestSchema,
  type PublishRegressionFixtureVersionResponse,
  PublishRegressionFixtureVersionResponseSchema,
  type PurgeArtifactResponse,
  PurgeArtifactResponseSchema,
  type ReadArtifactMetadataResponse,
  ReadArtifactMetadataResponseSchema,
  type ReadRecordedInteractionFixtureMetadataResponse,
  ReadRecordedInteractionFixtureMetadataResponseSchema,
  type ReadRegressionDatasetVersionResponse,
  ReadRegressionDatasetVersionResponseSchema,
  type ReadRegressionFixtureVersionResponse,
  ReadRegressionFixtureVersionResponseSchema,
  type ReserveArtifactRequest,
  ReserveArtifactRequestSchema,
  type ReserveArtifactResponse,
  ReserveArtifactResponseSchema,
  type RevokeInteractionFixtureContentRequest,
  RevokeInteractionFixtureContentRequestSchema,
  type RevokeRecordedInteractionFixtureContentResponse,
  RevokeRecordedInteractionFixtureContentResponseSchema,
  RequestIdSchema,
  Sha256Schema,
  type TombstoneArtifactRequest,
  TombstoneArtifactRequestSchema,
  type TombstoneArtifactResponse,
  TombstoneArtifactResponseSchema,
  type UploadArtifactResponse,
  UploadArtifactResponseSchema,
} from "@proofstack/contracts";

const MAX_CONTROL_PLANE_RESPONSE_BYTES = 1024 * 1024;
const MAX_INTERACTION_CONTENT_EXPORT_RESPONSE_BYTES =
  Math.ceil((MAX_INTERACTION_CONTENT_EXPORT_BYTES * 4) / 3) + MAX_CONTROL_PLANE_RESPONSE_BYTES;
const BROWSER_CSRF_TOKEN_PATTERN = /^psc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

interface ResponseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { readonly data: Output; readonly success: true }
    | { readonly error: unknown; readonly success: false };
}

const artifactRedactionStatusSchema: ResponseSchema<ArtifactRedactionSummary["status"]> = {
  safeParse(input) {
    return input === "applied" || input === "not_performed" || input === "not_required"
      ? { data: input, success: true }
      : { error: new Error("Invalid artifact redaction status"), success: false };
  },
};

export type ProofStackRegressionAuthentication =
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

export interface ProofStackRegressionClientOptions {
  readonly authentication: ProofStackRegressionAuthentication;
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

export interface ReserveArtifactInput {
  readonly request: ReserveArtifactRequest;
}

export interface ArtifactIdentifierInput {
  readonly artifactId: string;
}

export interface UploadArtifactContentInput extends ArtifactIdentifierInput {
  readonly content: Uint8Array;
}

export interface TombstoneArtifactInput extends ArtifactIdentifierInput {
  readonly request: TombstoneArtifactRequest;
}

export interface PublishRecordedInteractionFixtureVersionInput {
  readonly fixtureId: string;
  readonly request: PublishInteractionFixtureVersionRequest;
}

export interface ReadRecordedInteractionFixtureMetadataInput {
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
}

export interface ExportRecordedInteractionFixtureContentInput
  extends ReadRecordedInteractionFixtureMetadataInput {
  readonly acknowledgeSensitiveContent: true;
}

export interface RevokeRecordedInteractionFixtureContentInput
  extends ReadRecordedInteractionFixtureMetadataInput {
  readonly request: RevokeInteractionFixtureContentRequest;
}

export interface ArtifactContent {
  readonly classification: DataClassification;
  readonly content: Uint8Array;
  readonly mediaType: string;
  readonly redactionStatus: ArtifactRedactionSummary["status"];
  readonly requestId: string;
  readonly sha256: string;
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

function validatedAuthentication(
  authentication: ProofStackRegressionAuthentication,
): ProofStackRegressionAuthentication {
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
  throw new ProofStackApiError("ProofStack regression authentication mode is invalid");
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

async function readBoundedResponseBody(
  response: Response,
  maxBytes = MAX_CONTROL_PLANE_RESPONSE_BYTES,
): Promise<string> {
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
          `ProofStack API response exceeded ${maxBytes} bytes`,
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

async function readBoundedBinaryBody(response: Response): Promise<Uint8Array> {
  if (!response.body) {
    throw new ProofStackApiError("ProofStack API returned empty artifact content", response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_ARTIFACT_CONTENT_BYTES) {
        await reader.cancel();
        throw new ProofStackApiError(
          `ProofStack artifact content exceeded ${MAX_ARTIFACT_CONTENT_BYTES} bytes`,
          response.status,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (receivedBytes === 0) {
    throw new ProofStackApiError("ProofStack API returned empty artifact content", response.status);
  }
  const content = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function requiredResponseHeader<Output>(
  response: Response,
  name: string,
  schema: ResponseSchema<Output>,
): Output {
  const parsed = schema.safeParse(response.headers.get(name));
  if (!parsed.success) {
    throw new ProofStackApiError(
      `ProofStack artifact response header ${name} violates the published contract`,
      response.status,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function contentSha256(content: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ProofStackApiError("Web Crypto is required to verify artifact content integrity");
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", Uint8Array.from(content).buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProofStackApiError("ProofStack API returned invalid JSON", status, { cause });
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const decoder = globalThis.atob;
  if (!decoder) {
    throw new ProofStackApiError("A base64 decoder is required to verify interaction content");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  let decoded: string;
  try {
    decoded = decoder(padded);
  } catch (cause) {
    throw new ProofStackApiError(
      "ProofStack interaction content is not valid base64url",
      undefined,
      {
        cause,
      },
    );
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

/**
 * Fail-closed client for immutable regression control-plane operations.
 *
 * Publication calls are never retried automatically. Callers may safely retry the same immutable
 * definition and inspect the returned `created` marker. Browser mode includes credentials and the
 * required CSRF header, workload keys are restricted to exact reads, and development mode is
 * accepted only for explicit loopback endpoints.
 */
export class ProofStackRegressionClient {
  private readonly authentication: ProofStackRegressionAuthentication;
  private readonly baseUrl: URL;
  private readonly environmentId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: ProofStackRegressionClientOptions) {
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
    this.assertFixtureVersionIdentity(
      result.value.version,
      fixtureId,
      request.data.fixtureVersionId,
      "fixture publication",
    );
    return result.value;
  }

  async readFixtureVersion(
    input: ReadRegressionFixtureVersionInput,
  ): Promise<ReadRegressionFixtureVersionResponse> {
    const fixtureId = validatedIdentifier(input.fixtureId, "fixtureId");
    const fixtureVersionId = validatedIdentifier(input.fixtureVersionId, "fixtureVersionId");
    const result = (
      await this.request<ReadRegressionFixtureVersionResponse>(
        ["regression-fixtures", fixtureId, "versions", fixtureVersionId],
        "GET",
        undefined,
        ReadRegressionFixtureVersionResponseSchema,
        [200],
      )
    ).value;
    this.assertFixtureVersionIdentity(result.version, fixtureId, fixtureVersionId, "fixture read");
    return result;
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
    this.assertDatasetVersionIdentity(
      result.value.version,
      datasetId,
      request.data.datasetVersionId,
      "dataset publication",
    );
    return result.value;
  }

  async readDatasetVersion(
    input: ReadRegressionDatasetVersionInput,
  ): Promise<ReadRegressionDatasetVersionResponse> {
    const datasetId = validatedIdentifier(input.datasetId, "datasetId");
    const datasetVersionId = validatedIdentifier(input.datasetVersionId, "datasetVersionId");
    const result = (
      await this.request<ReadRegressionDatasetVersionResponse>(
        ["regression-datasets", datasetId, "versions", datasetVersionId],
        "GET",
        undefined,
        ReadRegressionDatasetVersionResponseSchema,
        [200],
      )
    ).value;
    this.assertDatasetVersionIdentity(result.version, datasetId, datasetVersionId, "dataset read");
    return result;
  }

  async reserveArtifact(input: ReserveArtifactInput): Promise<ReserveArtifactResponse> {
    const request = ReserveArtifactRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Artifact reservation failed local validation");
    }
    const result = await this.request<ReserveArtifactResponse>(
      ["artifacts"],
      "POST",
      request.data,
      ReserveArtifactResponseSchema,
      [200, 201],
      "write",
    );
    this.assertCreatedStatus(result.value.created, result.status, "artifact reservation");
    this.assertArtifactIdentity(
      result.value.metadata,
      request.data.artifactId,
      "artifact reservation",
    );
    return result.value;
  }

  async uploadArtifactContent(input: UploadArtifactContentInput): Promise<UploadArtifactResponse> {
    const artifactId = validatedIdentifier(input.artifactId, "artifactId");
    if (!(input.content instanceof Uint8Array) || input.content.byteLength === 0) {
      throw new ProofStackApiError("Artifact content must be a non-empty Uint8Array");
    }
    if (input.content.byteLength > MAX_ARTIFACT_CONTENT_BYTES) {
      throw new ProofStackApiError(`Artifact content exceeds ${MAX_ARTIFACT_CONTENT_BYTES} bytes`);
    }
    const result = (
      await this.request<UploadArtifactResponse>(
        ["artifacts", artifactId, "content"],
        "PUT",
        input.content,
        UploadArtifactResponseSchema,
        [200],
        "write",
      )
    ).value;
    this.assertArtifactIdentity(result.metadata, artifactId, "artifact upload");
    return result;
  }

  async readArtifactMetadata(
    input: ArtifactIdentifierInput,
  ): Promise<ReadArtifactMetadataResponse> {
    const artifactId = validatedIdentifier(input.artifactId, "artifactId");
    const result = (
      await this.request<ReadArtifactMetadataResponse>(
        ["artifacts", artifactId],
        "GET",
        undefined,
        ReadArtifactMetadataResponseSchema,
        [200],
        "read",
      )
    ).value;
    this.assertArtifactIdentity(result.metadata, artifactId, "artifact metadata read");
    if (result.ownership && result.ownership.artifactId !== artifactId) {
      throw new ProofStackApiError(
        "ProofStack API returned artifact ownership that contradicts the requested resource",
      );
    }
    return result;
  }

  async readArtifactContent(input: ArtifactIdentifierInput): Promise<ArtifactContent> {
    const artifactId = validatedIdentifier(input.artifactId, "artifactId");
    return this.requestArtifactContent(["artifacts", artifactId, "content"]);
  }

  async tombstoneArtifact(input: TombstoneArtifactInput): Promise<TombstoneArtifactResponse> {
    const artifactId = validatedIdentifier(input.artifactId, "artifactId");
    const request = TombstoneArtifactRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Artifact tombstone request failed local validation");
    }
    const result = await this.request<TombstoneArtifactResponse>(
      ["artifacts", artifactId],
      "DELETE",
      request.data,
      TombstoneArtifactResponseSchema,
      [200, 201],
      "manage",
    );
    this.assertCreatedStatus(result.value.created, result.status, "artifact tombstone");
    this.assertArtifactIdentity(result.value.metadata, artifactId, "artifact tombstone");
    if (result.value.tombstone.artifactId !== artifactId) {
      throw new ProofStackApiError(
        "ProofStack API returned an artifact tombstone that contradicts the requested resource",
      );
    }
    return result.value;
  }

  async purgeArtifact(input: ArtifactIdentifierInput): Promise<PurgeArtifactResponse> {
    const artifactId = validatedIdentifier(input.artifactId, "artifactId");
    const result = (
      await this.request<PurgeArtifactResponse>(
        ["artifacts", artifactId, "purge"],
        "POST",
        undefined,
        PurgeArtifactResponseSchema,
        [200],
        "manage",
      )
    ).value;
    this.assertArtifactIdentity(result.metadata, artifactId, "artifact purge");
    return result;
  }

  async publishRecordedInteractionFixtureVersion(
    input: PublishRecordedInteractionFixtureVersionInput,
  ): Promise<PublishRecordedInteractionFixtureVersionResponse> {
    const fixtureId = validatedIdentifier(input.fixtureId, "fixtureId");
    const request = PublishInteractionFixtureVersionRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError(
        "Recorded interaction fixture publication failed local validation",
      );
    }
    const result = await this.request<PublishRecordedInteractionFixtureVersionResponse>(
      ["regression-fixtures", fixtureId, "interaction-versions"],
      "POST",
      request.data,
      PublishRecordedInteractionFixtureVersionResponseSchema,
      [200, 201],
      "manage",
    );
    this.assertCreatedStatus(
      result.value.created,
      result.status,
      "recorded interaction publication",
    );
    this.assertFixtureVersionIdentity(
      result.value.version,
      fixtureId,
      request.data.fixtureVersionId,
      "recorded interaction publication",
    );
    return result.value;
  }

  async readRecordedInteractionFixtureMetadata(
    input: ReadRecordedInteractionFixtureMetadataInput,
  ): Promise<ReadRecordedInteractionFixtureMetadataResponse> {
    const fixtureId = validatedIdentifier(input.fixtureId, "fixtureId");
    const fixtureVersionId = validatedIdentifier(input.fixtureVersionId, "fixtureVersionId");
    const result = (
      await this.request<ReadRecordedInteractionFixtureMetadataResponse>(
        ["regression-fixtures", fixtureId, "interaction-versions", fixtureVersionId],
        "GET",
        undefined,
        ReadRecordedInteractionFixtureMetadataResponseSchema,
        [200],
        "read",
      )
    ).value;
    this.assertFixtureVersionIdentity(
      result.version,
      fixtureId,
      fixtureVersionId,
      "recorded interaction metadata read",
    );
    return result;
  }

  async exportRecordedInteractionFixtureMetadata(
    input: ReadRecordedInteractionFixtureMetadataInput,
  ): Promise<ExportRecordedInteractionFixtureMetadataResponse> {
    const fixtureId = validatedIdentifier(input.fixtureId, "fixtureId");
    const fixtureVersionId = validatedIdentifier(input.fixtureVersionId, "fixtureVersionId");
    const result = (
      await this.request<ExportRecordedInteractionFixtureMetadataResponse>(
        ["regression-fixtures", fixtureId, "interaction-versions", fixtureVersionId, "export"],
        "GET",
        undefined,
        ExportRecordedInteractionFixtureMetadataResponseSchema,
        [200],
        "read",
      )
    ).value;
    this.assertFixtureVersionIdentity(
      result.export.version,
      fixtureId,
      fixtureVersionId,
      "recorded interaction metadata export",
    );
    return result;
  }

  async exportRecordedInteractionFixtureContent(
    input: ExportRecordedInteractionFixtureContentInput,
  ): Promise<ExportRecordedInteractionFixtureContentResponse> {
    const fixtureId = validatedIdentifier(input.fixtureId, "fixtureId");
    const fixtureVersionId = validatedIdentifier(input.fixtureVersionId, "fixtureVersionId");
    const request = ExportRecordedInteractionFixtureContentRequestSchema.safeParse({
      acknowledgeSensitiveContent: input.acknowledgeSensitiveContent,
    });
    if (!request.success) {
      throw new ProofStackApiError(
        "Recorded interaction content export acknowledgement failed local validation",
      );
    }
    const result = (
      await this.request<ExportRecordedInteractionFixtureContentResponse>(
        [
          "regression-fixtures",
          fixtureId,
          "interaction-versions",
          fixtureVersionId,
          "export",
          "content",
        ],
        "POST",
        request.data,
        ExportRecordedInteractionFixtureContentResponseSchema,
        [200],
        "read",
        MAX_INTERACTION_CONTENT_EXPORT_RESPONSE_BYTES,
      )
    ).value;
    this.assertFixtureVersionIdentity(
      result.export.version,
      fixtureId,
      fixtureVersionId,
      "recorded interaction content export",
    );
    for (const item of result.export.artifacts) {
      if (item.content.status !== "available") continue;
      const actualSha256 = await contentSha256(decodeBase64Url(item.content.bytes));
      if (actualSha256 !== item.artifact.binding.contentReference.sha256) {
        throw new ProofStackApiError(
          "ProofStack interaction content digest does not match its artifact binding",
        );
      }
    }
    return result;
  }

  async revokeRecordedInteractionFixtureContent(
    input: RevokeRecordedInteractionFixtureContentInput,
  ): Promise<RevokeRecordedInteractionFixtureContentResponse> {
    const fixtureId = validatedIdentifier(input.fixtureId, "fixtureId");
    const fixtureVersionId = validatedIdentifier(input.fixtureVersionId, "fixtureVersionId");
    const request = RevokeInteractionFixtureContentRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ProofStackApiError("Interaction revocation failed local validation");
    }
    const result = await this.request<RevokeRecordedInteractionFixtureContentResponse>(
      ["regression-fixtures", fixtureId, "interaction-versions", fixtureVersionId, "revocation"],
      "POST",
      request.data,
      RevokeRecordedInteractionFixtureContentResponseSchema,
      [200, 201],
      "manage",
    );
    this.assertCreatedStatus(result.value.created, result.status, "interaction revocation");
    this.assertFixtureVersionIdentity(
      result.value.version,
      fixtureId,
      fixtureVersionId,
      "interaction revocation",
    );
    return result.value;
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

  private assertArtifactIdentity(
    metadata: {
      readonly contentReference: { readonly artifactId: string };
      readonly scope: { readonly environmentId: string; readonly projectId: string };
    },
    artifactId: string,
    operation: string,
  ): void {
    this.assertRequestedScope(metadata.scope, operation);
    if (metadata.contentReference.artifactId !== artifactId) {
      throw new ProofStackApiError(
        `ProofStack API returned an ${operation} identity that contradicts the requested resource`,
      );
    }
  }

  private assertFixtureVersionIdentity(
    version: {
      readonly fixtureId: string;
      readonly fixtureVersionId: string;
      readonly scope: { readonly environmentId: string; readonly projectId: string };
    },
    fixtureId: string,
    fixtureVersionId: string,
    operation: string,
  ): void {
    this.assertRequestedScope(version.scope, operation);
    if (version.fixtureId !== fixtureId || version.fixtureVersionId !== fixtureVersionId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} identity that contradicts the requested resource`,
      );
    }
  }

  private assertDatasetVersionIdentity(
    version: {
      readonly datasetId: string;
      readonly datasetVersionId: string;
      readonly scope: { readonly environmentId: string; readonly projectId: string };
    },
    datasetId: string,
    datasetVersionId: string,
    operation: string,
  ): void {
    this.assertRequestedScope(version.scope, operation);
    if (version.datasetId !== datasetId || version.datasetVersionId !== datasetVersionId) {
      throw new ProofStackApiError(
        `ProofStack API returned a ${operation} identity that contradicts the requested resource`,
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

  private assertPublicationStatus(created: boolean, status: number): void {
    if ((created && status !== 201) || (!created && status !== 200)) {
      throw new ProofStackApiError(
        "ProofStack API returned an inconsistent regression publication status",
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

  private async requestArtifactContent(resourcePath: readonly string[]): Promise<ArtifactContent> {
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
        credentials: this.authentication.mode === "browser" ? "include" : "omit",
        headers: {
          accept: "*/*",
          ...(this.authentication.mode === "workload"
            ? { authorization: `Bearer ${this.authentication.apiKey}` }
            : {}),
        },
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        const responseText = await readBoundedResponseBody(response);
        this.throwRejectedResponse(response, responseText);
      }
      if (response.status !== 200) {
        throw new ProofStackApiError(
          `ProofStack API returned unexpected HTTP ${response.status}`,
          response.status,
        );
      }
      const rawMediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      const mediaType = ArtifactMediaTypeSchema.safeParse(rawMediaType);
      if (!mediaType.success) {
        throw new ProofStackApiError(
          "ProofStack artifact response media type violates the published contract",
          response.status,
          { cause: mediaType.error },
        );
      }
      const classification = requiredResponseHeader(
        response,
        "x-proofstack-artifact-classification",
        DataClassificationSchema,
      );
      const redactionStatus = requiredResponseHeader(
        response,
        "x-proofstack-artifact-redaction-status",
        artifactRedactionStatusSchema,
      );
      const declaredSha256 = requiredResponseHeader(
        response,
        "x-proofstack-artifact-sha256",
        Sha256Schema,
      );
      const requestId = requiredResponseHeader(
        response,
        "x-proofstack-request-id",
        RequestIdSchema,
      );
      const content = await readBoundedBinaryBody(response);
      const actualSha256 = await contentSha256(content);
      if (actualSha256 !== declaredSha256) {
        throw new ProofStackApiError(
          "ProofStack artifact content digest does not match its response header",
          response.status,
        );
      }
      return {
        classification,
        content,
        mediaType: mediaType.data,
        redactionStatus,
        requestId,
        sha256: declaredSha256,
      };
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

  private async request<Output>(
    resourcePath: readonly string[],
    method: "DELETE" | "GET" | "POST" | "PUT",
    body: unknown,
    responseSchema: ResponseSchema<Output>,
    expectedStatuses: readonly number[],
    authority: "manage" | "read" | "write" = method === "GET" ? "read" : "manage",
    maxResponseBytes = MAX_CONTROL_PLANE_RESPONSE_BYTES,
  ): Promise<{ readonly status: number; readonly value: Output }> {
    if (authority === "manage" && this.authentication.mode === "workload") {
      throw new ProofStackApiError(
        "This operation requires user management authority; workload keys are read-only for management operations",
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
      const binaryBody = body instanceof Uint8Array;
      const response = await this.fetchImplementation(url, {
        ...(body === undefined
          ? {}
          : { body: binaryBody ? Uint8Array.from(body) : JSON.stringify(body) }),
        credentials: this.authentication.mode === "browser" ? "include" : "omit",
        headers: {
          accept: "application/json",
          ...(this.authentication.mode === "workload"
            ? { authorization: `Bearer ${this.authentication.apiKey}` }
            : {}),
          ...(this.authentication.mode === "browser" && method !== "GET"
            ? { "x-proofstack-csrf": this.authentication.csrfToken }
            : {}),
          ...(body === undefined
            ? {}
            : { "content-type": binaryBody ? "application/octet-stream" : "application/json" }),
        },
        method,
        signal: controller.signal,
      });
      const responseText = await readBoundedResponseBody(response, maxResponseBytes);
      if (!response.ok) {
        this.throwRejectedResponse(response, responseText);
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
