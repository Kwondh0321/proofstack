import { randomUUID } from "node:crypto";
import { CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { artifactObjectStoreConformanceCases } from "@proofstack/artifacts/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3ArtifactObjectStore } from "./s3-artifact-object-store.js";
import { createS3Client, type S3ClientConnectionOptions } from "./s3-client.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for S3 integration tests`);
  return value;
}

const connection: S3ClientConnectionOptions = {
  allowInsecureLoopback: true,
  credentials: {
    accessKeyId: requiredEnvironment("PROOFSTACK_TEST_S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY"),
  },
  endpoint: requiredEnvironment("PROOFSTACK_TEST_S3_ENDPOINT"),
  forcePathStyle: true,
  region: requiredEnvironment("PROOFSTACK_TEST_S3_REGION"),
};
const bucket = `proofstack-test-${randomUUID()}`;
const administrationClient = createS3Client(connection);

beforeAll(async () => {
  await administrationClient.send(new CreateBucketCommand({ Bucket: bucket }));
});

afterAll(async () => {
  try {
    await administrationClient.send(new DeleteBucketCommand({ Bucket: bucket }));
  } finally {
    administrationClient.destroy();
  }
});

describe("S3ArtifactObjectStore integration contract", () => {
  for (const testCase of artifactObjectStoreConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run((namespace) => {
        const store = createS3ArtifactObjectStore({ ...connection, bucket });
        return {
          store,
          dispose: async () => {
            try {
              await store.delete(`artifacts/${namespace}/content`);
            } finally {
              store.destroy();
            }
          },
        };
      });
    });
  }

  it("retains ciphertext across independent adapter client lifetimes", async () => {
    const key = "artifacts/client_restart/content";
    const ciphertext = Uint8Array.from([21, 34, 55, 89]);
    const writer = createS3ArtifactObjectStore({ ...connection, bucket });
    try {
      await expect(writer.putIfAbsent(key, ciphertext)).resolves.toMatchObject({ created: true });
    } finally {
      writer.destroy();
    }

    const reader = createS3ArtifactObjectStore({ ...connection, bucket });
    try {
      await expect(reader.get(key)).resolves.toEqual(ciphertext);
      await expect(reader.delete(key)).resolves.toEqual({ deleted: true });
    } finally {
      reader.destroy();
    }
  });
});
