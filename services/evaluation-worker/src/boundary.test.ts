import type { PrincipalContext } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import { createEvaluationWorkerBoundary } from "./boundary.js";
import {
  passThroughRepository,
  servicePrincipal,
  workerCommand,
  workerKinds,
} from "./test-support.js";

describe("evaluation worker boundary", () => {
  it("records only the four worker-owned evidence families", async () => {
    const accesses: string[] = [];
    const worker = createEvaluationWorkerBoundary({
      clock: { now: () => new Date("2026-09-02T01:02:03.004Z") },
      repository: passThroughRepository((name) => accesses.push(name)),
    });

    const qualification = await worker.recordQualificationReport(
      workerCommand("qualification_report"),
    );
    const observation = await worker.recordRawObservation(workerCommand("raw_observation"));
    const result = await worker.recordEvaluationRunResult(workerCommand("evaluation_run_result"));
    const aggregate = await worker.createEvaluationAggregate(workerCommand("evaluation_aggregate"));

    expect([qualification, observation, result, aggregate].every(({ created }) => created)).toBe(
      true,
    );
    expect(qualification.record).toMatchObject({
      executedByPrincipalId: "svc_evaluator",
      recordedAt: "2026-09-02T01:02:03.004Z",
    });
    expect(observation.record).toMatchObject({ recordedAt: "2026-09-02T01:02:03.004Z" });
    expect(result.record).toMatchObject({
      recordedAt: "2026-09-02T01:02:03.004Z",
      recordedByPrincipalId: "svc_evaluator",
    });
    expect(aggregate.record).toMatchObject({
      createdAt: "2026-09-02T01:02:03.004Z",
      createdByPrincipalId: "svc_evaluator",
    });
    expect(accesses).toEqual([
      "findQualificationReport",
      "publishQualificationReport",
      "findRawObservation",
      "publishRawObservation",
      "findEvaluationRunResult",
      "publishEvaluationRunResult",
      "findEvaluationAggregate",
      "publishEvaluationAggregate",
    ]);
    expect(Object.keys(worker).sort()).toEqual([
      "createEvaluationAggregate",
      "recordEvaluationRunResult",
      "recordQualificationReport",
      "recordRawObservation",
    ]);
  });

  it.each([
    ["user principal", servicePrincipal({ principalType: "user" })],
    [
      "non-service authentication",
      servicePrincipal({
        authentication: {
          authenticatedAt: "2026-09-02T00:00:00.000Z",
          credentialId: "cred_evaluation_worker",
          method: "api_key",
        },
      }),
    ],
  ])("rejects a %s before repository access", async (_name, principal) => {
    const accessed = vi.fn();
    const worker = createEvaluationWorkerBoundary({
      clock: { now: () => new Date() },
      repository: passThroughRepository(accessed),
    });

    await expect(
      worker.recordRawObservation(workerCommand("raw_observation", principal as PrincipalContext)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(accessed).not.toHaveBeenCalled();
  });

  it("retains core authorization and validation on every worker method", async () => {
    const worker = createEvaluationWorkerBoundary({
      clock: { now: () => new Date("2026-09-02T01:02:03.004Z") },
      repository: passThroughRepository(),
    });
    const principal = servicePrincipal({ capabilities: [] });

    for (const kind of workerKinds) {
      const operation = {
        evaluation_aggregate: worker.createEvaluationAggregate,
        evaluation_run_result: worker.recordEvaluationRunResult,
        qualification_report: worker.recordQualificationReport,
        raw_observation: worker.recordRawObservation,
      }[kind];
      await expect(operation(workerCommand(kind, principal) as never)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });
});
