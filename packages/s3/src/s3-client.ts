import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

export const DEFAULT_S3_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_S3_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_S3_SOCKET_TIMEOUT_MS = 30_000;

const MAX_TIMEOUT_MS = 300_000;
const MAX_REGION_LENGTH = 128;
const MAX_ENDPOINT_LENGTH = 2_048;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class S3ObjectStorageConfigurationError extends Error {
  override readonly name = "S3ObjectStorageConfigurationError";
}

export interface S3ClientConnectionOptions {
  readonly allowInsecureLoopback?: boolean;
  readonly connectionTimeoutMs?: number;
  readonly credentials?: S3ClientConfig["credentials"];
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly region: string;
  readonly requestTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
}

interface ResolvedS3ClientConnectionOptions {
  readonly connectionTimeoutMs: number;
  readonly endpoint?: string;
  readonly region: string;
  readonly requestTimeoutMs: number;
  readonly socketTimeoutMs: number;
}

function configurationError(message: string): S3ObjectStorageConfigurationError {
  return new S3ObjectStorageConfigurationError(message);
}

function validateRegion(region: string): string {
  if (
    typeof region !== "string" ||
    region.length === 0 ||
    region.length > MAX_REGION_LENGTH ||
    !/^[A-Za-z0-9._-]+$/.test(region)
  ) {
    throw configurationError("S3 region must be a bounded ASCII identifier");
  }
  return region;
}

function validateTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > MAX_TIMEOUT_MS) {
    throw configurationError(`${label} must be an integer from 100 to ${MAX_TIMEOUT_MS}`);
  }
  return timeout;
}

function validateEndpoint(endpoint: string, allowInsecureLoopback: boolean): string {
  if (
    typeof endpoint !== "string" ||
    endpoint.length === 0 ||
    endpoint.length > MAX_ENDPOINT_LENGTH ||
    endpoint.trim() !== endpoint
  ) {
    throw configurationError("S3 endpoint must be a bounded absolute URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw configurationError("S3 endpoint must be a valid absolute URL");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/"
  ) {
    throw configurationError("S3 endpoint must contain only a scheme, host, and optional port");
  }
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && allowInsecureLoopback && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return parsed.toString();
  }
  throw configurationError(
    "S3 endpoint must use HTTPS unless HTTP is explicitly enabled for an exact loopback host",
  );
}

export function resolveS3ClientConnectionOptions(
  options: S3ClientConnectionOptions,
): ResolvedS3ClientConnectionOptions {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  if (typeof allowInsecureLoopback !== "boolean") {
    throw configurationError("S3 loopback transport policy must be a boolean");
  }
  const resolved: ResolvedS3ClientConnectionOptions = {
    connectionTimeoutMs: validateTimeout(
      options.connectionTimeoutMs,
      DEFAULT_S3_CONNECTION_TIMEOUT_MS,
      "S3 connection timeout",
    ),
    region: validateRegion(options.region),
    requestTimeoutMs: validateTimeout(
      options.requestTimeoutMs,
      DEFAULT_S3_REQUEST_TIMEOUT_MS,
      "S3 request timeout",
    ),
    socketTimeoutMs: validateTimeout(
      options.socketTimeoutMs,
      DEFAULT_S3_SOCKET_TIMEOUT_MS,
      "S3 socket timeout",
    ),
  };
  if (options.endpoint !== undefined) {
    return {
      ...resolved,
      endpoint: validateEndpoint(options.endpoint, allowInsecureLoopback),
    };
  }
  return resolved;
}

export function createS3Client(options: S3ClientConnectionOptions): S3Client {
  if (options.forcePathStyle !== undefined && typeof options.forcePathStyle !== "boolean") {
    throw configurationError("S3 path-style policy must be a boolean");
  }
  const resolved = resolveS3ClientConnectionOptions(options);

  const configuration: S3ClientConfig = {
    maxAttempts: 3,
    region: resolved.region,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: resolved.connectionTimeoutMs,
      requestTimeout: resolved.requestTimeoutMs,
      socketTimeout: resolved.socketTimeoutMs,
      throwOnRequestTimeout: true,
    }),
  };
  if (options.credentials !== undefined) configuration.credentials = options.credentials;
  if (resolved.endpoint !== undefined) configuration.endpoint = resolved.endpoint;
  if (options.forcePathStyle !== undefined) configuration.forcePathStyle = options.forcePathStyle;
  return new S3Client(configuration);
}
