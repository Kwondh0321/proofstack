import {
  ApiKeyValueSchema,
  ProblemDocumentSchema,
  type EvidenceScope,
} from "@proofstack/contracts";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";
import { policyParsed, policyScope } from "./policy-evaluation-integrity.js";

export type ProofStackPolicyEvaluationAuthentication =
  | { readonly mode: "development" }
  | { readonly mode: "workload"; readonly apiKey: string }
  | { readonly mode: "browser"; readonly csrfToken: string };
export interface PolicyEvaluationTransportOptions {
  readonly endpoint: string | URL;
  readonly scope: EvidenceScope;
  readonly authentication: ProofStackPolicyEvaluationAuthentication;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
interface ResponseSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
}
export interface PolicyEvaluationOperation {
  check(): void;
  request<T>(
    path: readonly string[],
    query: URLSearchParams | undefined,
    method: "GET" | "POST",
    body: unknown,
    inputLimit: number,
    outputLimit: number,
    schema: ResponseSchema<T>,
    statuses: readonly number[],
  ): Promise<{ status: number; value: T }>;
}
const loopback = (hostname: string) => ["127.0.0.1", "[::1]", "localhost"].includes(hostname);
function authentication(
  raw: ProofStackPolicyEvaluationAuthentication,
): ProofStackPolicyEvaluationAuthentication {
  if (typeof raw !== "object" || raw === null)
    throw new ProofStackApiError("Policy evaluation authentication failed local validation");
  if (raw.mode === "development") return { mode: "development" };
  if (raw.mode === "workload")
    return { mode: "workload", apiKey: policyParsed(ApiKeyValueSchema, raw.apiKey) };
  if (raw.mode === "browser" && /^psc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(raw.csrfToken))
    return { mode: "browser", csrfToken: raw.csrfToken };
  throw new ProofStackApiError("Policy evaluation authentication failed local validation");
}
const errorForAbort = (expired: boolean) =>
  new ProofStackApiError(
    expired ? "Policy evaluation operation timed out" : "Policy evaluation operation was aborted",
  );

/** One operation deadline spans all requests/pages and local validation; no mutation retries. */
export class PolicyEvaluationTransport {
  readonly scope: EvidenceScope;
  private readonly endpoint: URL;
  private readonly auth: ProofStackPolicyEvaluationAuthentication;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maximum: number;
  constructor(options: PolicyEvaluationTransportOptions) {
    this.scope = policyScope(options.scope);
    try {
      this.endpoint = new URL(options.endpoint);
    } catch (cause) {
      throw new ProofStackApiError(
        "Policy evaluation endpoint must be an absolute URL",
        undefined,
        { cause },
      );
    }
    if (
      !["https:", "http:"].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      (this.endpoint.protocol === "http:" && !loopback(this.endpoint.hostname))
    )
      throw new ProofStackApiError(
        "Policy evaluation endpoint requires HTTPS or explicit loopback HTTP without embedded credentials",
      );
    this.endpoint.search = "";
    this.endpoint.hash = "";
    this.auth = authentication(options.authentication);
    if (this.auth.mode === "development" && !loopback(this.endpoint.hostname))
      throw new ProofStackApiError(
        "Development authentication requires an explicit loopback endpoint",
      );
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== "function")
      throw new ProofStackApiError("No fetch implementation is available");
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maximum = options.maxResponseBytes ?? 512 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000)
      throw new ProofStackApiError(
        "Policy evaluation timeout must be between 1 and 60000 milliseconds",
      );
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 512 * 1024)
      throw new ProofStackApiError(
        "Policy evaluation response budget must be between 1 and 524288 bytes",
      );
  }
  async run<T>(
    external: AbortSignal | undefined,
    work: (operation: PolicyEvaluationOperation) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let expired = false;
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      expired = true;
      abort();
    }, this.timeoutMs);
    external?.addEventListener("abort", abort, { once: true });
    if (external?.aborted) abort();
    const check = () => {
      if (controller.signal.aborted) throw errorForAbort(expired);
    };
    const wait = <V>(pending: Promise<V>, late?: (value: V) => Promise<void>): Promise<V> =>
      new Promise((resolve, reject) => {
        let settled = false;
        const stopped = () => {
          if (!settled) {
            settled = true;
            reject(errorForAbort(expired));
          }
        };
        controller.signal.addEventListener("abort", stopped, { once: true });
        if (controller.signal.aborted) stopped();
        pending.then(
          (value) => {
            controller.signal.removeEventListener("abort", stopped);
            if (settled) {
              // A noncooperative injected fetch can resolve after failure. Discard it and attempt
              // cancellation; this never turns the original timeout into a successful response.
              if (late) void late(value).catch(() => {});
            } else {
              settled = true;
              resolve(value);
            }
          },
          (cause) => {
            controller.signal.removeEventListener("abort", stopped);
            if (!settled) {
              settled = true;
              reject(cause);
            }
          },
        );
      });
    const settleCleanup = (pending: Promise<void>): Promise<void> =>
      new Promise((resolve, reject) => {
        const stopped = () => resolve();
        controller.signal.addEventListener("abort", stopped, { once: true });
        pending.then(
          () => {
            controller.signal.removeEventListener("abort", stopped);
            resolve();
          },
          (cause) => {
            controller.signal.removeEventListener("abort", stopped);
            reject(cause);
          },
        );
        if (controller.signal.aborted) {
          controller.signal.removeEventListener("abort", stopped);
          // Give an already-settled cancellation error its original turn before disposal expires.
          queueMicrotask(stopped);
        }
      });
    const request: PolicyEvaluationOperation["request"] = async (
      path,
      query,
      method,
      body,
      inputLimit,
      outputLimit,
      schema,
      statuses,
    ) => {
      check();
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded !== undefined && new TextEncoder().encode(encoded).byteLength > inputLimit)
        throw new ProofStackApiError("Policy evaluation request exceeds its UTF-8 byte budget");
      const url = new URL(this.endpoint);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${["v1", "projects", this.scope.projectId, "environments", this.scope.environmentId, "policy-evaluation-jobs", ...path].map(encodeURIComponent).join("/")}`;
      url.search = query?.toString() ?? "";
      const limit = Math.min(this.maximum, outputLimit);
      let response: Response | undefined,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        finished = false;
      const cleanup = async (cancel: boolean) => {
        const failures: unknown[] = [];
        if (cancel && !finished) {
          try {
            if (reader) await settleCleanup(reader.cancel());
            else if (response?.body) await settleCleanup(response.body.cancel());
          } catch (cause) {
            failures.push(cause);
          }
        }
        if (reader) {
          try {
            reader.releaseLock();
          } catch (cause) {
            failures.push(cause);
          }
          reader = undefined;
        }
        return failures;
      };
      try {
        response = await wait(
          this.fetcher(url, {
            method,
            redirect: "manual",
            signal: controller.signal,
            credentials: this.auth.mode === "browser" ? "include" : "omit",
            headers: {
              accept: "application/json",
              ...(encoded === undefined ? {} : { "content-type": "application/json" }),
              ...(this.auth.mode === "workload"
                ? { authorization: `Bearer ${this.auth.apiKey}` }
                : {}),
              ...(this.auth.mode === "browser" && method === "POST"
                ? { "x-proofstack-csrf": this.auth.csrfToken }
                : {}),
            },
            ...(encoded === undefined ? {} : { body: encoded }),
          }),
          async (late) => {
            await late.body?.cancel();
          },
        );
        check();
        if (
          response.redirected ||
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        )
          throw new ProofStackApiError(
            "Policy evaluation requests do not permit redirects",
            response.status || undefined,
          );
        const media = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (media !== (response.ok ? "application/json" : "application/problem+json"))
          throw new ProofStackApiError(
            "Policy evaluation response has an unexpected media type",
            response.status,
          );
        if (
          !response.headers
            .get("cache-control")
            ?.toLowerCase()
            .split(",")
            .some((value) => value.trim() === "no-store")
        )
          throw new ProofStackApiError(
            "Policy evaluation response omitted its no-store boundary",
            response.status,
          );
        const declared = response.headers.get("content-length");
        if (
          declared !== null &&
          (declared.length > String(limit).length ||
            !/^(0|[1-9][0-9]*)$/.test(declared) ||
            BigInt(declared) > BigInt(limit))
        )
          throw new ProofStackApiError(
            "Policy evaluation response declares an invalid or excessive byte length",
            response.status,
          );
        if (!response.body)
          throw new ProofStackApiError(
            "Policy evaluation response body is missing",
            response.status,
          );
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true }),
          chunks: string[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await wait(reader.read());
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > limit)
            throw new ProofStackApiError(
              "Policy evaluation response exceeds its streamed UTF-8 byte budget",
              response.status,
            );
          chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
        chunks.push(decoder.decode());
        finished = true;
        const failures = await cleanup(false);
        if (failures.length)
          throw new ProofStackApiError("Policy evaluation reader cleanup failed", response.status, {
            cause: new AggregateError(failures),
          });
        const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
        if (
          declared !== null &&
          (!encoding || encoding === "identity") &&
          BigInt(declared) !== BigInt(bytes)
        )
          throw new ProofStackApiError(
            "Policy evaluation response was truncated or contradicted its declared byte length",
            response.status,
          );
        check();
        let data: unknown;
        try {
          data = JSON.parse(chunks.join(""));
        } catch (cause) {
          throw new ProofStackApiError(
            "Policy evaluation response is not complete JSON",
            response.status,
            { cause },
          );
        }
        if (!response.ok) {
          const problem = policyParsed(ProblemDocumentSchema, data);
          if (problem.status !== response.status)
            throw new ProofStackApiError(
              "Policy evaluation problem status differs from HTTP",
              response.status,
            );
          throw new ProofStackProblemError(problem);
        }
        if (!statuses.includes(response.status))
          throw new ProofStackApiError(
            "Policy evaluation response has an unexpected HTTP status",
            response.status,
          );
        return { status: response.status, value: policyParsed(schema, data) };
      } catch (cause) {
        const failures = await cleanup(true);
        if (failures.length)
          throw new ProofStackApiError(
            "Policy evaluation request and cleanup failed",
            response?.status,
            { cause: new AggregateError([cause, ...failures]) },
          );
        throw cause;
      }
    };
    try {
      check();
      const result = await work({ request, check });
      check();
      return result;
    } catch (cause) {
      if (cause instanceof ProofStackApiError) throw cause;
      if (controller.signal.aborted) throw errorForAbort(expired);
      throw new ProofStackApiError("Policy evaluation operation failed", undefined, { cause });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    }
  }
}
