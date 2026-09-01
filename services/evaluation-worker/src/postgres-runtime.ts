import type { Clock, EvaluationRepository } from "@proofstack/core";
import {
  assertMigrationsCurrent,
  createPostgresPool,
  PostgresEvaluationRepository,
} from "@proofstack/postgres";
import { createEvaluationWorkerBoundary, type EvaluationWorkerOperations } from "./boundary.js";

export interface PostgresEvaluationWorkerOptions {
  readonly clock: Clock;
  readonly databaseUrl: string;
  readonly onIdleError: (error: Error) => void;
}

export interface PostgresEvaluationWorkerRuntime extends EvaluationWorkerOperations {
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

interface PostgresEvaluationWorkerDependencies {
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createPool: typeof createPostgresPool;
  readonly createRepository: (pool: ReturnType<typeof createPostgresPool>) => EvaluationRepository;
}

const defaultDependencies: PostgresEvaluationWorkerDependencies = {
  assertCurrent: assertMigrationsCurrent,
  createPool: createPostgresPool,
  createRepository: (pool) => new PostgresEvaluationRepository(pool),
};

export async function createPostgresEvaluationWorker(
  options: PostgresEvaluationWorkerOptions,
  dependencyOverrides: Partial<PostgresEvaluationWorkerDependencies> = {},
): Promise<PostgresEvaluationWorkerRuntime> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const pool = dependencies.createPool({
    applicationName: "proofstack-evaluation-worker",
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

  const boundary = createEvaluationWorkerBoundary({
    clock: options.clock,
    repository: dependencies.createRepository(pool),
  });
  return {
    checkReadiness: () => dependencies.assertCurrent(pool),
    close: () => pool.end(),
    createEvaluationAggregate: (command) => boundary.createEvaluationAggregate(command),
    recordEvaluationRunResult: (command) => boundary.recordEvaluationRunResult(command),
    recordQualificationReport: (command) => boundary.recordQualificationReport(command),
    recordRawObservation: (command) => boundary.recordRawObservation(command),
  };
}
