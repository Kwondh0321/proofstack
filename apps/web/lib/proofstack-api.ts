import {
  type ComparisonDefinition,
  type ComparisonEvidenceSnapshot,
  type ComparisonRecordEnvelope,
  type ComparisonRecordKind,
  type ComparisonResult,
  encodeComparisonDefinition,
  encodeComparisonEvidenceSnapshotDefinition,
  encodeComparisonResultDefinition,
  OpaqueIdSchema,
  ReadComparisonRecordResponseSchema,
  ReadinessResponseSchema,
  TraceIdSchema,
  type TracePageCursor,
  TracePageCursorSchema,
  type TraceResponse,
  TraceResponseSchema,
} from "@proofstack/contracts";

const DEFAULT_API_TIMEOUT_MS = 3_000;
export const MAX_COMPARISON_RESPONSE_BYTES = 1024 * 1024;
const BROWSER_SESSION_TOKEN_PATTERN = /^pss_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

class ApiRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`ProofStack API request timed out after ${timeoutMs}ms`);
    this.name = "ApiRequestTimeoutError";
  }
}

class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigurationError";
  }
}

export type ApiResult<T> =
  | { readonly data: T; readonly ok: true }
  | {
      readonly kind: "invalid_response" | "not_found" | "unavailable";
      readonly message: string;
      readonly ok: false;
    };

export interface TraceRequestOptions {
  readonly cursor?: TracePageCursor;
  readonly timeoutMs?: number;
}

export interface ComparisonRequestOptions {
  readonly browserSessionToken?: string;
  readonly timeoutMs?: number;
}

export interface ComparisonView {
  readonly baseline: ComparisonEvidenceSnapshot;
  readonly candidate: ComparisonEvidenceSnapshot;
  readonly definition: ComparisonDefinition;
  readonly result: ComparisonResult;
}

interface ApiConnection {
  readonly baseUrl: URL;
  readonly environmentId: string;
  readonly projectId: string;
}

function connection(environment: NodeJS.ProcessEnv = process.env): ApiConnection {
  const { PROOFSTACK_API_URL, PROOFSTACK_ENVIRONMENT_ID, PROOFSTACK_PROJECT_ID } = environment;
  let baseUrl: URL;
  try {
    baseUrl = new URL(PROOFSTACK_API_URL ?? "http://127.0.0.1:4318");
  } catch {
    throw new ApiConfigurationError("PROOFSTACK_API_URL must be a valid absolute URL");
  }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new ApiConfigurationError("PROOFSTACK_API_URL must use HTTP or HTTPS");
  }
  if (baseUrl.username || baseUrl.password) {
    throw new ApiConfigurationError("PROOFSTACK_API_URL must not contain embedded credentials");
  }
  if (baseUrl.protocol === "http:" && !isLoopbackHostname(baseUrl.hostname)) {
    throw new ApiConfigurationError(
      "Unencrypted PROOFSTACK_API_URL values must use an explicit loopback host",
    );
  }
  baseUrl.search = "";
  baseUrl.hash = "";

  return {
    baseUrl,
    environmentId: PROOFSTACK_ENVIRONMENT_ID ?? "env_local",
    projectId: PROOFSTACK_PROJECT_ID ?? "prj_local",
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

function unavailableMessage(error: unknown): string {
  if (error instanceof ApiRequestTimeoutError || error instanceof ApiConfigurationError) {
    return error.message;
  }
  return "API is not reachable";
}

function scopedUrl(path: string, settings: ApiConnection): URL {
  const url = new URL(settings.baseUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/v1/projects/${encodeURIComponent(
    settings.projectId,
  )}/environments/${encodeURIComponent(settings.environmentId)}${path}`;
  return url;
}

async function fetchApi(
  fetcher: typeof globalThis.fetch,
  input: URL,
  timeoutMs: number,
  headers?: HeadersInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetcher(input, {
      cache: "no-store",
      ...(headers ? { headers } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new ApiRequestTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

class ComparisonViewError extends Error {
  constructor(
    readonly kind: "invalid_response" | "not_found" | "unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComparisonViewError";
  }
}

function comparisonDefinition(record: ComparisonRecordEnvelope): Record<string, unknown> {
  const definition = structuredClone(record.record) as unknown as Record<string, unknown>;
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

function encodeComparisonRecord(record: ComparisonRecordEnvelope): Uint8Array {
  const input = { definition: comparisonDefinition(record), scope: record.record.scope };
  switch (record.kind) {
    case "comparison_definition":
      return encodeComparisonDefinition(input as never);
    case "comparison_evidence_snapshot":
      return encodeComparisonEvidenceSnapshotDefinition(input as never);
    case "comparison_result":
      return encodeComparisonResultDefinition(input as never);
  }
}

async function comparisonDigest(record: ComparisonRecordEnvelope): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(encodeComparisonRecord(record)).buffer,
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function comparisonRecordId(record: ComparisonRecordEnvelope): string {
  switch (record.kind) {
    case "comparison_definition":
      return record.record.comparisonVersionId;
    case "comparison_evidence_snapshot":
      return record.record.snapshotId;
    case "comparison_result":
      return record.record.resultId;
  }
}

function hasNoStore(response: Response): boolean {
  return (
    response.headers
      .get("cache-control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store") ?? false
  );
}

async function boundedComparisonJson(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new ComparisonViewError(
      "invalid_response",
      "Comparison API returned an unexpected media type",
    );
  }
  if (!hasNoStore(response)) {
    throw new ComparisonViewError(
      "invalid_response",
      "Comparison API response omitted the required no-store boundary",
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > MAX_COMPARISON_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new ComparisonViewError("invalid_response", "Comparison API response is too large");
    }
  }
  if (!response.body) {
    throw new ComparisonViewError("invalid_response", "Comparison API response is empty");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_COMPARISON_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ComparisonViewError("invalid_response", "Comparison API response is too large");
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(chunks.join(""));
  } catch (error) {
    throw new ComparisonViewError("invalid_response", "Comparison API returned invalid JSON", {
      cause: error,
    });
  }
}

function sameScope(
  left: { readonly environmentId: string; readonly projectId: string; readonly tenantId: string },
  right: { readonly environmentId: string; readonly projectId: string; readonly tenantId: string },
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
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

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function snapshotFitsSubject(view: ComparisonView, role: "baseline" | "candidate"): boolean {
  const snapshot = view[role];
  const subject = view.definition[role];
  const subjectFixtureIds = new Set(subject.fixtures.map(({ fixture }) => fixture.fixtureId));
  return (
    sameCanonicalValue(snapshot.dataset, subject.dataset) &&
    snapshot.fixtures.every(({ fixture }) => subjectFixtureIds.has(fixture.fixtureId))
  );
}

function hasConsistentDerivedMetadata(view: ComparisonView): boolean {
  const expectedCaseIds = [
    ...new Set([
      ...view.definition.baseline.fixtures.map(({ fixture }) => fixture.fixtureId),
      ...view.definition.candidate.fixtures.map(({ fixture }) => fixture.fixtureId),
    ]),
  ].sort();
  const expectedMetricIds = view.definition.metrics.map(({ metricId }) => metricId);
  const expectedLimitations = [
    ...new Set([...view.baseline.knownLimitations, ...view.candidate.knownLimitations]),
  ].sort();
  const expectedSourceCutoff =
    view.baseline.sourceCutoff < view.candidate.sourceCutoff
      ? view.candidate.sourceCutoff
      : view.baseline.sourceCutoff;

  return (
    snapshotFitsSubject(view, "baseline") &&
    snapshotFitsSubject(view, "candidate") &&
    sameOrderedStrings(
      view.result.cases.map(({ fixtureId }) => fixtureId),
      expectedCaseIds,
    ) &&
    sameOrderedStrings(
      view.result.metricResults.map(({ metricId }) => metricId),
      expectedMetricIds,
    ) &&
    sameOrderedStrings(view.result.knownLimitations, expectedLimitations) &&
    view.result.latestSourceCutoff === expectedSourceCutoff
  );
}

function assertComparisonBundle(view: ComparisonView): void {
  const reference = view.result.comparison;
  const definitionReference = {
    comparisonId: view.definition.comparisonId,
    comparisonVersionId: view.definition.comparisonVersionId,
    definitionSha256: view.definition.definitionSha256,
  };
  if (
    !sameComparisonReference(reference, definitionReference) ||
    !sameComparisonReference(reference, view.baseline.comparison) ||
    !sameComparisonReference(reference, view.candidate.comparison) ||
    view.baseline.role !== "baseline" ||
    view.candidate.role !== "candidate" ||
    view.result.baselineSnapshot.snapshotId !== view.baseline.snapshotId ||
    view.result.baselineSnapshot.definitionSha256 !== view.baseline.definitionSha256 ||
    view.result.candidateSnapshot.snapshotId !== view.candidate.snapshotId ||
    view.result.candidateSnapshot.definitionSha256 !== view.candidate.definitionSha256 ||
    !sameScope(view.result.scope, view.definition.scope) ||
    !sameScope(view.result.scope, view.baseline.scope) ||
    !sameScope(view.result.scope, view.candidate.scope) ||
    !hasConsistentDerivedMetadata(view)
  ) {
    throw new ComparisonViewError(
      "invalid_response",
      "Comparison records have contradictory immutable lineage",
    );
  }
}

async function readComparisonRecord(
  kind: ComparisonRecordKind,
  recordId: string,
  settings: ApiConnection,
  fetcher: typeof globalThis.fetch,
  timeoutMs: number,
  headers: HeadersInit | undefined,
  primary: boolean,
): Promise<ComparisonRecordEnvelope> {
  const url = scopedUrl(
    `/comparisons/records/${encodeURIComponent(kind)}/${encodeURIComponent(recordId)}`,
    settings,
  );
  const response = await fetchApi(fetcher, url, timeoutMs, headers);
  if (response.status === 404) {
    throw new ComparisonViewError(
      primary ? "not_found" : "invalid_response",
      primary ? "Comparison result was not found" : "A referenced comparison record is unavailable",
    );
  }
  if (!response.ok) {
    throw new ComparisonViewError("unavailable", `Comparison API returned HTTP ${response.status}`);
  }
  const parsed = ReadComparisonRecordResponseSchema.safeParse(
    await boundedComparisonJson(response),
  );
  if (!parsed.success) {
    throw new ComparisonViewError(
      "invalid_response",
      "Comparison API response failed contract validation",
      { cause: parsed.error },
    );
  }
  const result = parsed.data.result;
  if (
    result.kind !== kind ||
    comparisonRecordId(result) !== recordId ||
    result.record.scope.projectId !== settings.projectId ||
    result.record.scope.environmentId !== settings.environmentId ||
    (await comparisonDigest(result)) !== result.record.definitionSha256
  ) {
    throw new ComparisonViewError(
      "invalid_response",
      "Comparison API response failed identity, scope, or digest verification",
    );
  }
  return result;
}

export async function getComparisonView(
  resultId: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  options: ComparisonRequestOptions = {},
): Promise<ApiResult<ComparisonView>> {
  if (!OpaqueIdSchema.safeParse(resultId).success) {
    return { kind: "invalid_response", message: "Comparison result ID is not valid", ok: false };
  }
  if (
    options.browserSessionToken !== undefined &&
    !BROWSER_SESSION_TOKEN_PATTERN.test(options.browserSessionToken)
  ) {
    return { kind: "invalid_response", message: "Browser session token is not valid", ok: false };
  }
  try {
    const settings = connection();
    if (
      !OpaqueIdSchema.safeParse(settings.projectId).success ||
      !OpaqueIdSchema.safeParse(settings.environmentId).success
    ) {
      throw new ApiConfigurationError("Configured project or environment ID is invalid");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    const headers = options.browserSessionToken
      ? { cookie: `__Host-proofstack_session=${options.browserSessionToken}` }
      : undefined;
    const resultEnvelope = await readComparisonRecord(
      "comparison_result",
      resultId,
      settings,
      fetcher,
      timeoutMs,
      headers,
      true,
    );
    if (resultEnvelope.kind !== "comparison_result") {
      throw new ComparisonViewError("invalid_response", "Comparison result kind is invalid");
    }
    const result = resultEnvelope.record;
    const [definitionEnvelope, baselineEnvelope, candidateEnvelope] = await Promise.all([
      readComparisonRecord(
        "comparison_definition",
        result.comparison.comparisonVersionId,
        settings,
        fetcher,
        timeoutMs,
        headers,
        false,
      ),
      readComparisonRecord(
        "comparison_evidence_snapshot",
        result.baselineSnapshot.snapshotId,
        settings,
        fetcher,
        timeoutMs,
        headers,
        false,
      ),
      readComparisonRecord(
        "comparison_evidence_snapshot",
        result.candidateSnapshot.snapshotId,
        settings,
        fetcher,
        timeoutMs,
        headers,
        false,
      ),
    ]);
    if (
      definitionEnvelope.kind !== "comparison_definition" ||
      baselineEnvelope.kind !== "comparison_evidence_snapshot" ||
      candidateEnvelope.kind !== "comparison_evidence_snapshot"
    ) {
      throw new ComparisonViewError("invalid_response", "Comparison source kinds are invalid");
    }
    const view = {
      baseline: baselineEnvelope.record,
      candidate: candidateEnvelope.record,
      definition: definitionEnvelope.record,
      result,
    };
    assertComparisonBundle(view);
    return { data: view, ok: true };
  } catch (error) {
    if (error instanceof ComparisonViewError) {
      return { kind: error.kind, message: error.message, ok: false };
    }
    return { kind: "unavailable", message: unavailableMessage(error), ok: false };
  }
}

export async function apiHealth(
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<ApiResult<"ready">> {
  try {
    const settings = connection();
    const url = new URL(settings.baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/health/ready`;
    const response = await fetchApi(fetcher, url, timeoutMs);
    if (!response.ok) {
      return { kind: "unavailable", message: `API returned HTTP ${response.status}`, ok: false };
    }
    const body: unknown = await response.json();
    if (!ReadinessResponseSchema.safeParse(body).success) {
      return { kind: "invalid_response", message: "API readiness response is invalid", ok: false };
    }
    return { data: "ready", ok: true };
  } catch (error) {
    return {
      kind: "unavailable",
      message: unavailableMessage(error),
      ok: false,
    };
  }
}

export async function getTrace(
  traceId: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  options: TraceRequestOptions = {},
): Promise<ApiResult<TraceResponse>> {
  if (!TraceIdSchema.safeParse(traceId).success) {
    return { kind: "invalid_response", message: "Trace ID is not valid", ok: false };
  }
  if (options.cursor && !TracePageCursorSchema.safeParse(options.cursor).success) {
    return { kind: "invalid_response", message: "Trace cursor is not valid", ok: false };
  }

  try {
    const settings = connection();
    const url = scopedUrl(`/traces/${traceId}`, settings);
    if (options.cursor) url.searchParams.set("cursor", options.cursor);
    const response = await fetchApi(fetcher, url, options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS);
    if (response.status === 404) {
      return { kind: "not_found", message: "Trace was not found", ok: false };
    }
    if (!response.ok) {
      return { kind: "unavailable", message: `API returned HTTP ${response.status}`, ok: false };
    }

    const parsed = TraceResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { kind: "invalid_response", message: "Trace response failed validation", ok: false };
    }
    return { data: parsed.data, ok: true };
  } catch (error) {
    return {
      kind: "unavailable",
      message: unavailableMessage(error),
      ok: false,
    };
  }
}
