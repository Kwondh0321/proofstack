import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactCipher } from "@proofstack/artifacts";
import { generateServiceToken } from "@proofstack/identity";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  loadPolicyWorkerAuthentication,
  loadPolicyWorkerRuntimeConfig,
  PolicyWorkerConfigurationError,
} from "./config.js";

const p = "PROOFSTACK_POLICY_WORKER_";
const token = generateServiceToken();
let root: string;
let sequence = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "proofstack-worker-config-"));
  await chmod(root, 0o700);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());
function environment(): NodeJS.ProcessEnv {
  return {
    PROOFSTACK_ENV: "test",
    [p + "SERVICE_TOKEN"]: token.value,
    [p + "CREDENTIALS_FILE"]: "/private/worker-credentials.json",
    [p + "DATABASE_URL"]: "postgresql://proofstack_policy_evaluator@127.0.0.1/proofstack_test",
    [p + "S3_BUCKET"]: "worker-config-test",
    [p + "S3_REGION"]: "us-east-1",
    [p + "S3_ACCESS_KEY_ID"]: "test-worker-access",
    [p + "S3_SECRET_ACCESS_KEY"]: "test-worker-secret",
    [p + "KEYRING_ACTIVE_KEY_ID"]: "key_config",
    [p + "KEYRING_KEYS"]: JSON.stringify({
      key_config: Buffer.alloc(32, 63).toString("base64url"),
    }),
  };
}
async function catalogue(value: unknown) {
  const path = join(root, `catalogue_${sequence++}.json`);
  await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  return path;
}
describe("bounded reference worker configuration", () => {
  it("loads private authentication channels without accepting token or principal argv", () => {
    expect(loadPolicyWorkerAuthentication(environment())).toEqual({
      token: token.value,
      credentialsFile: "/private/worker-credentials.json",
    });
  });
  it.each([undefined, "", " value ", "a".repeat(74), "한".repeat(25)])(
    "refuses missing/blank/over-byte authentication tokens %#",
    (value) => {
      const env = environment();
      env[p + "SERVICE_TOKEN"] = value;
      expect(() => loadPolicyWorkerAuthentication(env)).toThrow(PolicyWorkerConfigurationError);
    },
  );
  it.each(["relative.json", "/private/nul" + String.fromCharCode(0), "x".repeat(4097)])(
    "refuses unsafe credential file paths %#",
    (value) => {
      const env = environment();
      env[p + "CREDENTIALS_FILE"] = value;
      expect(() => loadPolicyWorkerAuthentication(env)).toThrow(PolicyWorkerConfigurationError);
    },
  );
  it("uses default process environment only when explicitly invoked without an override", async () => {
    for (const [key, value] of Object.entries(environment())) vi.stubEnv(key, value);
    expect(loadPolicyWorkerAuthentication().token).toBe(token.value);
    expect((await loadPolicyWorkerRuntimeConfig()).databaseUrl).toContain("proofstack_test");
  });
  it.each(["development", "test"])(
    "loads real cipher with explicit test credentials in %s",
    async (mode) => {
      const env = environment();
      env["PROOFSTACK_ENV"] = mode;
      const config = await loadPolicyWorkerRuntimeConfig(env);
      expect(config.encryption).toBeInstanceOf(ArtifactCipher);
      expect(config.catalogues).toEqual({});
      expect(config.objects).toMatchObject({
        bucket: "worker-config-test",
        region: "us-east-1",
        allowInsecureLoopback: true,
        forcePathStyle: false,
        credentials: { accessKeyId: "test-worker-access", secretAccessKey: "test-worker-secret" },
      });
      expect(config.databaseRole).toBeUndefined();
    },
  );
  it.each(["production", "staging", undefined])(
    "does not present local reference keys as production composition %#",
    async (mode) => {
      const env = environment();
      env["PROOFSTACK_ENV"] = mode;
      await expect(loadPolicyWorkerRuntimeConfig(env)).rejects.toBeInstanceOf(
        PolicyWorkerConfigurationError,
      );
    },
  );
  it.each([
    "DATABASE_URL",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "KEYRING_ACTIVE_KEY_ID",
    "KEYRING_KEYS",
  ])("requires explicit %s instead of falling back to ambient credentials", async (field) => {
    const env = environment();
    delete env[p + field];
    await expect(loadPolicyWorkerRuntimeConfig(env)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationError,
    );
  });
  it("retains explicit dedicated role, endpoint/owner and strict true path-style configuration", async () => {
    const env = {
      ...environment(),
      [p + "DATABASE_ROLE"]: "custom_policy_worker",
      [p + "S3_ENDPOINT"]: "http://127.0.0.1:8333",
      [p + "S3_EXPECTED_BUCKET_OWNER"]: "123456789012",
      [p + "S3_FORCE_PATH_STYLE"]: "true",
    };
    const config = await loadPolicyWorkerRuntimeConfig(env);
    expect(config.databaseRole).toBe("custom_policy_worker");
    expect(config.objects).toMatchObject({
      endpoint: "http://127.0.0.1:8333",
      expectedBucketOwner: "123456789012",
      forcePathStyle: true,
    });
  });
  it.each(["false", "invalid"])(
    "handles explicit path style %s without truthy coercion",
    async (value) => {
      const env = environment();
      env[p + "S3_FORCE_PATH_STYLE"] = value;
      if (value === "false")
        expect((await loadPolicyWorkerRuntimeConfig(env)).objects.forcePathStyle).toBe(false);
      else
        await expect(loadPolicyWorkerRuntimeConfig(env)).rejects.toBeInstanceOf(
          PolicyWorkerConfigurationError,
        );
    },
  );
  it.each([
    "",
    "{}",
    '{"invalid-key":"bad"}',
    JSON.stringify({ key_config: "invalid" }),
    JSON.stringify({ key_config: "A".repeat(42) + "B" }),
    "x".repeat(65537),
  ])("refuses malformed, absent or unbounded key material %#", async (value) => {
    const env = environment();
    env[p + "KEYRING_KEYS"] = value;
    const error = await loadPolicyWorkerRuntimeConfig(env).catch((error) => error);
    expect(error).toBeInstanceOf(PolicyWorkerConfigurationError);
    expect(error.message).toBe(
      "Policy worker configuration is invalid: PROOFSTACK_POLICY_WORKER_KEYRING_KEYS",
    );
  });
  it("retains keyring validation for duplicate material and absent active keys", async () => {
    for (const keys of [
      {
        key_one: Buffer.alloc(32, 8).toString("base64url"),
        key_two: Buffer.alloc(32, 8).toString("base64url"),
      },
      { key_other: Buffer.alloc(32, 9).toString("base64url") },
    ]) {
      const env = environment();
      env[p + "KEYRING_KEYS"] = JSON.stringify(keys);
      await expect(loadPolicyWorkerRuntimeConfig(env)).rejects.toBeInstanceOf(
        PolicyWorkerConfigurationError,
      );
    }
  });
  it.each([
    {},
    {
      installationBindings: [],
      runtimeDefinitions: [],
      implementationRegistrations: [],
      qualificationPolicies: [],
      endpointProfiles: [],
      protocolDefinitions: [],
    },
  ])("reads only an owner-protected strict installed catalogue %#", async (installed) => {
    const env = environment();
    env[p + "CATALOGUES_FILE"] = await catalogue(installed);
    expect((await loadPolicyWorkerRuntimeConfig(env)).catalogues).toEqual(installed);
  });
  it.each([
    { unknownAuthority: [] },
    { installationBindings: [{}] },
    { endpointProfiles: "invalid" },
  ])("refuses unknown/malformed installed catalogue %#", async (installed) => {
    const env = environment();
    env[p + "CATALOGUES_FILE"] = await catalogue(installed);
    await expect(loadPolicyWorkerRuntimeConfig(env)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationError,
    );
  });
  it("refuses an unsafe catalogue path and unsafe file permissions", async () => {
    const env = environment();
    env[p + "CATALOGUES_FILE"] = "relative.json";
    await expect(loadPolicyWorkerRuntimeConfig(env)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationError,
    );
    const path = await catalogue({});
    await chmod(path, 0o644);
    env[p + "CATALOGUES_FILE"] = path;
    await expect(loadPolicyWorkerRuntimeConfig(env)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationError,
    );
  });
  it("refuses empty optional settings rather than silently changing installation defaults", async () => {
    const env = environment();
    env[p + "DATABASE_ROLE"] = "";
    await expect(loadPolicyWorkerRuntimeConfig(env)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationError,
    );
  });
});
