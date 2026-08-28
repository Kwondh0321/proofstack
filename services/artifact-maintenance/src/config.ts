import {
  MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE,
  LocalArtifactKeyring,
  type LocalArtifactKeyringOptions,
} from "@proofstack/artifacts";
import { OpaqueIdSchema, TimestampSchema } from "@proofstack/contracts";
import {
  PostgresConnectionStringError,
  validatePostgresConnectionString,
} from "@proofstack/postgres";

export const ARTIFACT_MAINTENANCE_COMMANDS = [
  "cleanup-abandoned",
  "key-status",
  "reconcile",
  "retention",
  "retry-purges",
] as const;

export type ArtifactMaintenanceCommandName = (typeof ARTIFACT_MAINTENANCE_COMMANDS)[number];
export type ArtifactMaintenanceDeploymentEnvironment = "development" | "production" | "test";

interface ArtifactMaintenanceEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_ARTIFACT_ABANDONED_BEFORE?: string;
  readonly PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID?: string;
  readonly PROOFSTACK_ARTIFACT_BATCH_LIMIT?: string;
  readonly PROOFSTACK_ARTIFACT_DATABASE_URL?: string;
  readonly PROOFSTACK_ARTIFACT_ENVIRONMENT_ID?: string;
  readonly PROOFSTACK_ARTIFACT_KEYS?: string;
  readonly PROOFSTACK_ARTIFACT_OPERATOR_PRINCIPAL_ID?: string;
  readonly PROOFSTACK_ARTIFACT_PROJECT_ID?: string;
  readonly PROOFSTACK_ARTIFACT_S3_BUCKET?: string;
  readonly PROOFSTACK_ARTIFACT_S3_ENDPOINT?: string;
  readonly PROOFSTACK_ARTIFACT_S3_EXPECTED_BUCKET_OWNER?: string;
  readonly PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE?: string;
  readonly PROOFSTACK_ARTIFACT_S3_REGION?: string;
  readonly PROOFSTACK_ARTIFACT_TENANT_ID?: string;
  readonly PROOFSTACK_ENV?: string;
}

export interface ArtifactMaintenanceScopeConfig {
  readonly environmentId: string;
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly tenantId: string;
}

export interface ArtifactMaintenanceObjectStorageConfig {
  readonly bucket: string;
  readonly endpoint?: string;
  readonly expectedBucketOwner?: string;
  readonly forcePathStyle: boolean;
  readonly region: string;
}

interface ArtifactMaintenanceBaseConfig {
  readonly batchLimit: number;
  readonly databaseUrl: string;
  readonly deploymentEnvironment: ArtifactMaintenanceDeploymentEnvironment;
  readonly scope: ArtifactMaintenanceScopeConfig;
}

export interface CleanupAbandonedConfig extends ArtifactMaintenanceBaseConfig {
  readonly abandonedBefore: string;
  readonly command: "cleanup-abandoned";
  readonly objectStorage: ArtifactMaintenanceObjectStorageConfig;
}

export interface KeyStatusConfig extends ArtifactMaintenanceBaseConfig {
  readonly command: "key-status";
  readonly keyring: LocalArtifactKeyringOptions;
}

export interface ReconcileConfig extends ArtifactMaintenanceBaseConfig {
  readonly abandonedBefore: string;
  readonly command: "reconcile";
  readonly keyring: LocalArtifactKeyringOptions;
  readonly objectStorage: ArtifactMaintenanceObjectStorageConfig;
}

export interface RetentionConfig extends ArtifactMaintenanceBaseConfig {
  readonly command: "retention";
  readonly objectStorage: ArtifactMaintenanceObjectStorageConfig;
}

export interface RetryPurgesConfig extends ArtifactMaintenanceBaseConfig {
  readonly command: "retry-purges";
  readonly objectStorage: ArtifactMaintenanceObjectStorageConfig;
}

export type ArtifactMaintenanceConfig =
  | CleanupAbandonedConfig
  | KeyStatusConfig
  | ReconcileConfig
  | RetentionConfig
  | RetryPurgesConfig;

export class ArtifactMaintenanceConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactMaintenanceConfigurationError";
  }
}

function configurationError(
  message: string,
  cause?: unknown,
): ArtifactMaintenanceConfigurationError {
  return new ArtifactMaintenanceConfigurationError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function isArtifactMaintenanceCommand(
  value: string | undefined,
): value is ArtifactMaintenanceCommandName {
  return ARTIFACT_MAINTENANCE_COMMANDS.some((command) => command === value);
}

function required(
  environment: ArtifactMaintenanceEnvironment,
  name: keyof ArtifactMaintenanceEnvironment,
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw configurationError(
      `Set ${String(name)} to one non-empty value without surrounding space`,
    );
  }
  return value;
}

function deploymentEnvironment(
  environment: ArtifactMaintenanceEnvironment,
): ArtifactMaintenanceDeploymentEnvironment {
  const value = required(environment, "PROOFSTACK_ENV");
  if (value !== "development" && value !== "production" && value !== "test") {
    throw configurationError("PROOFSTACK_ENV must be development, test, or production");
  }
  return value;
}

function databaseUrl(
  environment: ArtifactMaintenanceEnvironment,
  deployment: ArtifactMaintenanceDeploymentEnvironment,
): string {
  try {
    return validatePostgresConnectionString(
      required(environment, "PROOFSTACK_ARTIFACT_DATABASE_URL"),
      { allowPlaintextLoopback: deployment !== "production" },
    );
  } catch (error) {
    if (error instanceof ArtifactMaintenanceConfigurationError) throw error;
    throw configurationError(
      error instanceof PostgresConnectionStringError
        ? error.message
        : "Artifact PostgreSQL connection settings are invalid",
      error,
    );
  }
}

function opaqueId(
  environment: ArtifactMaintenanceEnvironment,
  name: keyof ArtifactMaintenanceEnvironment,
): string {
  const value = required(environment, name);
  if (!OpaqueIdSchema.safeParse(value).success) {
    throw configurationError(`${String(name)} must be a valid opaque identifier`);
  }
  return value;
}

function batchLimit(environment: ArtifactMaintenanceEnvironment): number {
  const raw =
    environment.PROOFSTACK_ARTIFACT_BATCH_LIMIT ?? String(MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE);
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) {
    throw configurationError(
      `PROOFSTACK_ARTIFACT_BATCH_LIMIT must be an integer from 1 to ${MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE}`,
    );
  }
  const value = Number(raw);
  if (value > MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE) {
    throw configurationError(
      `PROOFSTACK_ARTIFACT_BATCH_LIMIT must be an integer from 1 to ${MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE}`,
    );
  }
  return value;
}

function scope(environment: ArtifactMaintenanceEnvironment): ArtifactMaintenanceScopeConfig {
  return {
    environmentId: opaqueId(environment, "PROOFSTACK_ARTIFACT_ENVIRONMENT_ID"),
    operatorPrincipalId: opaqueId(environment, "PROOFSTACK_ARTIFACT_OPERATOR_PRINCIPAL_ID"),
    projectId: opaqueId(environment, "PROOFSTACK_ARTIFACT_PROJECT_ID"),
    tenantId: opaqueId(environment, "PROOFSTACK_ARTIFACT_TENANT_ID"),
  };
}

function booleanSetting(
  environment: ArtifactMaintenanceEnvironment,
  name: keyof ArtifactMaintenanceEnvironment,
  fallback: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw configurationError(`${String(name)} must be true or false`);
}

function objectStorage(
  environment: ArtifactMaintenanceEnvironment,
): ArtifactMaintenanceObjectStorageConfig {
  const endpoint = environment.PROOFSTACK_ARTIFACT_S3_ENDPOINT;
  const expectedBucketOwner = environment.PROOFSTACK_ARTIFACT_S3_EXPECTED_BUCKET_OWNER;
  return {
    bucket: required(environment, "PROOFSTACK_ARTIFACT_S3_BUCKET"),
    ...(endpoint === undefined
      ? {}
      : { endpoint: required(environment, "PROOFSTACK_ARTIFACT_S3_ENDPOINT") }),
    ...(expectedBucketOwner === undefined
      ? {}
      : {
          expectedBucketOwner: required(
            environment,
            "PROOFSTACK_ARTIFACT_S3_EXPECTED_BUCKET_OWNER",
          ),
        }),
    forcePathStyle: booleanSetting(environment, "PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE", false),
    region: required(environment, "PROOFSTACK_ARTIFACT_S3_REGION"),
  };
}

function abandonedBefore(environment: ArtifactMaintenanceEnvironment): string {
  const value = required(environment, "PROOFSTACK_ARTIFACT_ABANDONED_BEFORE");
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw configurationError("PROOFSTACK_ARTIFACT_ABANDONED_BEFORE must be an ISO 8601 timestamp");
  }
  return new Date(parsed.data).toISOString();
}

function decodedKeyMaterial(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value
    ? Uint8Array.from(decoded)
    : undefined;
}

function localKeyring(
  environment: ArtifactMaintenanceEnvironment,
  deployment: ArtifactMaintenanceDeploymentEnvironment,
): LocalArtifactKeyringOptions {
  if (deployment === "production") {
    throw configurationError(
      "Local artifact keyring configuration is forbidden in production; compose an external key provider",
    );
  }
  const activeKeyId = opaqueId(environment, "PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID");
  let value: unknown;
  try {
    value = JSON.parse(required(environment, "PROOFSTACK_ARTIFACT_KEYS"));
  } catch (error) {
    throw configurationError("PROOFSTACK_ARTIFACT_KEYS must be a JSON object", error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configurationError("PROOFSTACK_ARTIFACT_KEYS must be a JSON object");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 8) {
    throw configurationError("PROOFSTACK_ARTIFACT_KEYS must contain from one to eight keys");
  }
  const keys: Record<string, Uint8Array> = {};
  for (const [keyId, encoded] of entries) {
    const material = decodedKeyMaterial(encoded);
    if (!OpaqueIdSchema.safeParse(keyId).success || !material) {
      throw configurationError(
        "PROOFSTACK_ARTIFACT_KEYS must map opaque key IDs to canonical base64url 32-byte keys",
      );
    }
    keys[keyId] = material;
  }
  try {
    new LocalArtifactKeyring({ activeKeyId, keys });
  } catch (error) {
    throw configurationError("PROOFSTACK_ARTIFACT_KEYS contains an invalid keyring", error);
  }
  return { activeKeyId, keys };
}

export function loadArtifactMaintenanceConfig(
  command: ArtifactMaintenanceCommandName,
  environment: ArtifactMaintenanceEnvironment = process.env,
): ArtifactMaintenanceConfig {
  const deployment = deploymentEnvironment(environment);
  const base: ArtifactMaintenanceBaseConfig = {
    batchLimit: batchLimit(environment),
    databaseUrl: databaseUrl(environment, deployment),
    deploymentEnvironment: deployment,
    scope: scope(environment),
  };
  if (command === "key-status") {
    return { ...base, command, keyring: localKeyring(environment, deployment) };
  }
  const storage = objectStorage(environment);
  if (command === "reconcile") {
    return {
      ...base,
      abandonedBefore: abandonedBefore(environment),
      command,
      keyring: localKeyring(environment, deployment),
      objectStorage: storage,
    };
  }
  if (command === "cleanup-abandoned") {
    return {
      ...base,
      abandonedBefore: abandonedBefore(environment),
      command,
      objectStorage: storage,
    };
  }
  return { ...base, command, objectStorage: storage };
}
