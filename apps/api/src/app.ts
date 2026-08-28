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
} from "@proofstack/identity";
import {
  type Clock,
  EvidenceConflictError,
  type EvidenceRepository,
  ForbiddenError,
  IngestEvidence,
  InvalidTraceCursorError,
  ListTraceEvidence,
  SystemClock,
  TraceNotFoundError,
} from "@proofstack/core";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { ZodError } from "zod";
import { type Authenticator, AuthenticationRequiredError, createAuthenticator } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { createIdentityStorage, type IdentityStorage } from "./identity-storage.js";
import {
  type ApiKeyLifecycleService,
  IdentityManagementUnavailableError,
  registerIdentityRoutes,
} from "./identity-routes.js";
import { sendProblem } from "./problem.js";
import { registerRoutes } from "./routes.js";
import { createEvidenceStorage } from "./storage.js";

export interface AppDependencies {
  readonly apiKeyLifecycle?: ApiKeyLifecycleService;
  readonly authenticator?: Authenticator;
  readonly checkReadiness?: () => Promise<void>;
  readonly clock?: Clock;
  readonly identityStorage?: IdentityStorage;
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
  let authenticator = dependencies.authenticator;

  try {
    if (!authenticator && config.authMode !== "api_key") {
      authenticator = createAuthenticator(config);
    }

    const storage = dependencies.repository
      ? {
          checkReadiness: dependencies.checkReadiness ?? (async () => undefined),
          close: async () => undefined,
          repository: dependencies.repository,
        }
      : await createEvidenceStorage(config.storage, (error) => {
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
    if (!authenticator && config.authMode === "api_key") {
      if (!identityStorage) {
        throw new Error("API key identity storage is not configured; startup refused");
      }
      authenticator = createAuthenticator(config, {
        apiKeyCredentials: identityStorage.repository,
      });
    }
    authenticator ??= createAuthenticator(config);

    await app.register(helmet, {
      contentSecurityPolicy: false,
    });
    await app.register(cors, {
      credentials: false,
      origin: config.corsOrigin ?? false,
    });
    await app.register(rateLimit, {
      global: false,
    });

    await registerRoutes(app, {
      authenticator,
      checkReadiness: async () => {
        await storage.checkReadiness();
        await identityStorage?.checkReadiness();
      },
      ingestEvidence: new IngestEvidence(storage.repository, clock),
      listTraceEvidence: new ListTraceEvidence(storage.repository),
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
        reply.header("www-authenticate", 'Bearer realm="proofstack"');
        return sendProblem(reply, {
          code: "unauthenticated",
          detail: error.message,
          requestId: request.id,
          status: 401,
          title: "Authentication required",
          type: "https://proofstack.dev/problems/unauthenticated",
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

    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
