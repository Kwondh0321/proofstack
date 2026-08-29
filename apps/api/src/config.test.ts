import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const OIDC_ENV = {
  PROOFSTACK_OIDC_CLIENT_ID: "proofstack-console",
  PROOFSTACK_OIDC_CLIENT_SECRET: "provider-client-secret",
  PROOFSTACK_OIDC_ISSUER: "https://identity.example.test/tenant",
  PROOFSTACK_OIDC_REDIRECT_URI: "https://proofstack.example.test/v1/auth/oidc/callback",
  PROOFSTACK_OIDC_SCOPES: "openid profile email",
  PROOFSTACK_OIDC_TRANSACTION_SECRET: "A".repeat(43),
} as const;

function artifactEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID: "key_primary",
    PROOFSTACK_ARTIFACT_KEYS: JSON.stringify({
      key_archived: Buffer.alloc(32, 2).toString("base64url"),
      key_primary: Buffer.alloc(32, 1).toString("base64url"),
    }),
    PROOFSTACK_ARTIFACT_S3_BUCKET: "proofstack-artifacts",
    PROOFSTACK_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:8333",
    PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    PROOFSTACK_ARTIFACT_S3_REGION: "us-east-1",
    PROOFSTACK_ARTIFACT_STORAGE_MODE: "s3_local_keyring",
    PROOFSTACK_DATABASE_URL: "postgresql://runtime@127.0.0.1:5432/proofstack",
    PROOFSTACK_STORAGE_MODE: "postgres",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads safe development defaults", () => {
    expect(loadConfig({})).toMatchObject({
      authMode: "development",
      environment: "development",
      host: "127.0.0.1",
      otlp: {
        compressedBodyLimitBytes: 1024 * 1024,
        decompressedBodyLimitBytes: 1024 * 1024,
      },
      port: 4318,
      storage: { mode: "memory" },
    });
  });

  it("rejects development authentication in production", () => {
    expect(() =>
      loadConfig({ PROOFSTACK_AUTH_MODE: "development", PROOFSTACK_ENV: "production" }),
    ).toThrow("Development authentication is forbidden in production");
  });

  it("rejects development authentication on a non-loopback listener", () => {
    expect(() => loadConfig({ PROOFSTACK_HOST: "0.0.0.0" })).toThrow(
      "Development authentication requires an explicit loopback host",
    );
  });

  it("allows a non-loopback listener only with a production authenticator", () => {
    expect(
      loadConfig({
        ...OIDC_ENV,
        PROOFSTACK_AUTH_MODE: "oidc",
        PROOFSTACK_DATABASE_URL:
          "postgresql://runtime@db.example.com/proofstack?sslmode=verify-full",
        PROOFSTACK_ENV: "production",
        PROOFSTACK_HOST: "0.0.0.0",
        PROOFSTACK_IDENTITY_DATABASE_URL:
          "postgresql://identity@db.example.com/proofstack?sslmode=verify-full",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toMatchObject({ authMode: "oidc", host: "0.0.0.0" });
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ PROOFSTACK_PORT: "70000" })).toThrow();
  });

  it("loads bounded OTLP compressed and decompressed body limits", () => {
    expect(
      loadConfig({
        PROOFSTACK_OTLP_COMPRESSED_BODY_LIMIT_BYTES: "2097152",
        PROOFSTACK_OTLP_DECOMPRESSED_BODY_LIMIT_BYTES: "8388608",
      }),
    ).toMatchObject({
      otlp: {
        compressedBodyLimitBytes: 2 * 1024 * 1024,
        decompressedBodyLimitBytes: 8 * 1024 * 1024,
      },
    });
  });

  it.each(["0", "1.5", `${64 * 1024 * 1024 + 1}`, "not-a-number"])(
    "rejects invalid OTLP body limit %s",
    (value) => {
      expect(() => loadConfig({ PROOFSTACK_OTLP_DECOMPRESSED_BODY_LIMIT_BYTES: value })).toThrow();
      expect(() => loadConfig({ PROOFSTACK_OTLP_COMPRESSED_BODY_LIMIT_BYTES: value })).toThrow();
    },
  );

  it("loads loopback PostgreSQL storage explicitly", () => {
    expect(
      loadConfig({
        PROOFSTACK_DATABASE_URL: "postgresql://runtime@127.0.0.1:5432/proofstack",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toMatchObject({
      storage: {
        artifacts: { mode: "disabled" },
        databaseUrl: "postgresql://runtime@127.0.0.1:5432/proofstack",
        mode: "postgres",
      },
    });
  });

  it("loads explicit persistent artifact storage with canonical local key material", () => {
    expect(loadConfig(artifactEnvironment())).toMatchObject({
      storage: {
        artifacts: {
          activeKeyId: "key_primary",
          allowInsecureLoopback: true,
          bucket: "proofstack-artifacts",
          endpoint: "http://127.0.0.1:8333",
          forcePathStyle: true,
          keys: {
            key_archived: expect.any(String),
            key_primary: expect.any(String),
          },
          mode: "s3_local_keyring",
          region: "us-east-1",
        },
        mode: "postgres",
      },
    });
  });

  it("rejects partial, ambiguous, or invalid persistent artifact storage", () => {
    expect(() =>
      loadConfig({
        PROOFSTACK_ARTIFACT_S3_BUCKET: "proofstack-artifacts",
        PROOFSTACK_DATABASE_URL: "postgresql://runtime@127.0.0.1:5432/proofstack",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toThrow("PROOFSTACK_ARTIFACT_STORAGE_MODE=s3_local_keyring");
    expect(() =>
      loadConfig(artifactEnvironment({ PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: "sometimes" })),
    ).toThrow();
    expect(() =>
      loadConfig(artifactEnvironment({ PROOFSTACK_ARTIFACT_KEYS: "not-json" })),
    ).toThrow();
    expect(() =>
      loadConfig(
        artifactEnvironment({
          PROOFSTACK_ARTIFACT_KEYS: JSON.stringify({
            key_primary: Buffer.alloc(31, 1).toString("base64url"),
          }),
        }),
      ),
    ).toThrow("32 bytes");
    expect(() =>
      loadConfig(
        artifactEnvironment({
          PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID: "key_missing",
        }),
      ),
    ).toThrow("active artifact key ID");
  });

  it("rejects persistent artifact settings in memory mode and local keys in production", () => {
    expect(() =>
      loadConfig({
        PROOFSTACK_ARTIFACT_S3_BUCKET: "proofstack-artifacts",
      }),
    ).toThrow("requires PostgreSQL storage mode");
    expect(() =>
      loadConfig(
        artifactEnvironment({
          ...OIDC_ENV,
          PROOFSTACK_AUTH_MODE: "oidc",
          PROOFSTACK_DATABASE_URL:
            "postgresql://runtime@db.example.test/proofstack?sslmode=verify-full",
          PROOFSTACK_ENV: "production",
          PROOFSTACK_IDENTITY_DATABASE_URL:
            "postgresql://identity@db.example.test/proofstack?sslmode=verify-full",
          PROOFSTACK_ARTIFACT_S3_ENDPOINT: "https://objects.example.test",
        }),
      ),
    ).toThrow("forbidden in production");
  });

  it("requires a database URL when PostgreSQL storage is selected", () => {
    expect(() => loadConfig({ PROOFSTACK_STORAGE_MODE: "postgres" })).toThrow();
  });

  it("rejects unverified remote PostgreSQL connections", () => {
    expect(() =>
      loadConfig({
        PROOFSTACK_DATABASE_URL: "postgresql://runtime@db.example.com/proofstack",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toThrow("sslmode=verify-full");
  });

  it("forbids process-local storage in production", () => {
    expect(() =>
      loadConfig({
        ...OIDC_ENV,
        PROOFSTACK_AUTH_MODE: "oidc",
        PROOFSTACK_ENV: "production",
        PROOFSTACK_IDENTITY_DATABASE_URL:
          "postgresql://identity@db.example.com/proofstack?sslmode=verify-full",
      }),
    ).toThrow("In-memory evidence storage is forbidden in production");
  });

  it("accepts verified PostgreSQL storage in production", () => {
    expect(
      loadConfig({
        ...OIDC_ENV,
        PROOFSTACK_AUTH_MODE: "oidc",
        PROOFSTACK_DATABASE_URL:
          "postgresql://runtime@db.example.com/proofstack?sslmode=verify-full",
        PROOFSTACK_ENV: "production",
        PROOFSTACK_IDENTITY_DATABASE_URL:
          "postgresql://identity@db.example.com/proofstack?sslmode=verify-full",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toMatchObject({ storage: { mode: "postgres" } });
  });

  it("requires durable identity storage for every production authentication mode", () => {
    expect(() => loadConfig({ PROOFSTACK_AUTH_MODE: "api_key" })).toThrow(
      "PROOFSTACK_IDENTITY_DATABASE_URL",
    );
    expect(() => loadConfig({ PROOFSTACK_AUTH_MODE: "oidc" })).toThrow(
      "PROOFSTACK_IDENTITY_DATABASE_URL",
    );
  });

  it("validates identity database transport independently", () => {
    expect(() =>
      loadConfig({
        PROOFSTACK_AUTH_MODE: "api_key",
        PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@db.example.com/proofstack",
      }),
    ).toThrow("sslmode=verify-full");
  });

  it("requires separate evidence and identity database roles", () => {
    expect(() =>
      loadConfig({
        PROOFSTACK_AUTH_MODE: "api_key",
        PROOFSTACK_DATABASE_URL: "postgresql://shared@127.0.0.1:5432/proofstack",
        PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://shared@127.0.0.1:5432/proofstack",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toThrow("must use distinct roles");
  });

  it("loads combined mode only with an isolated durable identity connection", () => {
    expect(
      loadConfig({
        ...OIDC_ENV,
        PROOFSTACK_AUTH_MODE: "combined",
        PROOFSTACK_DATABASE_URL: "postgresql://api@127.0.0.1:5432/proofstack",
        PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toMatchObject({
      authMode: "combined",
      identityDatabaseUrl: "postgresql://identity@127.0.0.1:5432/proofstack",
      oidc: {
        clientId: "proofstack-console",
        scopes: ["openid", "profile", "email"],
      },
    });
  });

  it("requires complete OIDC settings and a canonical 32-byte transaction secret", () => {
    expect(() =>
      loadConfig({
        PROOFSTACK_AUTH_MODE: "oidc",
        PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
      }),
    ).toThrow("complete PROOFSTACK_OIDC_*");

    expect(() =>
      loadConfig({
        ...OIDC_ENV,
        PROOFSTACK_AUTH_MODE: "oidc",
        PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
        PROOFSTACK_OIDC_TRANSACTION_SECRET: "not-a-secret",
      }),
    ).toThrow();
  });

  it("rejects unused or partial OIDC configuration", () => {
    expect(() => loadConfig({ ...OIDC_ENV })).toThrow("only valid for oidc or combined");
    expect(() =>
      loadConfig({
        PROOFSTACK_AUTH_MODE: "oidc",
        PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
        PROOFSTACK_OIDC_CLIENT_ID: "proofstack-console",
      }),
    ).toThrow();
  });

  it("accepts only canonical browser origins and requires HTTPS with OIDC", () => {
    expect(loadConfig({ PROOFSTACK_CORS_ORIGIN: "http://127.0.0.1:3010" })).toMatchObject({
      corsOrigin: "http://127.0.0.1:3010",
    });
    expect(() =>
      loadConfig({ PROOFSTACK_CORS_ORIGIN: "https://console.example.test/path" }),
    ).toThrow("exact scheme, host");
    expect(() =>
      loadConfig({
        ...OIDC_ENV,
        PROOFSTACK_AUTH_MODE: "oidc",
        PROOFSTACK_CORS_ORIGIN: "http://console.example.test",
        PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
      }),
    ).toThrow("HTTPS CORS origin");
  });
});
