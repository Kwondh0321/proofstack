import { z } from "zod";

const DEVELOPMENT_AUTH_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const ApiConfigSchema = z
  .object({
    authMode: z.enum(["development", "api_key", "oidc"]),
    corsOrigin: z.string().url().optional(),
    environment: z.enum(["development", "test", "production"]),
    host: z.string().min(1),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
    port: z.number().int().min(1).max(65_535),
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
  });

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

interface ProofStackEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_AUTH_MODE?: string;
  readonly PROOFSTACK_CORS_ORIGIN?: string;
  readonly PROOFSTACK_ENV?: string;
  readonly PROOFSTACK_HOST?: string;
  readonly PROOFSTACK_LOG_LEVEL?: string;
  readonly PROOFSTACK_PORT?: string;
}

export function loadConfig(environment: ProofStackEnvironment = process.env): ApiConfig {
  return ApiConfigSchema.parse({
    authMode: environment.PROOFSTACK_AUTH_MODE ?? "development",
    corsOrigin: environment.PROOFSTACK_CORS_ORIGIN || undefined,
    environment: environment.PROOFSTACK_ENV ?? "development",
    host: environment.PROOFSTACK_HOST ?? "127.0.0.1",
    logLevel: environment.PROOFSTACK_LOG_LEVEL ?? "info",
    port: Number(environment.PROOFSTACK_PORT ?? "4318"),
  });
}
