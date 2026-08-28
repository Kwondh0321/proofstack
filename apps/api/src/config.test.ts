import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("loads safe development defaults", () => {
    expect(loadConfig({})).toMatchObject({
      authMode: "development",
      environment: "development",
      host: "127.0.0.1",
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

  it("loads loopback PostgreSQL storage explicitly", () => {
    expect(
      loadConfig({
        PROOFSTACK_DATABASE_URL: "postgresql://runtime@127.0.0.1:5432/proofstack",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toMatchObject({
      storage: {
        databaseUrl: "postgresql://runtime@127.0.0.1:5432/proofstack",
        mode: "postgres",
      },
    });
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
        PROOFSTACK_AUTH_MODE: "combined",
        PROOFSTACK_DATABASE_URL: "postgresql://api@127.0.0.1:5432/proofstack",
        PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toMatchObject({
      authMode: "combined",
      identityDatabaseUrl: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
  });
});
