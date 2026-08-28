import {
  ReadinessResponseSchema,
  TraceIdSchema,
  type TracePageCursor,
  TracePageCursorSchema,
  type TraceResponse,
  TraceResponseSchema,
} from "@proofstack/contracts";

const DEFAULT_API_TIMEOUT_MS = 3_000;

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
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetcher(input, { cache: "no-store", signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ApiRequestTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
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
