import { DEFAULT_RUNTIME_ROLE_NAMES, validatePostgresConnectionString } from "@proofstack/postgres";

export type ModelEvaluationWorkerDeploymentEnvironment = "development" | "production" | "test";

interface ModelEvaluationWorkerEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_ENV?: string;
  readonly PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_ROLE?: string;
  readonly PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL?: string;
}

export interface ModelEvaluationWorkerConfig {
  readonly databaseRole: string;
  readonly databaseUrl: string;
  readonly deploymentEnvironment: ModelEvaluationWorkerDeploymentEnvironment;
}

export class ModelEvaluationWorkerConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelEvaluationWorkerConfigurationError";
  }
}

const DATABASE_ROLE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;

function fail(message: string, cause?: unknown): ModelEvaluationWorkerConfigurationError {
  return new ModelEvaluationWorkerConfigurationError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function required(
  environment: ModelEvaluationWorkerEnvironment,
  name: keyof ModelEvaluationWorkerEnvironment,
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw fail(`Set ${String(name)} to one non-empty value without surrounding space`);
  }
  return value;
}

export function loadModelEvaluationWorkerConfig(
  environment: ModelEvaluationWorkerEnvironment = process.env,
): ModelEvaluationWorkerConfig {
  const deployment = required(environment, "PROOFSTACK_ENV");
  if (deployment !== "development" && deployment !== "production" && deployment !== "test") {
    throw fail("PROOFSTACK_ENV must be development, test, or production");
  }
  const role =
    environment.PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_ROLE ??
    DEFAULT_RUNTIME_ROLE_NAMES.modelEvaluationWorker;
  if (!DATABASE_ROLE_PATTERN.test(role)) {
    throw fail(
      `PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_ROLE must match ${DATABASE_ROLE_PATTERN.source}`,
    );
  }
  const configuredUrl = required(environment, "PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL");
  let databaseUrl: string;
  try {
    databaseUrl = validatePostgresConnectionString(configuredUrl, {
      allowPlaintextLoopback: deployment !== "production",
    });
  } catch (cause) {
    throw fail((cause as Error).message, cause);
  }
  let connectionRole: string;
  try {
    connectionRole = decodeURIComponent(new URL(databaseUrl).username);
  } catch (cause) {
    throw fail("Model evaluation worker PostgreSQL role encoding is invalid", cause);
  }
  if (connectionRole !== role) {
    throw fail(`PROOFSTACK_MODEL_EVALUATION_WORKER_DATABASE_URL must authenticate as ${role}`);
  }
  return { databaseRole: role, databaseUrl, deploymentEnvironment: deployment };
}
