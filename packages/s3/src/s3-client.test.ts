import { NodeHttpHandler } from "@smithy/node-http-handler";
import { describe, expect, it } from "vitest";
import {
  createS3Client,
  DEFAULT_S3_CONNECTION_TIMEOUT_MS,
  DEFAULT_S3_REQUEST_TIMEOUT_MS,
  DEFAULT_S3_SOCKET_TIMEOUT_MS,
  resolveS3ClientConnectionOptions,
  S3ObjectStorageConfigurationError,
} from "./s3-client.js";

async function inspectClient(options: Parameters<typeof createS3Client>[0]) {
  const client = createS3Client(options);
  try {
    const handler = client.config.requestHandler;
    expect(handler).toBeInstanceOf(NodeHttpHandler);
    if (!(handler instanceof NodeHttpHandler)) throw new Error("unexpected request handler");
    return {
      endpoint: client.config.endpoint ? await client.config.endpoint() : undefined,
      forcePathStyle: client.config.forcePathStyle,
      maxAttempts: await client.config.maxAttempts(),
      region: await client.config.region(),
    };
  } finally {
    client.destroy();
  }
}

describe("createS3Client", () => {
  it("builds a bounded AWS client with secure defaults", async () => {
    const result = await inspectClient({ region: "ap-northeast-2" });
    const connection = resolveS3ClientConnectionOptions({ region: "ap-northeast-2" });

    expect(result).toMatchObject({
      endpoint: undefined,
      forcePathStyle: false,
      maxAttempts: 3,
      region: "ap-northeast-2",
    });
    expect(connection).toEqual({
      connectionTimeoutMs: DEFAULT_S3_CONNECTION_TIMEOUT_MS,
      region: "ap-northeast-2",
      requestTimeoutMs: DEFAULT_S3_REQUEST_TIMEOUT_MS,
      socketTimeoutMs: DEFAULT_S3_SOCKET_TIMEOUT_MS,
    });
  });

  it("accepts an HTTPS-compatible endpoint and explicit connection settings", async () => {
    const result = await inspectClient({
      connectionTimeoutMs: 1_000,
      endpoint: "https://storage.example.test:9443",
      forcePathStyle: true,
      region: "proofstack-1",
      requestTimeoutMs: 2_000,
      socketTimeoutMs: 1_500,
    });
    const connection = resolveS3ClientConnectionOptions({
      connectionTimeoutMs: 1_000,
      endpoint: "https://storage.example.test:9443",
      region: "proofstack-1",
      requestTimeoutMs: 2_000,
      socketTimeoutMs: 1_500,
    });

    expect(result.endpoint).toMatchObject({
      hostname: "storage.example.test",
      port: 9443,
      protocol: "https:",
    });
    expect(result).toMatchObject({
      forcePathStyle: true,
      region: "proofstack-1",
    });
    expect(connection).toEqual({
      connectionTimeoutMs: 1_000,
      endpoint: "https://storage.example.test:9443/",
      region: "proofstack-1",
      requestTimeoutMs: 2_000,
      socketTimeoutMs: 1_500,
    });
  });

  it("passes explicit credentials to the SDK without changing them", async () => {
    const credentials = {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      sessionToken: "test-session-token",
    };
    const client = createS3Client({ credentials, region: "local-1" });
    try {
      await expect(client.config.credentials()).resolves.toEqual(credentials);
    } finally {
      client.destroy();
    }
  });

  it.each(["http://localhost:9000", "http://127.0.0.1:9000", "http://[::1]:9000"])(
    "allows explicitly enabled loopback development endpoint %s",
    async (endpoint) => {
      const result = await inspectClient({
        allowInsecureLoopback: true,
        endpoint,
        forcePathStyle: true,
        region: "local-1",
      });

      expect(result.endpoint?.protocol).toBe("http:");
    },
  );

  it.each([
    "http://localhost:9000",
    "http://127.0.0.1:9000",
    "http://192.0.2.1:9000",
    "ftp://localhost:9000",
  ])("rejects an insecure endpoint outside the explicit loopback exception: %s", (endpoint) => {
    expect(() =>
      createS3Client({
        allowInsecureLoopback: endpoint.includes("192.0.2.1") || endpoint.startsWith("ftp:"),
        endpoint,
        region: "local-1",
      }),
    ).toThrow(S3ObjectStorageConfigurationError);
  });

  it.each([
    " https://storage.example.test",
    "https://user:secret@storage.example.test",
    "https://storage.example.test/path",
    "https://storage.example.test?query=yes",
    "https://storage.example.test#fragment",
    "not a URL",
    "",
  ])("rejects an ambiguous or credential-bearing endpoint: %s", (endpoint) => {
    expect(() => createS3Client({ endpoint, region: "local-1" })).toThrow(
      S3ObjectStorageConfigurationError,
    );
  });

  it.each(["", "a b", "region/one", "x".repeat(129)])("rejects invalid region %s", (region) => {
    expect(() => createS3Client({ region })).toThrow(S3ObjectStorageConfigurationError);
  });

  it.each([
    { connectionTimeoutMs: 0 },
    { requestTimeoutMs: 99 },
    { socketTimeoutMs: 300_001 },
    { requestTimeoutMs: 1.5 },
  ])("rejects an unbounded or invalid timeout %#", (timeouts) => {
    expect(() => createS3Client({ region: "local-1", ...timeouts })).toThrow(
      S3ObjectStorageConfigurationError,
    );
  });

  it("rejects non-boolean runtime policy values", () => {
    expect(() =>
      createS3Client({
        allowInsecureLoopback: "yes" as unknown as boolean,
        region: "local-1",
      }),
    ).toThrow(S3ObjectStorageConfigurationError);
    expect(() =>
      createS3Client({ forcePathStyle: "yes" as unknown as boolean, region: "local-1" }),
    ).toThrow(S3ObjectStorageConfigurationError);
  });
});
