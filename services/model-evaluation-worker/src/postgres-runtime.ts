import type { Clock, ModelAssuranceRepository } from "@proofstack/core";
import {
  assertMigrationsCurrent,
  createPostgresPool,
  PostgresModelAssuranceRepository,
} from "@proofstack/postgres";
import {
  createModelEvaluationWorkerBoundary,
  type ModelEvaluationWorkerOperations,
} from "./boundary.js";

export interface PostgresModelEvaluationWorkerOptions {
  readonly clock: Clock;
  readonly databaseUrl: string;
  readonly onIdleError: (error: Error) => void;
}

export interface PostgresModelEvaluationWorkerRuntime extends ModelEvaluationWorkerOperations {
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

interface Dependencies {
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createPool: typeof createPostgresPool;
  readonly createRepository: (
    pool: ReturnType<typeof createPostgresPool>,
  ) => ModelAssuranceRepository;
}

const defaults: Dependencies = {
  assertCurrent: assertMigrationsCurrent,
  createPool: createPostgresPool,
  createRepository: (pool) => new PostgresModelAssuranceRepository(pool),
};

export async function createPostgresModelEvaluationWorker(
  options: PostgresModelEvaluationWorkerOptions,
  overrides: Partial<Dependencies> = {},
): Promise<PostgresModelEvaluationWorkerRuntime> {
  const dependencies = { ...defaults, ...overrides };
  const pool = dependencies.createPool({
    applicationName: "proofstack-model-evaluation-worker",
    connectionString: options.databaseUrl,
    maxConnections: 2,
    onIdleError: options.onIdleError,
  });
  try {
    await dependencies.assertCurrent(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const boundary = createModelEvaluationWorkerBoundary({
    clock: options.clock,
    repository: dependencies.createRepository(pool),
  });
  return {
    checkReadiness: () => dependencies.assertCurrent(pool),
    close: () => pool.end(),
    recordBlindedEvaluationResult: (command) => boundary.recordBlindedEvaluationResult(command),
    recordIndependentCritique: (command) => boundary.recordIndependentCritique(command),
    recordModelQualificationReport: (command) => boundary.recordModelQualificationReport(command),
  };
}
