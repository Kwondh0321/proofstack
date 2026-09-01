import { describe, expect, it, vi } from "vitest";
import { createModelEvaluationWorkerBoundary } from "./boundary.js";
import {
  passThroughRepository,
  servicePrincipal,
  workerCommand,
  workerKinds,
} from "./test-support.js";

describe("model evaluation worker boundary", () => {
  it("exposes only the three model-execution recording operations", async () => {
    const repository = passThroughRepository();
    const worker = createModelEvaluationWorkerBoundary({
      clock: { now: () => new Date("2026-09-02T06:00:00.000Z") },
      repository,
    });

    expect(Object.keys(worker).sort()).toEqual([
      "recordBlindedEvaluationResult",
      "recordIndependentCritique",
      "recordModelQualificationReport",
    ]);
    await expect(
      worker.recordBlindedEvaluationResult(workerCommand("blinded_evaluation_result")),
    ).resolves.toMatchObject({ created: true });
    await expect(
      worker.recordIndependentCritique(workerCommand("independent_critique")),
    ).resolves.toMatchObject({ created: true });
    await expect(
      worker.recordModelQualificationReport(workerCommand("model_qualification_report")),
    ).resolves.toMatchObject({ created: true });
  });

  it.each([
    servicePrincipal({ principalType: "user" }),
    servicePrincipal({
      authentication: { authenticatedAt: "2026-09-02T00:00:00.000Z", method: "development" },
    }),
  ])("rejects non-service-token principals before repository access", async (principal) => {
    const accessed = vi.fn();
    const worker = createModelEvaluationWorkerBoundary({
      clock: { now: () => new Date() },
      repository: passThroughRepository(accessed),
    });
    for (const kind of workerKinds) {
      const operation = {
        blinded_evaluation_result: worker.recordBlindedEvaluationResult,
        independent_critique: worker.recordIndependentCritique,
        model_qualification_report: worker.recordModelQualificationReport,
      }[kind] as (command: never) => Promise<unknown>;
      await expect(operation(workerCommand(kind, principal) as never)).rejects.toThrow(
        /service principal/,
      );
    }
    expect(accessed).not.toHaveBeenCalled();
  });
});
