import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  ApiKeyCredentialNotActiveError,
  ApiKeyCredentialNotFoundError,
  ApiKeyGenerationError,
  ApiKeyLifecycle,
  InvalidApiKeyLifecycleInputError,
  InvalidOidcLoginError,
  OidcLoginGenerationError,
} from "@proofstack/identity";
import {
  type Clock,
  EvidenceConflictError,
  type EvidenceRepository,
  ForbiddenError,
  IngestEvidence,
  InvalidTraceCursorError,
  ListTraceEvidence,
  MemoryEvidenceRepository,
  SystemClock,
  TraceNotFoundError,
} from "@proofstack/core";
import {
  MemoryRegressionVersionRepository,
  type RegressionVersionRepository,
} from "@proofstack/datasets";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { ZodError } from "zod";
import {
  type Authenticator,
  AuthenticationRequiredError,
  BrowserRequestRejectedError,
  createAuthenticator,
} from "./auth.js";
import type { ApiConfig } from "./config.js";
import { createIdentityStorage, type IdentityStorage } from "./identity-storage.js";
import {
  type ApiKeyLifecycleService,
  IdentityManagementUnavailableError,
  registerIdentityRoutes,
} from "./identity-routes.js";
import { createOidcRuntime, type OidcRuntime } from "./oidc-runtime.js";
import { registerOidcRoutes } from "./oidc-routes.js";
import { registerOtlpRoutes } from "./otlp-routes.js";
import { sendProblem } from "./problem.js";
import { registerRoutes } from "./routes.js";
import { createApiStorage } from "./storage.js";

export interface AppDependencies {
  readonly apiKeyLifecycle?: ApiKeyLifecycleService;
  readonly authenticator?: Authenticator;
  readonly checkReadiness?: () => Promise<void>;
  readonly clock?: Clock;
  readonly identityStorage?: IdentityStorage;
  readonly oidcRuntime?: OidcRuntime;
  readonly regressionVersionRepository?: RegressionVersionRepository;
  readonly repository?: EvidenceRepository;
}

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = error.statusCode;
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) return undefined;
  return statusCode;
}

export async function createApp(
  config: ApiConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const clock = dependencies.clock ?? new SystemClock();

  const app = Fastify({
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    logController: new LogController({
      disableRequestLogging: config.environment === "test",
    }),
    logger:
      config.environment === "test"
        ? false
        : {
            level: config.logLevel,
            redact: {
              censor: "[Redacted]",
              paths: ["req.headers.authorization", "req.headers.cookie"],
            },
          },
    trustProxy: false,
  });
  try {
    const storage =
      dependencies.repository || dependencies.regressionVersionRepository
        ? {
            checkReadiness: dependencies.checkReadiness ?? (async () => undefined),
            close: async () => undefined,
            evidenceRepository: dependencies.repository ?? new MemoryEvidenceRepository(),
            regressionVersionRepository:
              dependencies.regressionVersionRepository ?? new MemoryRegressionVersionRepository(),
          }
        : await createApiStorage(config.storage, (error) => {
            app.log.error({ error }, "Idle PostgreSQL connection failed");
          });
    app.addHook("onClose", storage.close);

    let identityStorage: IdentityStorage | undefined;
    if (dependencies.identityStorage) {
      identityStorage = dependencies.identityStorage;
    } else if (config.identityDatabaseUrl) {
      identityStorage = await createIdentityStorage(config.identityDatabaseUrl, (error) => {
        app.log.error({ error }, "Idle identity PostgreSQL connection failed");
      });
      app.addHook("onClose", identityStorage.close);
    }
    const usesOidc = config.authMode === "oidc" || config.authMode === "combined";
    let oidcRuntime = dependencies.oidcRuntime;
    if (usesOidc) {
      if (!config.oidc || !identityStorage) {
        throw new Error("OIDC identity storage is not configured; startup refused");
      }
      oidcRuntime ??= await createOidcRuntime(
        {
          ...config.oidc,
          browserOrigin: config.corsOrigin ?? new URL(config.oidc.redirectUri).origin,
        },
        identityStorage.oidcRepository,
      );
    }
    const authenticator =
      dependencies.authenticator ??
      createAuthenticator(config, {
        ...(identityStorage ? { apiKeyCredentials: identityStorage.repository } : {}),
        ...(oidcRuntime ? { browserAuthenticator: oidcRuntime.browserSessions } : {}),
      });

    await app.register(helmet, {
      contentSecurityPolicy: false,
    });
    await app.register(cors, {
      credentials: usesOidc,
      origin: config.corsOrigin ?? false,
    });
    await app.register(rateLimit, {
      global: false,
    });

    if (config.oidc && oidcRuntime) {
      await registerOidcRoutes(app, {
        browserSessions: oidcRuntime.browserSessions,
        login: oidcRuntime.login,
        redirectUri: config.oidc.redirectUri,
        sessionLifecycle: oidcRuntime.sessionLifecycle,
      });
    }

    const ingestEvidence = new IngestEvidence(storage.evidenceRepository, clock);
    await registerRoutes(app, {
      authenticator,
      checkReadiness: async () => {
        await storage.checkReadiness();
        await identityStorage?.checkReadiness();
      },
      ingestEvidence,
      listTraceEvidence: new ListTraceEvidence(storage.evidenceRepository),
    });
    const apiKeyLifecycle =
      dependencies.apiKeyLifecycle ??
      (identityStorage ? new ApiKeyLifecycle(identityStorage.repository) : undefined);
    await registerIdentityRoutes(app, {
      ...(apiKeyLifecycle ? { apiKeyLifecycle } : {}),
      authenticator,
    });

    app.setNotFoundHandler((request, reply) =>
      sendProblem(reply, {
        code: "route_not_found",
        detail: `No route matches ${request.method} ${request.url}`,
        requestId: request.id,
        status: 404,
        title: "Route not found",
        type: "https://proofstack.dev/problems/route-not-found",
      }),
    );

    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ZodError) {
        return sendProblem(reply, {
          code: "invalid_request",
          detail: "The request does not match the required contract",
          issues: error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path.join("."),
          })),
          requestId: request.id,
          status: 400,
          title: "Invalid request",
          type: "https://proofstack.dev/problems/invalid-request",
        });
      }

      if (error instanceof AuthenticationRequiredError) {
        if (config.authMode === "api_key" || config.authMode === "combined") {
          reply.header("www-authenticate", 'Bearer realm="proofstack"');
        }
        return sendProblem(reply, {
          code: "unauthenticated",
          detail: error.message,
          requestId: request.id,
          status: 401,
          title: "Authentication required",
          type: "https://proofstack.dev/problems/unauthenticated",
        });
      }

      if (error instanceof BrowserRequestRejectedError) {
        return sendProblem(reply, {
          code: "browser_request_rejected",
          detail: "Browser request origin or CSRF verification failed",
          requestId: request.id,
          status: 403,
          title: "Browser request rejected",
          type: "https://proofstack.dev/problems/browser-request-rejected",
        });
      }

      if (error instanceof InvalidOidcLoginError) {
        return sendProblem(reply, {
          code: "invalid_oidc_login",
          detail: "OIDC login is invalid or expired",
          requestId: request.id,
          status: 400,
          title: "Invalid OIDC login",
          type: "https://proofstack.dev/problems/invalid-oidc-login",
        });
      }

      if (error instanceof InvalidApiKeyLifecycleInputError) {
        return sendProblem(reply, {
          code: "invalid_api_key_request",
          detail: error.message,
          requestId: request.id,
          status: 400,
          title: "Invalid API key request",
          type: "https://proofstack.dev/problems/invalid-api-key-request",
        });
      }

      if (error instanceof ForbiddenError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 403,
          title: "Forbidden",
          type: "https://proofstack.dev/problems/forbidden",
        });
      }

      if (error instanceof EvidenceConflictError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Evidence conflict",
          type: "https://proofstack.dev/problems/evidence-conflict",
        });
      }

      if (error instanceof ApiKeyCredentialNotFoundError) {
        return sendProblem(reply, {
          code: "api_key_not_found",
          detail: "The API key credential was not found",
          requestId: request.id,
          status: 404,
          title: "API key not found",
          type: "https://proofstack.dev/problems/api-key-not-found",
        });
      }

      if (error instanceof ApiKeyCredentialNotActiveError) {
        return sendProblem(reply, {
          code: "api_key_not_active",
          detail: "The API key credential is not active",
          requestId: request.id,
          status: 409,
          title: "API key not active",
          type: "https://proofstack.dev/problems/api-key-not-active",
        });
      }

      if (
        error instanceof ApiKeyGenerationError ||
        error instanceof OidcLoginGenerationError ||
        error instanceof IdentityManagementUnavailableError
      ) {
        return sendProblem(reply, {
          code: "identity_unavailable",
          detail: "Identity management is unavailable",
          requestId: request.id,
          status: 503,
          title: "Identity unavailable",
          type: "https://proofstack.dev/problems/identity-unavailable",
        });
      }

      if (error instanceof TraceNotFoundError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 404,
          title: "Trace not found",
          type: "https://proofstack.dev/problems/trace-not-found",
        });
      }

      if (error instanceof InvalidTraceCursorError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 400,
          title: "Invalid trace cursor",
          type: "https://proofstack.dev/problems/invalid-trace-cursor",
        });
      }

      const statusCode = clientErrorStatus(error);
      if (statusCode) {
        return sendProblem(reply, {
          code: `http_${statusCode}`,
          detail:
            statusCode === 413
              ? "The request body exceeds the configured size limit"
              : "The HTTP request was rejected",
          requestId: request.id,
          status: statusCode,
          title: "Request rejected",
          type: `https://proofstack.dev/problems/http-${statusCode}`,
        });
      }

      request.log.error({ error }, "Unhandled request error");
      return sendProblem(reply, {
        code: "internal_error",
        detail: "An unexpected error occurred",
        requestId: request.id,
        status: 500,
        title: "Internal server error",
        type: "https://proofstack.dev/problems/internal-error",
      });
    });

    await registerOtlpRoutes(app, {
      authenticator,
      compressedBodyLimitBytes: config.otlp.compressedBodyLimitBytes,
      decompressedBodyLimitBytes: config.otlp.decompressedBodyLimitBytes,
      ingestEvidence,
    });

    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
