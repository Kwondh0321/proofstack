import { OpaqueIdSchema } from "@proofstack/contracts";
import {
  PostgresConnectionStringError,
  validatePostgresConnectionString,
} from "@proofstack/postgres";
import { z } from "zod";

const DEVELOPMENT_AUTH_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const DEFAULT_OTLP_BODY_LIMIT_BYTES = 1024 * 1024;
export const MAX_OTLP_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

const EncodedArtifactKeySchema = z.string().superRefine((value, context) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    context.addIssue({ code: "custom", message: "Artifact keys must use canonical base64url" });
    return;
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    context.addIssue({ code: "custom", message: "Artifact keys must encode exactly 32 bytes" });
  }
});

const LocalS3ArtifactStorageConfigSchema = z
  .object({
    activeKeyId: OpaqueIdSchema,
    allowInsecureLoopback: z.boolean(),
    bucket: z.string().min(3).max(63),
    endpoint: z.string().min(1).optional(),
    expectedBucketOwner: z
      .string()
      .regex(/^\d{12}$/)
      .optional(),
    forcePathStyle: z.boolean(),
    keys: z
      .record(OpaqueIdSchema, EncodedArtifactKeySchema)
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 8, {
        message: "Artifact keyring must contain from one to eight keys",
      })
      .refine((value) => new Set(Object.values(value)).size === Object.keys(value).length, {
        message: "Artifact key material must be unique",
      }),
    mode: z.literal("s3_local_keyring"),
    region: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    if (!(value.activeKeyId in value.keys)) {
      context.addIssue({
        code: "custom",
        message: "The active artifact key ID must exist in the configured keyring",
        path: ["activeKeyId"],
      });
    }
  });

const PostgresArtifactStorageConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  LocalS3ArtifactStorageConfigSchema,
]);

const StorageConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("memory") }).strict(),
  z
    .object({
      artifacts: PostgresArtifactStorageConfigSchema,
      databaseUrl: z.string().min(1),
      mode: z.literal("postgres"),
    })
    .strict(),
]);

const OidcConfigSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4_096),
    issuer: z.string().url().startsWith("https://").max(2_048),
    redirectUri: z.string().url().startsWith("https://").max(2_048),
    scopes: z.array(z.string().min(1).max(128)).min(1).max(20),
    transactionSecret: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .refine((value) => {
        const decoded = Buffer.from(value, "base64url");
        return decoded.length === 32 && decoded.toString("base64url") === value;
      }, "OIDC transaction secret must be canonical base64url for exactly 32 bytes"),
  })
  .strict();

const ApiConfigSchema = z
  .object({
    authMode: z.enum(["development", "api_key", "oidc", "combined"]),
    corsOrigin: z.string().url().optional(),
    environment: z.enum(["development", "test", "production"]),
    host: z.string().min(1),
    identityDatabaseUrl: z.string().min(1).optional(),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
    oidc: OidcConfigSchema.optional(),
    otlp: z
      .object({
        compressedBodyLimitBytes: z.number().int().min(1).max(MAX_OTLP_BODY_LIMIT_BYTES),
        decompressedBodyLimitBytes: z.number().int().min(1).max(MAX_OTLP_BODY_LIMIT_BYTES),
      })
      .strict(),
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

    if (
      value.environment === "production" &&
      value.storage.mode === "postgres" &&
      value.storage.artifacts.mode === "s3_local_keyring"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Local artifact keyring configuration is forbidden in production; compose an external key provider",
        path: ["storage", "artifacts", "mode"],
      });
    }

    if (value.authMode !== "development" && !value.identityDatabaseUrl) {
      context.addIssue({
        code: "custom",
        message: "Production authentication modes require PROOFSTACK_IDENTITY_DATABASE_URL",
        path: ["identityDatabaseUrl"],
      });
    }

    const usesOidc = value.authMode === "oidc" || value.authMode === "combined";
    if (value.corsOrigin) {
      const corsUrl = new URL(value.corsOrigin);
      if (value.corsOrigin !== corsUrl.origin) {
        context.addIssue({
          code: "custom",
          message: "CORS origin must contain only an exact scheme, host, and optional port",
          path: ["corsOrigin"],
        });
      }
      if (usesOidc && corsUrl.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "OIDC browser authentication requires an HTTPS CORS origin",
          path: ["corsOrigin"],
        });
      }
    }
    if (usesOidc && !value.oidc) {
      context.addIssue({
        code: "custom",
        message: "OIDC authentication requires complete PROOFSTACK_OIDC_* configuration",
        path: ["oidc"],
      });
    }
    if (!usesOidc && value.oidc) {
      context.addIssue({
        code: "custom",
        message: "OIDC configuration is only valid for oidc or combined authentication modes",
        path: ["oidc"],
      });
    }

    if (value.identityDatabaseUrl) {
      try {
        validatePostgresConnectionString(value.identityDatabaseUrl, {
          allowPlaintextLoopback: value.environment !== "production",
        });
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof PostgresConnectionStringError
              ? error.message
              : "Identity PostgreSQL connection settings are invalid",
          path: ["identityDatabaseUrl"],
        });
      }
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

      if (value.identityDatabaseUrl) {
        try {
          const evidenceRole = new URL(value.storage.databaseUrl).username;
          const identityRole = new URL(value.identityDatabaseUrl).username;
          if (evidenceRole === identityRole) {
            context.addIssue({
              code: "custom",
              message: "Evidence and identity PostgreSQL connections must use distinct roles",
              path: ["identityDatabaseUrl"],
            });
          }
        } catch {
          // The connection validators above report malformed URLs with their canonical messages.
        }
      }
    }
  });

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

interface ProofStackEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID?: string;
  readonly PROOFSTACK_ARTIFACT_KEYS?: string;
  readonly PROOFSTACK_ARTIFACT_S3_BUCKET?: string;
  readonly PROOFSTACK_ARTIFACT_S3_ENDPOINT?: string;
  readonly PROOFSTACK_ARTIFACT_S3_EXPECTED_BUCKET_OWNER?: string;
  readonly PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE?: string;
  readonly PROOFSTACK_ARTIFACT_S3_REGION?: string;
  readonly PROOFSTACK_ARTIFACT_STORAGE_MODE?: string;
  readonly PROOFSTACK_AUTH_MODE?: string;
  readonly PROOFSTACK_CORS_ORIGIN?: string;
  readonly PROOFSTACK_DATABASE_URL?: string;
  readonly PROOFSTACK_ENV?: string;
  readonly PROOFSTACK_HOST?: string;
  readonly PROOFSTACK_IDENTITY_DATABASE_URL?: string;
  readonly PROOFSTACK_LOG_LEVEL?: string;
  readonly PROOFSTACK_OIDC_CLIENT_ID?: string;
  readonly PROOFSTACK_OIDC_CLIENT_SECRET?: string;
  readonly PROOFSTACK_OIDC_ISSUER?: string;
  readonly PROOFSTACK_OIDC_REDIRECT_URI?: string;
  readonly PROOFSTACK_OIDC_SCOPES?: string;
  readonly PROOFSTACK_OIDC_TRANSACTION_SECRET?: string;
  readonly PROOFSTACK_OTLP_COMPRESSED_BODY_LIMIT_BYTES?: string;
  readonly PROOFSTACK_OTLP_DECOMPRESSED_BODY_LIMIT_BYTES?: string;
  readonly PROOFSTACK_PORT?: string;
  readonly PROOFSTACK_STORAGE_MODE?: string;
}

const ARTIFACT_STORAGE_SETTINGS = [
  "PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID",
  "PROOFSTACK_ARTIFACT_KEYS",
  "PROOFSTACK_ARTIFACT_S3_BUCKET",
  "PROOFSTACK_ARTIFACT_S3_ENDPOINT",
  "PROOFSTACK_ARTIFACT_S3_EXPECTED_BUCKET_OWNER",
  "PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE",
  "PROOFSTACK_ARTIFACT_S3_REGION",
] as const satisfies readonly (keyof ProofStackEnvironment)[];

function artifactStorageConfig(
  environment: ProofStackEnvironment,
  storageMode: string,
  deploymentEnvironment: string,
): unknown {
  const mode = environment.PROOFSTACK_ARTIFACT_STORAGE_MODE ?? "disabled";
  const hasSettings = ARTIFACT_STORAGE_SETTINGS.some((name) => environment[name] !== undefined);
  if (storageMode !== "postgres") {
    if (mode !== "disabled" || hasSettings) {
      throw new Error("Persistent artifact storage configuration requires PostgreSQL storage mode");
    }
    return undefined;
  }
  if (mode === "disabled") {
    if (hasSettings) {
      throw new Error(
        "Artifact storage settings require PROOFSTACK_ARTIFACT_STORAGE_MODE=s3_local_keyring",
      );
    }
    return { mode };
  }

  let keys: unknown;
  try {
    keys = JSON.parse(environment.PROOFSTACK_ARTIFACT_KEYS ?? "");
  } catch {
    keys = environment.PROOFSTACK_ARTIFACT_KEYS;
  }
  const forcePathStyle =
    environment.PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE === undefined
      ? false
      : environment.PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE === "true"
        ? true
        : environment.PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE === "false"
          ? false
          : environment.PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE;
  return {
    activeKeyId: environment.PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID,
    allowInsecureLoopback: deploymentEnvironment !== "production",
    bucket: environment.PROOFSTACK_ARTIFACT_S3_BUCKET,
    endpoint: environment.PROOFSTACK_ARTIFACT_S3_ENDPOINT || undefined,
    expectedBucketOwner: environment.PROOFSTACK_ARTIFACT_S3_EXPECTED_BUCKET_OWNER || undefined,
    forcePathStyle,
    keys,
    mode,
    region: environment.PROOFSTACK_ARTIFACT_S3_REGION,
  };
}

export function loadConfig(environment: ProofStackEnvironment = process.env): ApiConfig {
  const oidcConfigured = [
    environment.PROOFSTACK_OIDC_CLIENT_ID,
    environment.PROOFSTACK_OIDC_CLIENT_SECRET,
    environment.PROOFSTACK_OIDC_ISSUER,
    environment.PROOFSTACK_OIDC_REDIRECT_URI,
    environment.PROOFSTACK_OIDC_SCOPES,
    environment.PROOFSTACK_OIDC_TRANSACTION_SECRET,
  ].some((value) => value !== undefined);
  const storageMode = environment.PROOFSTACK_STORAGE_MODE ?? "memory";
  const deploymentEnvironment = environment.PROOFSTACK_ENV ?? "development";
  const artifacts = artifactStorageConfig(environment, storageMode, deploymentEnvironment);
  return ApiConfigSchema.parse({
    authMode: environment.PROOFSTACK_AUTH_MODE ?? "development",
    corsOrigin: environment.PROOFSTACK_CORS_ORIGIN || undefined,
    environment: deploymentEnvironment,
    host: environment.PROOFSTACK_HOST ?? "127.0.0.1",
    identityDatabaseUrl: environment.PROOFSTACK_IDENTITY_DATABASE_URL || undefined,
    logLevel: environment.PROOFSTACK_LOG_LEVEL ?? "info",
    oidc: oidcConfigured
      ? {
          clientId: environment.PROOFSTACK_OIDC_CLIENT_ID,
          clientSecret: environment.PROOFSTACK_OIDC_CLIENT_SECRET,
          issuer: environment.PROOFSTACK_OIDC_ISSUER,
          redirectUri: environment.PROOFSTACK_OIDC_REDIRECT_URI,
          scopes: (environment.PROOFSTACK_OIDC_SCOPES ?? "openid profile email")
            .trim()
            .split(/\s+/),
          transactionSecret: environment.PROOFSTACK_OIDC_TRANSACTION_SECRET,
        }
      : undefined,
    otlp: {
      compressedBodyLimitBytes: Number(
        environment.PROOFSTACK_OTLP_COMPRESSED_BODY_LIMIT_BYTES ?? DEFAULT_OTLP_BODY_LIMIT_BYTES,
      ),
      decompressedBodyLimitBytes: Number(
        environment.PROOFSTACK_OTLP_DECOMPRESSED_BODY_LIMIT_BYTES ?? DEFAULT_OTLP_BODY_LIMIT_BYTES,
      ),
    },
    port: Number(environment.PROOFSTACK_PORT ?? "4318"),
    storage:
      storageMode === "postgres"
        ? {
            artifacts,
            databaseUrl: environment.PROOFSTACK_DATABASE_URL,
            mode: "postgres",
          }
        : { mode: storageMode },
  });
}
