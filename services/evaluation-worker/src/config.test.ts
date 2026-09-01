import { describe, expect, it } from "vitest";
import { EvaluationWorkerConfigurationError, loadEvaluationWorkerConfig } from "./config.js";

function developmentEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROOFSTACK_ENV: "development",
    PROOFSTACK_EVALUATION_WORKER_DATABASE_URL:
      "postgresql://proofstack_evaluation_worker:local-password@127.0.0.1:5432/proofstack",
    ...overrides,
  };
}

describe("evaluation worker configuration", () => {
  it("loads the default dedicated role for loopback development", () => {
    expect(loadEvaluationWorkerConfig(developmentEnvironment())).toEqual({
      databaseRole: "proofstack_evaluation_worker",
      databaseUrl:
        "postgresql://proofstack_evaluation_worker:local-password@127.0.0.1:5432/proofstack",
      deploymentEnvironment: "development",
    });
  });

  it("accepts an exact custom role over verified production TLS", () => {
    expect(
      loadEvaluationWorkerConfig({
        PROOFSTACK_ENV: "production",
        PROOFSTACK_EVALUATION_WORKER_DATABASE_ROLE: "custom_evaluation_worker",
        PROOFSTACK_EVALUATION_WORKER_DATABASE_URL:
          "postgresql://custom_evaluation_worker@db.example.com/proofstack?sslmode=verify-full",
      }),
    ).toMatchObject({
      databaseRole: "custom_evaluation_worker",
      deploymentEnvironment: "production",
    });
  });

  it.each([
    [
      "missing deployment mode",
      developmentEnvironment({ PROOFSTACK_ENV: undefined }),
      "Set PROOFSTACK_ENV",
    ],
    ["unknown deployment mode", developmentEnvironment({ PROOFSTACK_ENV: "staging" }), "must be"],
    [
      "surrounding database URL space",
      developmentEnvironment({
        PROOFSTACK_EVALUATION_WORKER_DATABASE_URL:
          " postgresql://proofstack_evaluation_worker@127.0.0.1/proofstack",
      }),
      "without surrounding space",
    ],
    [
      "invalid role name",
      developmentEnvironment({ PROOFSTACK_EVALUATION_WORKER_DATABASE_ROLE: "Admin" }),
      "must match",
    ],
    [
      "non-PostgreSQL URL",
      developmentEnvironment({
        PROOFSTACK_EVALUATION_WORKER_DATABASE_URL: "https://127.0.0.1/proofstack",
      }),
      "must use postgres:",
    ],
    [
      "plaintext production URL",
      developmentEnvironment({ PROOFSTACK_ENV: "production" }),
      "require sslmode=verify-full",
    ],
    [
      "wrong connection role",
      developmentEnvironment({
        PROOFSTACK_EVALUATION_WORKER_DATABASE_URL:
          "postgresql://proofstack_api@127.0.0.1/proofstack",
      }),
      "must authenticate as proofstack_evaluation_worker",
    ],
    [
      "malformed role encoding",
      developmentEnvironment({
        PROOFSTACK_EVALUATION_WORKER_DATABASE_URL:
          "postgresql://proofstack_evaluation_worker%ZZ@127.0.0.1/proofstack",
      }),
      "role encoding is invalid",
    ],
  ])("rejects $0", (_name, environment, message) => {
    expect(() => loadEvaluationWorkerConfig(environment)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining(message) }),
    );
  });

  it("preserves a typed configuration error for callers", () => {
    expect(() => loadEvaluationWorkerConfig({})).toThrow(EvaluationWorkerConfigurationError);
  });
});
