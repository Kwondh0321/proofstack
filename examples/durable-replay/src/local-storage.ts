import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "@proofstack/s3";
import { z } from "zod";

const LOCAL_BUCKET_PREFIX = "proofstack-local-";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const LocalStorageEnvironmentSchema = z
  .object({
    AWS_ACCESS_KEY_ID: z.string().min(1).max(128),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).max(256),
    PROOFSTACK_ARTIFACT_S3_BUCKET: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
    PROOFSTACK_ARTIFACT_S3_ENDPOINT: z.string().url().max(2_048),
    PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: z.literal("true"),
    PROOFSTACK_ARTIFACT_S3_REGION: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    PROOFSTACK_ENV: z.literal("development"),
  })
  .strict();

export interface LocalArtifactStorageConfig {
  readonly accessKeyId: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly secretAccessKey: string;
}

export interface LocalArtifactStorageEnvironment {
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly PROOFSTACK_ARTIFACT_S3_BUCKET?: string;
  readonly PROOFSTACK_ARTIFACT_S3_ENDPOINT?: string;
  readonly PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE?: string;
  readonly PROOFSTACK_ARTIFACT_S3_REGION?: string;
  readonly PROOFSTACK_ENV?: string;
}

export interface LocalBucketClient {
  destroy(): void;
  send(command: CreateBucketCommand | HeadBucketCommand): Promise<unknown>;
}

export type LocalBucketPreparation = "created" | "existing";

function localEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TypeError("The durable replay setup endpoint must be an exact HTTP loopback origin");
  }
  return endpoint.toString();
}

export function parseLocalArtifactStorageEnvironment(
  environment: LocalArtifactStorageEnvironment,
): LocalArtifactStorageConfig {
  const selected = LocalStorageEnvironmentSchema.parse({
    AWS_ACCESS_KEY_ID: environment.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: environment.AWS_SECRET_ACCESS_KEY,
    PROOFSTACK_ARTIFACT_S3_BUCKET: environment.PROOFSTACK_ARTIFACT_S3_BUCKET,
    PROOFSTACK_ARTIFACT_S3_ENDPOINT: environment.PROOFSTACK_ARTIFACT_S3_ENDPOINT,
    PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: environment.PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE,
    PROOFSTACK_ARTIFACT_S3_REGION: environment.PROOFSTACK_ARTIFACT_S3_REGION,
    PROOFSTACK_ENV: environment.PROOFSTACK_ENV,
  });
  if (!selected.PROOFSTACK_ARTIFACT_S3_BUCKET.startsWith(LOCAL_BUCKET_PREFIX)) {
    throw new TypeError(`The local artifact bucket must start with ${LOCAL_BUCKET_PREFIX}`);
  }
  return Object.freeze({
    accessKeyId: selected.AWS_ACCESS_KEY_ID,
    bucket: selected.PROOFSTACK_ARTIFACT_S3_BUCKET,
    endpoint: localEndpoint(selected.PROOFSTACK_ARTIFACT_S3_ENDPOINT),
    region: selected.PROOFSTACK_ARTIFACT_S3_REGION,
    secretAccessKey: selected.AWS_SECRET_ACCESS_KEY,
  });
}

function missingBucket(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const metadata = "$metadata" in error ? error.$metadata : undefined;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === 404
  );
}

export function createLocalBucketClient(config: LocalArtifactStorageConfig): LocalBucketClient {
  const client = createS3Client({
    allowInsecureLoopback: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: true,
    region: config.region,
  });
  return {
    destroy: () => client.destroy(),
    send: async (command) => client.send(command),
  };
}

export async function prepareLocalArtifactBucket(
  config: LocalArtifactStorageConfig,
  client: LocalBucketClient = createLocalBucketClient(config),
): Promise<LocalBucketPreparation> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return "existing";
  } catch (error) {
    if (!missingBucket(error)) {
      throw new Error("The local artifact bucket could not be inspected", { cause: error });
    }
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    return "created";
  } catch (error) {
    throw new Error("The local artifact bucket could not be created", { cause: error });
  }
}
