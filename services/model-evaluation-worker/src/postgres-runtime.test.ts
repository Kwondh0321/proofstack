import { MigrationRequiredError, PostgresModelAssuranceRepository } from "@proofstack/postgres";
import { describe, expect, it, vi } from "vitest";
import { createPostgresModelEvaluationWorker } from "./postgres-runtime.js";
import { passThroughRepository, repositoryFactory, workerCommand } from "./test-support.js";

function fakeDependencies(options: { readonly assertCurrent?: () => Promise<void> } = {}) {
  const end = vi.fn(async () => undefined);
  const pool = { end } as never;
  const assertCurrent = vi.fn(options.assertCurrent ?? (async () => undefined));
  const createPool = vi.fn(() => pool);
  const repository = passThroughRepository();
  const createRepository = repositoryFactory(repository);
  return { assertCurrent, createPool, createRepository, end, pool };
}

describe("PostgreSQL model evaluation worker runtime", () => {
  it("verifies migrations and exposes only model execution operations", async () => {
    const dependencies = fakeDependencies();
    const onIdleError = vi.fn();
    const options = {
      clock: { now: () => new Date("2026-09-02T06:00:00.000Z") },
      databaseUrl: "postgresql://proofstack_model_evaluation_worker@127.0.0.1/proofstack",
      onIdleError,
    };
    const runtime = await createPostgresModelEvaluationWorker(options, dependencies);

    expect(dependencies.createPool).toHaveBeenCalledWith({
      applicationName: "proofstack-model-evaluation-worker",
      connectionString: options.databaseUrl,
      maxConnections: 2,
      onIdleError,
    });
    expect(Object.keys(runtime).sort()).toEqual([
      "checkReadiness",
      "close",
      "recordBlindedEvaluationResult",
      "recordIndependentCritique",
      "recordModelQualificationReport",
    ]);
    await expect(
      runtime.recordBlindedEvaluationResult(workerCommand("blinded_evaluation_result")),
    ).resolves.toMatchObject({ created: true });
    await expect(
      runtime.recordIndependentCritique(workerCommand("independent_critique")),
    ).resolves.toMatchObject({ created: true });
    await expect(
      runtime.recordModelQualificationReport(workerCommand("model_qualification_report")),
    ).resolves.toMatchObject({ created: true });
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    await runtime.close();
    expect(dependencies.end).toHaveBeenCalledOnce();
  });

  it("closes the pool when migration verification fails", async () => {
    const failure = new MigrationRequiredError(["0041_model_assurance_graph"]);
    const dependencies = fakeDependencies({
      assertCurrent: async () => {
        throw failure;
      },
    });
    await expect(
      createPostgresModelEvaluationWorker(
        {
          clock: { now: () => new Date() },
          databaseUrl: "postgresql://role@127.0.0.1/db",
          onIdleError: vi.fn(),
        },
        dependencies,
      ),
    ).rejects.toBe(failure);
    expect(dependencies.end).toHaveBeenCalledOnce();
    expect(dependencies.createRepository).not.toHaveBeenCalled();
  });

  it("constructs the PostgreSQL model-assurance repository by default", async () => {
    const dependencies = fakeDependencies();
    const runtime = await createPostgresModelEvaluationWorker(
      {
        clock: { now: () => new Date() },
        databaseUrl: "postgresql://role@127.0.0.1/db",
        onIdleError: vi.fn(),
      },
      { assertCurrent: dependencies.assertCurrent, createPool: dependencies.createPool },
    );
    expect(PostgresModelAssuranceRepository).toBeTypeOf("function");
    await runtime.close();
  });
});
