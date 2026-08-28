import {
  PostgresConnectionStringError,
  validatePostgresConnectionString,
} from "@proofstack/postgres";
import { z } from "zod";

const DEVELOPMENT_AUTH_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const StorageConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("memory") }).strict(),
  z
    .object({
      databaseUrl: z.string().min(1),
      mode: z.literal("postgres"),
    })
    .strict(),
]);

const ApiConfigSchema = z
  .object({
    authMode: z.enum(["development", "api_key", "oidc"]),
    corsOrigin: z.string().url().optional(),
    environment: z.enum(["development", "test", "production"]),
    host: z.string().min(1),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
    port: z.number().int().min(1).max(65_535),
    storage: StorageConfigSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.environment === "production" && value.authMode === "development") {
      context.addIssue({
        code: "custom",
        message: "Development authentication is forbidden in production",
        path: ["authMode"],
      });
    }

    if (
      value.authMode === "development" &&
      !DEVELOPMENT_AUTH_LOOPBACK_HOSTS.has(value.host.toLowerCase())
    ) {
      context.addIssue({
        code: "custom",
        message: "Development authentication requires an explicit loopback host",
        path: ["host"],
      });
    }

    if (value.environment === "production" && value.storage.mode === "memory") {
      context.addIssue({
        code: "custom",
        message: "In-memory evidence storage is forbidden in production",
        path: ["storage", "mode"],
      });
    }

    if (value.storage.mode === "postgres") {
      try {
        validatePostgresConnectionString(value.storage.databaseUrl, {
          allowPlaintextLoopback: value.environment !== "production",
        });
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof PostgresConnectionStringError
              ? error.message
              : "PostgreSQL connection settings are invalid",
          path: ["storage", "databaseUrl"],
        });
      }
    }
  });

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

interface ProofStackEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_AUTH_MODE?: string;
  readonly PROOFSTACK_CORS_ORIGIN?: string;
  readonly PROOFSTACK_DATABASE_URL?: string;
  readonly PROOFSTACK_ENV?: string;
  readonly PROOFSTACK_HOST?: string;
  readonly PROOFSTACK_LOG_LEVEL?: string;
  readonly PROOFSTACK_PORT?: string;
  readonly PROOFSTACK_STORAGE_MODE?: string;
}

export function loadConfig(environment: ProofStackEnvironment = process.env): ApiConfig {
  return ApiConfigSchema.parse({
    authMode: environment.PROOFSTACK_AUTH_MODE ?? "development",
    corsOrigin: environment.PROOFSTACK_CORS_ORIGIN || undefined,
    environment: environment.PROOFSTACK_ENV ?? "development",
    host: environment.PROOFSTACK_HOST ?? "127.0.0.1",
    logLevel: environment.PROOFSTACK_LOG_LEVEL ?? "info",
    port: Number(environment.PROOFSTACK_PORT ?? "4318"),
    storage:
      environment.PROOFSTACK_STORAGE_MODE === "postgres"
        ? { databaseUrl: environment.PROOFSTACK_DATABASE_URL, mode: "postgres" }
        : { mode: environment.PROOFSTACK_STORAGE_MODE ?? "memory" },
  });
}
