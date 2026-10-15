import { isAbsolute } from "node:path";
import { z } from "zod";
import { ArtifactCipher, LocalArtifactKeyring } from "@proofstack/artifacts";
import { OpaqueIdSchema, PolicyInstallationBindingSchema } from "@proofstack/contracts";
import type { PostgresPolicyMetadataCatalogues } from "@proofstack/postgres";
import type { CreateS3ArtifactObjectStoreOptions } from "@proofstack/s3";
import { readPolicyWorkerJsonFile } from "./private-json-file.js";

const PREFIX = "PROOFSTACK_POLICY_WORKER_";
export class PolicyWorkerConfigurationError extends Error {
  constructor(
    readonly setting: string,
    options?: ErrorOptions,
  ) {
    super(`Policy worker configuration is invalid: ${setting}`, options);
    this.name = "PolicyWorkerConfigurationError";
  }
}
function required(environment: NodeJS.ProcessEnv, name: string, maximumBytes: number): string {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  )
    throw new PolicyWorkerConfigurationError(name);
  return value;
}
function optional(environment: NodeJS.ProcessEnv, name: string, maximumBytes: number) {
  return environment[name] === undefined ? undefined : required(environment, name, maximumBytes);
}
function filePath(value: string, setting: string) {
  if (!isAbsolute(value) || value.includes(String.fromCharCode(0)))
    throw new PolicyWorkerConfigurationError(setting);
  return value;
}
export function loadPolicyWorkerAuthentication(environment: NodeJS.ProcessEnv = process.env) {
  return {
    token: required(environment, PREFIX + "SERVICE_TOKEN", 73),
    credentialsFile: filePath(
      required(environment, PREFIX + "CREDENTIALS_FILE", 4096),
      PREFIX + "CREDENTIALS_FILE",
    ),
  };
}
const Catalogues = z
  .object({
    installationBindings: z.array(PolicyInstallationBindingSchema).optional(),
    runtimeDefinitions: z.array(z.unknown()).optional(),
    implementationRegistrations: z.array(z.unknown()).optional(),
    qualificationPolicies: z.array(z.unknown()).optional(),
    endpointProfiles: z.array(z.unknown()).optional(),
    protocolDefinitions: z.array(z.unknown()).optional(),
  })
  .strict();
export interface PolicyWorkerRuntimeConfig {
  readonly databaseUrl: string;
  readonly databaseRole?: string;
  readonly catalogues: PostgresPolicyMetadataCatalogues;
  readonly objects: CreateS3ArtifactObjectStoreOptions;
  readonly encryption: ArtifactCipher;
}
/** Reference local-key composition only; call after actual execution authentication. */
export async function loadPolicyWorkerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PolicyWorkerRuntimeConfig> {
  const mode = required(environment, "PROOFSTACK_ENV", 16);
  if (mode !== "development" && mode !== "test")
    throw new PolicyWorkerConfigurationError("PROOFSTACK_ENV");
  const databaseUrl = required(environment, PREFIX + "DATABASE_URL", 4096);
  const databaseRole = optional(environment, PREFIX + "DATABASE_ROLE", 63);
  const endpoint = optional(environment, PREFIX + "S3_ENDPOINT", 2048);
  const expectedBucketOwner = optional(environment, PREFIX + "S3_EXPECTED_BUCKET_OWNER", 12);
  const forcePathStyle = environment[PREFIX + "S3_FORCE_PATH_STYLE"] ?? "false";
  if (forcePathStyle !== "true" && forcePathStyle !== "false")
    throw new PolicyWorkerConfigurationError(PREFIX + "S3_FORCE_PATH_STYLE");
  const objects: CreateS3ArtifactObjectStoreOptions = {
    allowInsecureLoopback: true,
    bucket: required(environment, PREFIX + "S3_BUCKET", 63),
    region: required(environment, PREFIX + "S3_REGION", 128),
    credentials: {
      accessKeyId: required(environment, PREFIX + "S3_ACCESS_KEY_ID", 1024),
      secretAccessKey: required(environment, PREFIX + "S3_SECRET_ACCESS_KEY", 1024),
    },
    forcePathStyle: forcePathStyle === "true",
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(expectedBucketOwner === undefined ? {} : { expectedBucketOwner }),
  };
  let encryption: ArtifactCipher;
  try {
    const activeKeyId = required(environment, PREFIX + "KEYRING_ACTIVE_KEY_ID", 64);
    const encoded = z
      .record(OpaqueIdSchema, z.string())
      .parse(JSON.parse(required(environment, PREFIX + "KEYRING_KEYS", 64 * 1024)));
    const keys: Record<string, Buffer> = {};
    try {
      for (const [id, value] of Object.entries(encoded)) {
        const bytes = Buffer.from(value, "base64url");
        keys[id] = bytes;
        if (bytes.length !== 32 || bytes.toString("base64url") !== value)
          throw new PolicyWorkerConfigurationError(PREFIX + "KEYRING_KEYS");
      }
      encryption = new ArtifactCipher(new LocalArtifactKeyring({ activeKeyId, keys }));
    } finally {
      for (const key of Object.values(keys)) key.fill(0);
    }
  } catch (error) {
    throw new PolicyWorkerConfigurationError(PREFIX + "KEYRING_KEYS", { cause: error });
  }
  const filename = optional(environment, PREFIX + "CATALOGUES_FILE", 4096);
  let catalogues: PostgresPolicyMetadataCatalogues = {};
  if (filename !== undefined) {
    try {
      const parsed = Catalogues.parse(
        await readPolicyWorkerJsonFile(
          filePath(filename, PREFIX + "CATALOGUES_FILE"),
          16 * 1024 * 1024,
        ),
      );
      catalogues = {
        ...(parsed.installationBindings === undefined
          ? {}
          : { installationBindings: parsed.installationBindings }),
        ...(parsed.runtimeDefinitions === undefined
          ? {}
          : { runtimeDefinitions: parsed.runtimeDefinitions }),
        ...(parsed.implementationRegistrations === undefined
          ? {}
          : { implementationRegistrations: parsed.implementationRegistrations }),
        ...(parsed.qualificationPolicies === undefined
          ? {}
          : { qualificationPolicies: parsed.qualificationPolicies }),
        ...(parsed.endpointProfiles === undefined
          ? {}
          : { endpointProfiles: parsed.endpointProfiles }),
        ...(parsed.protocolDefinitions === undefined
          ? {}
          : { protocolDefinitions: parsed.protocolDefinitions }),
      };
    } catch (error) {
      throw new PolicyWorkerConfigurationError(PREFIX + "CATALOGUES_FILE", { cause: error });
    }
  }
  return {
    databaseUrl,
    ...(databaseRole === undefined ? {} : { databaseRole }),
    catalogues,
    objects,
    encryption,
  };
}
