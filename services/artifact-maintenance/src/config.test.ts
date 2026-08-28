import { describe, expect, it } from "vitest";
import {
  ArtifactMaintenanceConfigurationError,
  isArtifactMaintenanceCommand,
  loadArtifactMaintenanceConfig,
} from "./config.js";

function encodedKey(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64url");
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROOFSTACK_ARTIFACT_ABANDONED_BEFORE: "2026-08-28T00:00:00.000Z",
    PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID: "key_primary",
    PROOFSTACK_ARTIFACT_DATABASE_URL:
      "postgresql://proofstack_artifact_maintenance@127.0.0.1:5432/proofstack",
    PROOFSTACK_ARTIFACT_ENVIRONMENT_ID: "env_local",
    PROOFSTACK_ARTIFACT_KEYS: JSON.stringify({
      key_archived: encodedKey(2),
      key_primary: encodedKey(1),
    }),
    PROOFSTACK_ARTIFACT_OPERATOR_PRINCIPAL_ID: "svc_artifact_maintenance",
    PROOFSTACK_ARTIFACT_PROJECT_ID: "prj_local",
    PROOFSTACK_ARTIFACT_S3_BUCKET: "proofstack-artifacts",
    PROOFSTACK_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:8333",
    PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    PROOFSTACK_ARTIFACT_S3_REGION: "us-east-1",
    PROOFSTACK_ARTIFACT_TENANT_ID: "ten_local",
    PROOFSTACK_ENV: "development",
    ...overrides,
  };
}

describe("artifact maintenance configuration", () => {
  it("loads only the key inventory required by key-status", () => {
    const value = loadArtifactMaintenanceConfig(
      "key-status",
      environment({
        PROOFSTACK_ARTIFACT_S3_BUCKET: undefined,
        PROOFSTACK_ARTIFACT_S3_REGION: undefined,
      }),
    );

    expect(value).toMatchObject({
      batchLimit: 100,
      command: "key-status",
      deploymentEnvironment: "development",
      keyring: { activeKeyId: "key_primary" },
      scope: {
        environmentId: "env_local",
        operatorPrincipalId: "svc_artifact_maintenance",
        projectId: "prj_local",
        tenantId: "ten_local",
      },
    });
    if (value.command !== "key-status") throw new Error("unexpected command");
    expect(Object.keys(value.keyring.keys)).toEqual(["key_archived", "key_primary"]);
    expect(value).not.toHaveProperty("objectStorage");
  });

  it.each(["retention", "retry-purges"] as const)(
    "loads object storage without requiring key material for %s",
    (command) => {
      const value = loadArtifactMaintenanceConfig(
        command,
        environment({
          PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID: undefined,
          PROOFSTACK_ARTIFACT_KEYS: undefined,
          PROOFSTACK_ARTIFACT_S3_EXPECTED_BUCKET_OWNER: "123456789012",
        }),
      );
      expect(value).toMatchObject({
        batchLimit: 100,
        command,
        objectStorage: {
          bucket: "proofstack-artifacts",
          endpoint: "http://127.0.0.1:8333",
          expectedBucketOwner: "123456789012",
          forcePathStyle: true,
          region: "us-east-1",
        },
      });
      expect(value).not.toHaveProperty("keyring");
    },
  );

  it("loads reconciliation with a canonical threshold, storage, and keys", () => {
    const value = loadArtifactMaintenanceConfig(
      "reconcile",
      environment({ PROOFSTACK_ARTIFACT_BATCH_LIMIT: "7" }),
    );
    expect(value).toMatchObject({
      abandonedBefore: "2026-08-28T00:00:00.000Z",
      batchLimit: 7,
      command: "reconcile",
      keyring: { activeKeyId: "key_primary" },
      objectStorage: { forcePathStyle: true },
    });
  });

  it("loads abandoned cleanup without requiring keys", () => {
    const value = loadArtifactMaintenanceConfig(
      "cleanup-abandoned",
      environment({
        PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID: undefined,
        PROOFSTACK_ARTIFACT_KEYS: undefined,
      }),
    );
    expect(value).toMatchObject({
      abandonedBefore: "2026-08-28T00:00:00.000Z",
      command: "cleanup-abandoned",
    });
    expect(value).not.toHaveProperty("keyring");
  });

  it.each([
    [undefined, "Set PROOFSTACK_ENV"],
    ["staging", "development, test, or production"],
  ])("rejects an invalid deployment environment %s", (deployment, message) => {
    expect(() =>
      loadArtifactMaintenanceConfig("retention", environment({ PROOFSTACK_ENV: deployment })),
    ).toThrow(message);
  });

  it.each([
    ["PROOFSTACK_ARTIFACT_TENANT_ID", "bad-id"],
    ["PROOFSTACK_ARTIFACT_PROJECT_ID", "bad-id"],
    ["PROOFSTACK_ARTIFACT_ENVIRONMENT_ID", "bad-id"],
    ["PROOFSTACK_ARTIFACT_OPERATOR_PRINCIPAL_ID", "bad-id"],
  ])("rejects invalid scoped identity setting %s", (name, value) => {
    expect(() =>
      loadArtifactMaintenanceConfig("retention", environment({ [name]: value })),
    ).toThrow("valid opaque identifier");
  });

  it.each(["0", "101", "1.5", " 1"])("rejects invalid batch limit %s", (value) => {
    expect(() =>
      loadArtifactMaintenanceConfig(
        "retention",
        environment({ PROOFSTACK_ARTIFACT_BATCH_LIMIT: value }),
      ),
    ).toThrow("integer from 1 to 100");
  });

  it("requires verified database TLS outside exact non-production loopback", () => {
    expect(() =>
      loadArtifactMaintenanceConfig(
        "retention",
        environment({
          PROOFSTACK_ARTIFACT_DATABASE_URL:
            "postgresql://proofstack_artifact@db.example.test/proofstack",
        }),
      ),
    ).toThrow("sslmode=verify-full");
    expect(() =>
      loadArtifactMaintenanceConfig(
        "retention",
        environment({ PROOFSTACK_ARTIFACT_DATABASE_URL: "not-a-url" }),
      ),
    ).toThrow(ArtifactMaintenanceConfigurationError);
  });

  it.each(["yes", "TRUE", "0"])("rejects ambiguous S3 boolean %s", (value) => {
    expect(() =>
      loadArtifactMaintenanceConfig(
        "retention",
        environment({ PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: value }),
      ),
    ).toThrow("must be true or false");
  });

  it("accepts omitted optional S3 settings and an explicit false policy", () => {
    const value = loadArtifactMaintenanceConfig(
      "retention",
      environment({
        PROOFSTACK_ARTIFACT_S3_ENDPOINT: undefined,
        PROOFSTACK_ARTIFACT_S3_EXPECTED_BUCKET_OWNER: undefined,
        PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: "false",
      }),
    );
    if (value.command !== "retention") throw new Error("unexpected command");
    expect(value.objectStorage).toEqual({
      bucket: "proofstack-artifacts",
      forcePathStyle: false,
      region: "us-east-1",
    });
  });

  it.each(["invalid", "2026-08-28"])("rejects invalid cleanup timestamp %s", (value) => {
    expect(() =>
      loadArtifactMaintenanceConfig(
        "cleanup-abandoned",
        environment({ PROOFSTACK_ARTIFACT_ABANDONED_BEFORE: value }),
      ),
    ).toThrow("ISO 8601 timestamp");
  });

  it.each([
    "not-json",
    "[]",
    "{}",
    JSON.stringify({ "bad-id": encodedKey(1) }),
    JSON.stringify({ key_primary: "bad*" }),
    JSON.stringify({ key_primary: encodedKey(1), key_secondary: encodedKey(1) }),
    JSON.stringify({ key_other: encodedKey(1) }),
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`key_${index}`, encodedKey(index)]),
      ),
    ),
  ])("rejects an invalid local keyring %#", (value) => {
    expect(() =>
      loadArtifactMaintenanceConfig("key-status", environment({ PROOFSTACK_ARTIFACT_KEYS: value })),
    ).toThrow(ArtifactMaintenanceConfigurationError);
  });

  it("forbids local key material in production commands that require decryption", () => {
    expect(() =>
      loadArtifactMaintenanceConfig(
        "key-status",
        environment({
          PROOFSTACK_ARTIFACT_DATABASE_URL:
            "postgresql://proofstack_artifact@db.example.test/proofstack?sslmode=verify-full",
          PROOFSTACK_ENV: "production",
        }),
      ),
    ).toThrow("forbidden in production");
  });

  it("recognizes only supported one-shot commands", () => {
    for (const command of [
      "cleanup-abandoned",
      "key-status",
      "reconcile",
      "retention",
      "retry-purges",
    ]) {
      expect(isArtifactMaintenanceCommand(command)).toBe(true);
    }
    expect(isArtifactMaintenanceCommand("serve")).toBe(false);
    expect(isArtifactMaintenanceCommand(undefined)).toBe(false);
  });
});
