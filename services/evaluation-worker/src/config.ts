import { DEFAULT_RUNTIME_ROLE_NAMES, validatePostgresConnectionString } from "@proofstack/postgres";

export type EvaluationWorkerDeploymentEnvironment = "development" | "production" | "test";

interface EvaluationWorkerEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_ENV?: string;
  readonly PROOFSTACK_EVALUATION_WORKER_DATABASE_ROLE?: string;
  readonly PROOFSTACK_EVALUATION_WORKER_DATABASE_URL?: string;
}

export interface EvaluationWorkerConfig {
  readonly databaseRole: string;
  readonly databaseUrl: string;
  readonly deploymentEnvironment: EvaluationWorkerDeploymentEnvironment;
}

export class EvaluationWorkerConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationWorkerConfigurationError";
  }
}

const DATABASE_ROLE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;

function configurationError(message: string, cause?: unknown): EvaluationWorkerConfigurationError {
  return new EvaluationWorkerConfigurationError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function required(
  environment: EvaluationWorkerEnvironment,
  name: keyof EvaluationWorkerEnvironment,
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw configurationError(
      `Set ${String(name)} to one non-empty value without surrounding space`,
    );
  }
  return value;
}

function deploymentEnvironment(
  environment: EvaluationWorkerEnvironment,
): EvaluationWorkerDeploymentEnvironment {
  const value = required(environment, "PROOFSTACK_ENV");
  if (value !== "development" && value !== "production" && value !== "test") {
    throw configurationError("PROOFSTACK_ENV must be development, test, or production");
  }
  return value;
}

function databaseRole(environment: EvaluationWorkerEnvironment): string {
  const value =
    environment.PROOFSTACK_EVALUATION_WORKER_DATABASE_ROLE ??
    DEFAULT_RUNTIME_ROLE_NAMES.evaluationWorker;
  if (!DATABASE_ROLE_PATTERN.test(value)) {
    throw configurationError(
      `PROOFSTACK_EVALUATION_WORKER_DATABASE_ROLE must match ${DATABASE_ROLE_PATTERN.source}`,
    );
  }
  return value;
}

function databaseUrl(
  environment: EvaluationWorkerEnvironment,
  deployment: EvaluationWorkerDeploymentEnvironment,
  expectedRole: string,
): string {
  const configuredUrl = required(environment, "PROOFSTACK_EVALUATION_WORKER_DATABASE_URL");
  let value: string;
  try {
    value = validatePostgresConnectionString(configuredUrl, {
      allowPlaintextLoopback: deployment !== "production",
    });
  } catch (error) {
    throw configurationError((error as Error).message, error);
  }

  let connectionRole: string;
  try {
    connectionRole = decodeURIComponent(new URL(value).username);
  } catch (error) {
    throw configurationError("Evaluation worker PostgreSQL role encoding is invalid", error);
  }
  if (connectionRole !== expectedRole) {
    throw configurationError(
      `PROOFSTACK_EVALUATION_WORKER_DATABASE_URL must authenticate as ${expectedRole}`,
    );
  }
  return value;
}

export function loadEvaluationWorkerConfig(
  environment: EvaluationWorkerEnvironment = process.env,
): EvaluationWorkerConfig {
  const deployment = deploymentEnvironment(environment);
  const role = databaseRole(environment);
  return {
    databaseRole: role,
    databaseUrl: databaseUrl(environment, deployment, role),
    deploymentEnvironment: deployment,
  };
}
