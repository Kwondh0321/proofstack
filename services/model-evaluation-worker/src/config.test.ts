import { describe, expect, it } from "vitest";
import {
  loadModelEvaluationWorkerConfig,
  ModelEvaluationWorkerConfigurationError,
} from "./config.js";

function development(overrides: Record<string, string | undefined> = {}) {
  return {
    PROOFSTACK_ENV: "development",
    PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL:
      "postgresql://proofstack_model_evaluation_worker:local-password@127.0.0.1:5432/proofstack",
    ...overrides,
  };
}

describe("model evaluation worker configuration", () => {
  it("loads the isolated default role for loopback development", () => {
    expect(loadModelEvaluationWorkerConfig(development())).toEqual({
      databaseRole: "proofstack_model_evaluation_worker",
      databaseUrl:
        "postgresql://proofstack_model_evaluation_worker:local-password@127.0.0.1:5432/proofstack",
      deploymentEnvironment: "development",
    });
  });

  it("accepts an exact custom role over verified production TLS", () => {
    expect(
      loadModelEvaluationWorkerConfig({
        PROOFSTACK_ENV: "production",
        PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_ROLE: "custom_model_worker",
        PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL:
          "postgresql://custom_model_worker@db.example.com/proofstack?sslmode=verify-full",
      }),
    ).toMatchObject({ databaseRole: "custom_model_worker", deploymentEnvironment: "production" });
  });

  it.each([
    ["missing environment", development({ PROOFSTACK_ENV: undefined }), "Set PROOFSTACK_ENV"],
    ["unknown environment", development({ PROOFSTACK_ENV: "staging" }), "must be development"],
    [
      "spaced URL",
      development({
        PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL:
          " postgresql://proofstack_model_evaluation_worker@127.0.0.1/proofstack",
      }),
      "without surrounding space",
    ],
    [
      "invalid role",
      development({ PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_ROLE: "Admin" }),
      "must match",
    ],
    [
      "non-PostgreSQL URL",
      development({ PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL: "https://127.0.0.1/db" }),
      "must use postgres:",
    ],
    ["plaintext production", development({ PROOFSTACK_ENV: "production" }), "verify-full"],
    [
      "wrong role",
      development({
        PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL:
          "postgresql://proofstack_api@127.0.0.1/proofstack",
      }),
      "must authenticate as proofstack_model_evaluation_worker",
    ],
    [
      "malformed role encoding",
      development({
        PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL:
          "postgresql://proofstack_model_evaluation_worker%ZZ@127.0.0.1/proofstack",
      }),
      "role encoding is invalid",
    ],
  ])("rejects %s", (_name, environment, message) => {
    expect(() => loadModelEvaluationWorkerConfig(environment)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining(message) }),
    );
  });

  it("preserves a typed configuration error", () => {
    expect(() => loadModelEvaluationWorkerConfig({})).toThrow(
      ModelEvaluationWorkerConfigurationError,
    );
  });
});
