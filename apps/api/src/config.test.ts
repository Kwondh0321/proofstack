import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("loads safe development defaults", () => {
    expect(loadConfig({})).toMatchObject({
      authMode: "development",
      environment: "development",
      host: "127.0.0.1",
      port: 4318,
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
        PROOFSTACK_ENV: "production",
        PROOFSTACK_HOST: "0.0.0.0",
      }),
    ).toMatchObject({ authMode: "oidc", host: "0.0.0.0" });
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ PROOFSTACK_PORT: "70000" })).toThrow();
  });
});
