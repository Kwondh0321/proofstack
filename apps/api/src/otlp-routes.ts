import {
  EVIDENCE_SCHEMA_VERSION,
  OpaqueIdSchema,
  type PrincipalContext,
} from "@proofstack/contracts";
import { EvidenceConflictError, ForbiddenError, type IngestEvidence } from "@proofstack/core";
import { normalizeOtlpTraceRequest, type OtlpHttpEncoding } from "@proofstack/otlp";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type Authenticator,
  AuthenticationRequiredError,
  BrowserRequestRejectedError,
} from "./auth.js";
import {
  decodeOtlpHttpRequest,
  encodeOtlpStatus,
  encodeOtlpTraceResponse,
  OtlpHttpError,
  OTLP_JSON_MEDIA_TYPE,
  OTLP_PROTOBUF_MEDIA_TYPE,
  parseOtlpMediaType,
} from "./otlp-http.js";

const PROJECT_HEADER = "x-proofstack-project-id";
const ENVIRONMENT_HEADER = "x-proofstack-environment-id";

interface OtlpRouteErrorOptions extends ErrorOptions {
  readonly rpcCode: number;
  readonly statusCode: number;
}

class OtlpRouteError extends Error {
  readonly rpcCode: number;
  readonly statusCode: number;

  constructor(message: string, options: OtlpRouteErrorOptions) {
    super(message, options);
    this.name = "OtlpRouteError";
    this.rpcCode = options.rpcCode;
    this.statusCode = options.statusCode;
  }
}

export interface OtlpRouteDependencies {
  readonly authenticator: Authenticator;
  readonly compressedBodyLimitBytes: number;
  readonly decompressedBodyLimitBytes: number;
  readonly ingestEvidence: IngestEvidence;
}

function preferredResponseEncoding(request: FastifyRequest): OtlpHttpEncoding {
  try {
    return parseOtlpMediaType(request.headers["content-type"]);
  } catch {
    return "json";
  }
}

function headerValues(request: FastifyRequest, expectedName: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const name = request.raw.rawHeaders[index];
    const value = request.raw.rawHeaders[index + 1];
    if (name?.toLowerCase() === expectedName && value !== undefined) values.push(value);
  }
  return values;
}

function requiredScopeHeader(request: FastifyRequest, name: string): string {
  const values = headerValues(request, name);
  if (values.length !== 1) {
    throw new OtlpRouteError(`Exactly one ${name} header is required`, {
      rpcCode: 3,
      statusCode: 400,
    });
  }
  const parsed = OpaqueIdSchema.safeParse(values[0]);
  if (!parsed.success) {
    throw new OtlpRouteError(`${name} must be a valid ProofStack identifier`, {
      rpcCode: 3,
      statusCode: 400,
    });
  }
  return parsed.data;
}

function requireOtlpPrincipal(principal: PrincipalContext): void {
  if (principal.authentication.method === "development") return;
  if (principal.authentication.method !== "api_key" || principal.principalType !== "workload") {
    throw new OtlpRouteError("OTLP trace ingestion requires a workload API key", {
      rpcCode: 7,
      statusCode: 403,
    });
  }
}

function rawBody(value: unknown): Uint8Array {
  /* v8 ignore next -- The scoped parsers always return Buffer, including for an empty body. */
  if (!(value instanceof Uint8Array)) {
    throw new OtlpRouteError("OTLP trace request body is invalid", {
      rpcCode: 3,
      statusCode: 400,
    });
  }
  return value;
}

function numericStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function otlpFailure(error: unknown): {
  readonly message: string;
  readonly rpcCode: number;
  readonly statusCode: number;
} {
  if (error instanceof OtlpHttpError || error instanceof OtlpRouteError) {
    return { message: error.message, rpcCode: error.rpcCode, statusCode: error.statusCode };
  }
  if (error instanceof AuthenticationRequiredError) {
    return { message: "Authentication is required or invalid", rpcCode: 16, statusCode: 401 };
  }
  if (error instanceof BrowserRequestRejectedError || error instanceof ForbiddenError) {
    return {
      message: "The principal is not allowed to ingest OTLP traces",
      rpcCode: 7,
      statusCode: 403,
    };
  }
  if (error instanceof EvidenceConflictError) {
    return {
      message: "An evidence event identity conflicts with stored evidence",
      rpcCode: 6,
      statusCode: 409,
    };
  }

  const statusCode = numericStatus(error);
  if (statusCode === 413) {
    return {
      message: "OTLP request body exceeds the configured size limit",
      rpcCode: 8,
      statusCode,
    };
  }
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return { message: "The OTLP HTTP request was rejected", rpcCode: 3, statusCode };
  }
  return { message: "An unexpected OTLP ingestion error occurred", rpcCode: 13, statusCode: 500 };
}

function sendOtlpFailure(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const failure = otlpFailure(error);
  if (failure.statusCode >= 500) request.log.error({ error }, "OTLP trace ingestion failed");
  if (failure.statusCode === 401) reply.header("www-authenticate", 'Bearer realm="proofstack"');
  const encoded = encodeOtlpStatus(preferredResponseEncoding(request), {
    code: failure.rpcCode,
    message: failure.message,
  });
  return reply.status(failure.statusCode).type(encoded.contentType).send(Buffer.from(encoded.body));
}

export async function registerOtlpRoutes(
  app: FastifyInstance,
  dependencies: OtlpRouteDependencies,
): Promise<void> {
  await app.register(async (otlpApp) => {
    const principals = new WeakMap<FastifyRequest, PrincipalContext>();
    const checkRateLimit = otlpApp.createRateLimit({
      keyGenerator: (request) => {
        const principal = principals.get(request) as PrincipalContext;
        return `${principal.tenantId}:${principal.principalId}`;
      },
      max: 120,
      timeWindow: "1 minute",
    });
    otlpApp.removeContentTypeParser(OTLP_JSON_MEDIA_TYPE);
    otlpApp.addContentTypeParser(
      [OTLP_JSON_MEDIA_TYPE, OTLP_PROTOBUF_MEDIA_TYPE],
      { bodyLimit: dependencies.compressedBodyLimitBytes, parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    otlpApp.post(
      "/v1/traces",
      {
        errorHandler: sendOtlpFailure,
        preHandler: async (request, reply) => {
          const result = await checkRateLimit(request);
          if (result.isAllowed || !result.isExceeded) return;
          reply.header("retry-after", `${result.ttlInSeconds}`);
          throw new OtlpRouteError("OTLP trace ingestion rate limit exceeded", {
            rpcCode: 8,
            statusCode: 429,
          });
        },
        preParsing: async (request, _reply, payload) => {
          const principal = await dependencies.authenticator.authenticate(request);
          requireOtlpPrincipal(principal);
          principals.set(request, principal);
          return payload;
        },
      },
      async (request, reply) => {
        const principal = principals.get(request);
        /* v8 ignore next -- preParsing establishes this context before preHandler and handler. */
        if (!principal) {
          throw new OtlpRouteError("Authenticated OTLP principal context is unavailable", {
            rpcCode: 13,
            statusCode: 500,
          });
        }
        const projectId = requiredScopeHeader(request, PROJECT_HEADER);
        const environmentId = requiredScopeHeader(request, ENVIRONMENT_HEADER);
        const mediaType = request.headers["content-type"];
        parseOtlpMediaType(mediaType);
        const decoded = await decodeOtlpHttpRequest(
          rawBody(request.body),
          mediaType,
          request.headers["content-encoding"],
          dependencies.decompressedBodyLimitBytes,
        );
        const normalized = normalizeOtlpTraceRequest(decoded.request);
        try {
          await dependencies.ingestEvidence.execute({
            environmentId,
            principal,
            projectId,
            request: {
              events: [...normalized.records],
              schemaVersion: EVIDENCE_SCHEMA_VERSION,
            },
          });
        } catch (error) {
          if (error instanceof ForbiddenError || error instanceof EvidenceConflictError)
            throw error;
          throw new OtlpRouteError("Evidence persistence is unavailable", {
            cause: error,
            rpcCode: 14,
            statusCode: 503,
          });
        }

        const encoded = encodeOtlpTraceResponse(
          decoded.encoding,
          normalized.rejectedSpans > 0
            ? {
                partialSuccess: {
                  errorMessage: normalized.errorMessage as string,
                  rejectedSpans: normalized.rejectedSpans,
                },
              }
            : {},
        );
        return reply.status(200).type(encoded.contentType).send(Buffer.from(encoded.body));
      },
    );
  });
}
