import { MigrationRequiredError, PostgresEvaluationRepository } from "@proofstack/postgres";
import { describe, expect, it, vi } from "vitest";
import { createPostgresEvaluationWorker } from "./postgres-runtime.js";
import { passThroughRepository, repositoryFactory, workerCommand } from "./test-support.js";

function fakeDependencies(options: { readonly assertCurrent?: () => Promise<void> } = {}) {
  const end = vi.fn(async () => undefined);
  const pool = { end } as never;
  const assertCurrent = vi.fn(options.assertCurrent ?? (async () => undefined));
  const createPool = vi.fn(() => pool);
  const repository = passThroughRepository();
  const createRepository = repositoryFactory(repository);
  return { assertCurrent, createPool, createRepository, end, pool, repository };
}

describe("PostgreSQL evaluation worker runtime", () => {
  it("verifies migrations and exposes only bounded worker operations", async () => {
    const dependencies = fakeDependencies();
    const onIdleError = vi.fn();
    const options = {
      clock: { now: () => new Date("2026-09-02T01:02:03.004Z") },
      databaseUrl: "postgresql://proofstack_evaluation_worker@127.0.0.1/proofstack",
      onIdleError,
    };

    const runtime = await createPostgresEvaluationWorker(options, dependencies);

    expect(dependencies.createPool).toHaveBeenCalledWith({
      applicationName: "proofstack-evaluation-worker",
      connectionString: options.databaseUrl,
      maxConnections: 2,
      onIdleError,
    });
    expect(dependencies.assertCurrent).toHaveBeenCalledOnce();
    expect(dependencies.createRepository).toHaveBeenCalledWith(dependencies.pool);
    expect(Object.keys(runtime).sort()).toEqual([
      "checkReadiness",
      "close",
      "createEvaluationAggregate",
      "recordEvaluationRunResult",
      "recordQualificationReport",
      "recordRawObservation",
    ]);

    await expect(
      runtime.recordQualificationReport(workerCommand("qualification_report")),
    ).resolves.toMatchObject({ created: true });
    await expect(
      runtime.recordRawObservation(workerCommand("raw_observation")),
    ).resolves.toMatchObject({ created: true });
    await expect(
      runtime.recordEvaluationRunResult(workerCommand("evaluation_run_result")),
    ).resolves.toMatchObject({ created: true });
    await expect(
      runtime.createEvaluationAggregate(workerCommand("evaluation_aggregate")),
    ).resolves.toMatchObject({ created: true });
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    expect(dependencies.assertCurrent).toHaveBeenCalledTimes(2);
    await runtime.close();
    expect(dependencies.end).toHaveBeenCalledOnce();
  });

  it("closes the pool when startup migration verification fails", async () => {
    const failure = new MigrationRequiredError(["0038_align_evaluation_execution_authority"]);
    const dependencies = fakeDependencies({
      assertCurrent: async () => {
        throw failure;
      },
    });

    await expect(
      createPostgresEvaluationWorker(
        {
          clock: { now: () => new Date() },
          databaseUrl: "postgresql://proofstack_evaluation_worker@127.0.0.1/proofstack",
          onIdleError: vi.fn(),
        },
        dependencies,
      ),
    ).rejects.toBe(failure);
    expect(dependencies.end).toHaveBeenCalledOnce();
    expect(dependencies.createRepository).not.toHaveBeenCalled();
  });

  it("constructs the PostgreSQL evaluation repository by default", async () => {
    const dependencies = fakeDependencies();
    const runtime = await createPostgresEvaluationWorker(
      {
        clock: { now: () => new Date() },
        databaseUrl: "postgresql://proofstack_evaluation_worker@127.0.0.1/proofstack",
        onIdleError: vi.fn(),
      },
      {
        assertCurrent: dependencies.assertCurrent,
        createPool: dependencies.createPool,
      },
    );

    expect(PostgresEvaluationRepository).toBeTypeOf("function");
    await runtime.close();
  });
});
