import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
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
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { ZodError } from "zod";
import { type Authenticator, createAuthenticator } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { sendProblem } from "./problem.js";
import { registerRoutes } from "./routes.js";

export interface AppDependencies {
  readonly authenticator?: Authenticator;
  readonly clock?: Clock;
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
  const repository = dependencies.repository ?? new MemoryEvidenceRepository();
  const clock = dependencies.clock ?? new SystemClock();
  const authenticator = dependencies.authenticator ?? createAuthenticator(config);

  const app = Fastify({
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    logController: new LogController({
      disableRequestLogging: config.environment === "test",
    }),
    logger: config.environment === "test" ? false : { level: config.logLevel },
    trustProxy: false,
  });

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
    ingestEvidence: new IngestEvidence(repository, clock),
    listTraceEvidence: new ListTraceEvidence(repository),
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
}
