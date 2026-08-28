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
        PROOFSTACK_STORAGE_MODE: "postgres",
      }),
    ).toMatchObject({ storage: { mode: "postgres" } });
  });
});
