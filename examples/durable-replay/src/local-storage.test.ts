import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalBucketClient,
  type LocalArtifactStorageConfig,
  type LocalBucketClient,
  parseLocalArtifactStorageEnvironment,
  prepareLocalArtifactBucket,
} from "./local-storage.js";

const s3Double = vi.hoisted(() => ({
  destroy: vi.fn(),
  send: vi.fn(async () => ({})),
}));

vi.mock("@proofstack/s3", () => ({
  createS3Client: vi.fn(() => s3Double),
}));

const environment = {
  AWS_ACCESS_KEY_ID: "proofstack-local",
  AWS_SECRET_ACCESS_KEY: "proofstack-local-secret",
  PROOFSTACK_ARTIFACT_S3_BUCKET: "proofstack-local-durable-replay",
  PROOFSTACK_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:8333",
  PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
  PROOFSTACK_ARTIFACT_S3_REGION: "us-east-1",
  PROOFSTACK_ENV: "development",
};

const config: LocalArtifactStorageConfig = {
  accessKeyId: environment.AWS_ACCESS_KEY_ID,
  bucket: environment.PROOFSTACK_ARTIFACT_S3_BUCKET,
  endpoint: `${environment.PROOFSTACK_ARTIFACT_S3_ENDPOINT}/`,
  region: environment.PROOFSTACK_ARTIFACT_S3_REGION,
  secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
};

function client(send: LocalBucketClient["send"]): LocalBucketClient {
  return { destroy: vi.fn(), send };
}

describe("local durable replay storage", () => {
  it("parses the exact development-only loopback profile", () => {
    expect(parseLocalArtifactStorageEnvironment(environment)).toEqual(config);
  });

  it("builds a bounded loopback client and forwards lifecycle calls", async () => {
    const localClient = createLocalBucketClient(config);
    const command = new HeadBucketCommand({ Bucket: config.bucket });
    await expect(localClient.send(command)).resolves.toEqual({});
    localClient.destroy();
    expect(s3Double.send).toHaveBeenCalledWith(command);
    expect(s3Double.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["production mode", { PROOFSTACK_ENV: "production" }],
    ["remote endpoint", { PROOFSTACK_ARTIFACT_S3_ENDPOINT: "https://s3.example.test" }],
    ["non-local bucket", { PROOFSTACK_ARTIFACT_S3_BUCKET: "production-artifacts" }],
    ["virtual-host addressing", { PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: "false" }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseLocalArtifactStorageEnvironment({ ...environment, ...override })).toThrow();
  });

  it("leaves an existing bucket unchanged", async () => {
    const commands: (CreateBucketCommand | HeadBucketCommand)[] = [];
    const send: LocalBucketClient["send"] = async (command) => {
      commands.push(command);
      return {};
    };
    await expect(prepareLocalArtifactBucket(config, client(send))).resolves.toBe("existing");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(HeadBucketCommand);
  });

  it("creates only a confirmed missing bucket", async () => {
    const commands: (CreateBucketCommand | HeadBucketCommand)[] = [];
    const send: LocalBucketClient["send"] = async (command) => {
      commands.push(command);
      if (commands.length === 1) throw { $metadata: { httpStatusCode: 404 } };
      return {};
    };
    await expect(prepareLocalArtifactBucket(config, client(send))).resolves.toBe("created");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBeInstanceOf(CreateBucketCommand);
  });

  it("does not create after an ambiguous inspection failure", async () => {
    const send = vi.fn<LocalBucketClient["send"]>().mockRejectedValue(new Error("offline"));
    await expect(prepareLocalArtifactBucket(config, client(send))).rejects.toThrow(
      "could not be inspected",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sanitizes bucket-creation failures", async () => {
    let callCount = 0;
    const send: LocalBucketClient["send"] = async () => {
      callCount += 1;
      if (callCount === 1) throw { $metadata: { httpStatusCode: 404 } };
      throw new Error("provider detail");
    };
    await expect(prepareLocalArtifactBucket(config, client(send))).rejects.toThrow(
      "could not be created",
    );
  });
});
