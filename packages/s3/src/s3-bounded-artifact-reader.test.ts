import { createHash } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { GetObjectCommand, type GetObjectCommandOutput, type S3Client } from "@aws-sdk/client-s3";
import { MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES } from "@proofstack/artifacts";
import { describe, expect, it, vi } from "vitest";
import {
  createS3BoundedArtifactReader,
  S3ArtifactObjectStore,
  S3ArtifactObjectInputError,
  S3ArtifactObjectIntegrityError,
  S3ArtifactObjectStoreError,
} from "./s3-artifact-object-store.js";

const bytes = Uint8Array.from([1, 2, 3]);
const checksum = createHash("sha256").update(bytes).digest("base64");
function body() {
  const value = {
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
  return value as unknown as typeof value & NonNullable<GetObjectCommandOutput["Body"]>;
}
function model(output: Partial<GetObjectCommandOutput> | (() => Partial<GetObjectCommandOutput>)) {
  const send = vi.fn(async () => ({
    $metadata: { httpStatusCode: 200 },
    ...(typeof output === "function" ? output() : output),
  }));
  const store = new S3ArtifactObjectStore({ send, destroy: vi.fn() } as unknown as S3Client, {
    bucket: "proofstack-test",
  });
  return { store, send };
}
async function withEndpoint(
  handler: RequestListener,
  operation: (endpoint: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected isolated test port");
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
const options = {
  bucket: "proofstack-test",
  region: "local-1",
  allowInsecureLoopback: true,
  forcePathStyle: true,
  credentials: { accessKeyId: "proofstack-fixture", secretAccessKey: "proofstack-fixture-only" },
  connectionTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  socketTimeoutMs: 1000,
} as const;

describe("request-bounded artifact reads", () => {
  it.each([undefined, 201, 206])(
    "rejects an unsupported or incomplete HTTP response status %s",
    async (httpStatusCode) => {
      const response = body();
      const { store } = model({
        Body: response,
        ContentLength: 3,
        $metadata: httpStatusCode === undefined ? {} : { httpStatusCode },
      });
      await expect(
        store.getBounded("objects/v1/exact", {
          expectedBytes: 3,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(S3ArtifactObjectIntegrityError);
      expect(response.destroy).toHaveBeenCalledOnce();
    },
  );
  it("rejects missing SDK response metadata and releases the body", async () => {
    const response = body();
    const { store } = model({
      Body: response,
      ContentLength: 3,
      $metadata: undefined,
    } as unknown as Partial<GetObjectCommandOutput>);
    await expect(
      store.getBounded("objects/v1/exact", {
        expectedBytes: 3,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(S3ArtifactObjectIntegrityError);
    expect(response.destroy).toHaveBeenCalledOnce();
  });
  it("requires the complete range even when an HTTP partial response has the right byte length", async () => {
    const { store } = model({
      Body: body(),
      ContentLength: 3,
      ContentRange: "bytes 0-2/3",
      $metadata: { httpStatusCode: 206 },
    });
    await expect(
      store.getBounded("objects/v1/exact", {
        expectedBytes: 3,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(bytes);
  });
  it.each([undefined, "bytes 0-2/3"])(
    "accepts a complete exact-size body/range %s",
    async (ContentRange) => {
      const { store, send } = model({
        Body: body(),
        ContentLength: 3,
        ContentRange,
        ChecksumSHA256: checksum,
      });
      const signal = new AbortController().signal;
      await expect(
        store.getBounded("objects/v1/exact", { expectedBytes: 3, signal }),
      ).resolves.toEqual(bytes);
      expect(send).toHaveBeenCalledWith(expect.any(GetObjectCommand), { abortSignal: signal });
      expect((send.mock.calls[0] as unknown as [GetObjectCommand])[0].input.Range).toBe(
        "bytes=0-2",
      );
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES + 1])(
    "rejects invalid bound %s before sending",
    async (expectedBytes) => {
      const { store, send } = model({ Body: body(), ContentLength: 3 });
      await expect(
        store.getBounded("objects/v1/exact", {
          expectedBytes,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(S3ArtifactObjectInputError);
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("requires an actual abort signal before sending", async () => {
    const { store, send } = model({});
    await expect(
      store.getBounded("objects/v1/exact", { expectedBytes: 3, signal: {} as AbortSignal }),
    ).rejects.toBeInstanceOf(S3ArtifactObjectInputError);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects an already aborted read before sending", async () => {
    const { store, send } = model({});
    const controller = new AbortController();
    const failure = new Error("Read expired");
    controller.abort(failure);
    await expect(
      store.getBounded("objects/v1/exact", { expectedBytes: 3, signal: controller.signal }),
    ).rejects.toBe(failure);
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { ContentLength: 2 },
    { ContentLength: 4 },
    { ContentLength: 3, ContentRange: "bytes 0-2/4" },
    { ContentLength: 3, ContentRange: "bytes 1-3/4" },
    { ContentLength: 3, ContentRange: "bytes 0-2/*" },
    { ContentLength: 3, ContentRange: "bytes 00-2/3" },
  ])("rejects an incomplete or substituted full-object geometry %#", async (metadata) => {
    const response = body();
    const { store } = model({ Body: response, ...metadata });
    await expect(
      store.getBounded("objects/v1/exact", {
        expectedBytes: 3,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(S3ArtifactObjectIntegrityError);
    expect(response?.destroy).toHaveBeenCalledOnce();
  });
  it("retains the original bound even if the caller changes its options while sending", async () => {
    const bound = { expectedBytes: 3, signal: new AbortController().signal };
    const { store } = model(() => {
      bound.expectedBytes = 4;
      return { Body: body(), ContentLength: 3, ContentRange: "bytes 0-2/3" };
    });
    await expect(store.getBounded("objects/v1/exact", bound)).resolves.toEqual(bytes);
  });
  it("releases a response arriving after abort and preserves its cause", async () => {
    const controller = new AbortController();
    const failure = new Error("Expired after dispatch");
    const response = body();
    const { store } = model(() => {
      controller.abort(failure);
      return { Body: response, ContentLength: 3 };
    });
    await expect(
      store.getBounded("objects/v1/exact", { expectedBytes: 3, signal: controller.signal }),
    ).rejects.toBeInstanceOf(S3ArtifactObjectStoreError);
    expect(response?.destroy).toHaveBeenCalledOnce();
  });
  it("returns null for an exact-key delete marker", async () => {
    const { store } = model({ DeleteMarker: true, Body: body() });
    await expect(
      store.getBounded("objects/v1/exact", {
        expectedBytes: 3,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
  });
  it("makes exactly one SDK attempt against a retryable HTTP failure", async () => {
    let requests = 0;
    await withEndpoint(
      (_request, response) => {
        requests++;
        response.writeHead(503, { "content-type": "application/xml" });
        response.end("<Error><Code>ServiceUnavailable</Code></Error>");
      },
      async (endpoint) => {
        const reader = createS3BoundedArtifactReader({ ...options, endpoint, maxAttempts: 3 });
        try {
          await expect(
            reader.get("objects/v1/exact", { expectedBytes: 3, signal: AbortSignal.timeout(1000) }),
          ).rejects.toBeInstanceOf(S3ArtifactObjectStoreError);
        } finally {
          reader.destroy();
        }
      },
    );
    expect(requests).toBe(1);
  });
  it("reads exact full objects through the real HTTP handler", async () => {
    await withEndpoint(
      (request, response) => {
        expect(request.headers.range).toBe("bytes=0-2");
        response.writeHead(206, {
          "content-length": "3",
          "content-range": "bytes 0-2/3",
          "x-amz-checksum-sha256": checksum,
        });
        response.end(bytes);
      },
      async (endpoint) => {
        const reader = createS3BoundedArtifactReader({ ...options, endpoint });
        try {
          await expect(
            reader.get("objects/v1/exact", { expectedBytes: 3, signal: AbortSignal.timeout(1000) }),
          ).resolves.toEqual(bytes);
        } finally {
          reader.destroy();
        }
      },
    );
  });
  it("aborts an unfinished body and closes its actual connection", async () => {
    const controller = new AbortController();
    let acknowledgeClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      acknowledgeClosed = resolve;
    });
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    await withEndpoint(
      (request, response) => {
        request.socket.once("close", acknowledgeClosed);
        response.writeHead(200, { "content-length": "3" });
        response.write(Uint8Array.from([1]));
        abortTimer = setTimeout(() => controller.abort(new Error("Body lease expired")), 25);
      },
      async (endpoint) => {
        const reader = createS3BoundedArtifactReader({ ...options, endpoint });
        try {
          await expect(
            reader.get("objects/v1/exact", { expectedBytes: 3, signal: controller.signal }),
          ).rejects.toBeInstanceOf(S3ArtifactObjectStoreError);
          // Prove reader abort closed the socket before fixture cleanup or client destruction.
          await closed;
        } finally {
          clearTimeout(abortTimer);
          reader.destroy();
        }
      },
    );
  });
});
