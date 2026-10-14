import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PrincipalContextSchema,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationJobHistoryEntry,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotInputs,
  type PolicyEvaluationDefinition,
  type PolicyEvaluation,
} from "@proofstack/contracts";
import {
  assemblePolicyEvaluationSnapshot,
  claimPolicyEvaluationJob,
  sealPolicyEvaluationJob,
  startPolicyEvaluationComputation,
  reservePolicyEvaluationUsage,
  completePolicyEvaluationJob,
  computeSealedPolicyEvaluation,
  digestPolicyEvaluationDefinition,
  createPolicyEvaluationJobHistoryEntry,
} from "@proofstack/core";
import { MemoryPolicyEvaluationJobRepository } from "@proofstack/core/testing";
import { publishPolicyEvaluationWithReservedRules as publish } from "./publish-with-rule-reservation.js";

/** Fault model for ordering/receipts. Native tests exercise the actual independently committed fee. */
async function fixture() {
  const inputs = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/vectors/policy-evaluation-snapshot-inputs-v2.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as PolicyEvaluationSnapshotInputs;
  inputs.request.createdAt = inputs.capturedAt;
  const bound = inputs;
  const pageSet = assemblePolicyEvaluationSnapshot({
    snapshotId: "snapshot_rule_payment",
    inputs: bound,
  });
  const scope = bound.request.scope;
  const memory = new MemoryPolicyEvaluationJobRepository({ now: () => bound.capturedAt });
  let graph = (await memory.createJob({ request: bound.request, jobId: "job_rule_payment" }))
    .snapshot;
  let entry = createPolicyEvaluationJobHistoryEntry({
    previous: null,
    previousEntry: null,
    next: graph,
    operation: { kind: "created" },
  });
  function transition(
    next: PolicyEvaluationJobSnapshot,
    operation: PolicyEvaluationJobHistoryEntry["definition"]["operation"],
  ) {
    entry = createPolicyEvaluationJobHistoryEntry({
      previous: graph,
      previousEntry: entry,
      next,
      operation,
    });
    graph = next;
  }
  const claimed = claimPolicyEvaluationJob({
    snapshot: graph,
    now: "2026-10-01T02:00:00.001Z",
    recoveryEpoch: 0,
    workerId: "worker_rule_payment",
    attemptId: "attempt_rule_payment",
    leaseId: "lease_rule_payment",
  });
  const fence = claimed.job.currentLease!.mutationFence;
  const common = { recoveryEpoch: 0, fence };
  transition(claimed, { kind: "claim", fence });
  const snapshot = {
    snapshotId: pageSet.definition.snapshotId,
    definitionSha256: pageSet.definitionSha256,
  };
  const sealedAt = "2026-10-01T02:00:00.002Z";
  transition(
    sealPolicyEvaluationJob({
      ...common,
      snapshot: graph,
      now: sealedAt,
      sealedSnapshot: snapshot,
    }),
    { kind: "seal", fence, snapshot },
  );
  transition(
    startPolicyEvaluationComputation({
      ...common,
      snapshot: graph,
      now: "2026-10-01T02:00:00.003Z",
    }),
    { kind: "start_computation", fence },
  );
  const snapshotRecord: PolicyEvaluationSnapshot = {
    ...pageSet.definition,
    scope,
    schemaVersion: "0.1",
    definitionSha256: pageSet.definitionSha256,
    ...fence,
    sealedAt,
    recordedAt: sealedAt,
    sealedByPrincipalId: fence.workerId,
  };
  const principal = PrincipalContextSchema.parse({
    principalId: fence.workerId,
    principalType: "service",
    tenantId: scope.tenantId,
    authentication: {
      method: "service_token",
      credentialId: "credential_rule_payment",
      authenticatedAt: bound.capturedAt,
    },
    roles: ["member"],
    capabilities: ["policy:evaluation:execute"],
    requestId: "request_rule_payment",
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
  });
  let serial = 0;
  const reservations = new Map<string, PolicyEvaluationJobHistoryEntry>();
  const findJob = vi.fn(async () => graph);
  const reserveWork = vi.fn(
    async (command: { reservationId: string; delta: PolicyEvaluationJobSnapshot["usage"] }) => {
      const retained = reservations.get(command.reservationId);
      if (retained) return { created: false, snapshot: graph, reservation: retained };
      const next = reservePolicyEvaluationUsage({
        ...common,
        snapshot: graph,
        now: `2026-10-01T02:00:00.${String(4 + serial++).padStart(3, "0")}Z`,
        delta: command.delta,
      });
      transition(next, {
        kind: "reserve",
        fence,
        reservationId: command.reservationId,
        delta: command.delta,
      });
      reservations.set(command.reservationId, entry);
      return { created: true, snapshot: graph, reservation: entry };
    },
  );
  const publishResult = vi.fn(async (command: { evaluationId: string }) => {
    const definition: PolicyEvaluationDefinition = computeSealedPolicyEvaluation({
      evaluationId: command.evaluationId,
      expected: { scope, jobId: fence.jobId, request: graph.job.request, snapshot },
      record: snapshotRecord,
      pageSet,
    });
    const definitionSha256 = digestPolicyEvaluationDefinition(scope, definition);
    const recordedAt = "2026-10-01T02:00:00.020Z";
    const evaluation: PolicyEvaluation = {
      ...definition,
      scope,
      schemaVersion: "0.1",
      definitionSha256,
      ...fence,
      recordedAt,
      recordedByPrincipalId: fence.workerId,
    };
    transition(
      completePolicyEvaluationJob({
        ...common,
        snapshot: graph,
        now: recordedAt,
        result: { evaluationId: command.evaluationId, definitionSha256 },
        ruleCount: definition.ruleCount,
      }),
      {
        kind: "complete",
        fence,
        result: { evaluationId: command.evaluationId, definitionSha256 },
        ruleCount: definition.ruleCount,
      },
    );
    return { created: true, snapshot: graph, evaluation };
  });
  let nextId = 0;
  const dependencies = {
    repository: { findJob, reserveWork },
    publisher: { publishResult },
    snapshotRecord,
    pageSet,
    nextReservationId: vi.fn(() => `reservation_rule_${++nextId}`),
  };
  const command = { principal, scope, fence, evaluationId: "evaluation_rule_payment" };
  return { command, dependencies, findJob, reserveWork, publishResult, graph: () => graph };
}

describe("durable full rule invocation reservation", () => {
  it("pays every original rule before publication and retains its completed evidence", async () => {
    const f = await fixture();
    const result = await publish(f.command, f.dependencies);
    expect(result.snapshot.usage.ruleEvaluations).toBe(7);
    expect(result.evaluation.ruleCount).toBe(7);
    expect(f.reserveWork.mock.invocationCallOrder[0]).toBeLessThan(
      f.publishResult.mock.invocationCallOrder[0]!,
    );
    expect(f.reserveWork.mock.calls[0]?.[0].delta).toEqual({
      reads: 0,
      records: 0,
      recordBytes: 0,
      references: 0,
      referenceBytes: 0,
      artifactReadBytes: 0,
      ruleEvaluations: 7,
    });
  });
  it("retains a committed fee after failure and pays a new fee on another invocation", async () => {
    const f = await fixture();
    f.publishResult.mockRejectedValueOnce(new Error("publication rolled back"));
    await expect(publish(f.command, f.dependencies)).rejects.toThrow("publication rolled back");
    expect(f.graph().usage.ruleEvaluations).toBe(7);
    const result = await publish(f.command, f.dependencies);
    expect(result.snapshot.usage.ruleEvaluations).toBe(14);
    expect(f.reserveWork.mock.calls.map(([x]) => x.reservationId)).toEqual([
      "reservation_rule_1",
      "reservation_rule_2",
    ]);
  });
  it("refuses a duplicate reservation acknowledgement before another computation", async () => {
    const f = await fixture();
    f.dependencies.nextReservationId.mockReturnValue("reservation_duplicate");
    f.publishResult.mockRejectedValueOnce(new Error("failed first invocation"));
    await expect(publish(f.command, f.dependencies)).rejects.toThrow("failed first invocation");
    await expect(publish(f.command, f.dependencies)).rejects.toThrow(
      "fresh reservation occurrence",
    );
    expect(f.publishResult).toHaveBeenCalledTimes(1);
    expect(f.graph().usage.ruleEvaluations).toBe(7);
  });
  it("preserves spent work when a later invocation cannot afford the full count", async () => {
    const f = await fixture();
    f.publishResult.mockRejectedValueOnce(new Error("failed first invocation"));
    await expect(publish(f.command, f.dependencies)).rejects.toThrow("failed first invocation");
    await f.reserveWork({
      reservationId: "reservation_other_spent_work",
      delta: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: f.graph().request.limits.maxRuleEvaluations - 7,
      },
    });
    await expect(publish(f.command, f.dependencies)).rejects.toThrow();
    expect(f.publishResult).toHaveBeenCalledTimes(1);
    expect(f.graph().usage.ruleEvaluations).toBe(f.graph().request.limits.maxRuleEvaluations);
  });
  it.each([[], ["policy:evaluate"], ["policy:read"]].map((capabilities) => ({ capabilities })))(
    "denies %j before reading or paying",
    async ({ capabilities }) => {
      const f = await fixture();
      const principal = PrincipalContextSchema.parse({ ...f.command.principal, capabilities });
      await expect(publish({ ...f.command, principal }, f.dependencies)).rejects.toThrow();
      expect(f.findJob).not.toHaveBeenCalled();
      expect(f.reserveWork).not.toHaveBeenCalled();
      expect(f.publishResult).not.toHaveBeenCalled();
    },
  );
  it("denies worker impersonation and foreign scope before dependencies", async () => {
    const f = await fixture();
    await expect(
      publish(
        { ...f.command, fence: { ...f.command.fence, workerId: "worker_other" } },
        f.dependencies,
      ),
    ).rejects.toThrow("authenticated worker");
    await expect(
      publish(
        { ...f.command, scope: { ...f.command.scope, tenantId: "tenant_other" } },
        f.dependencies,
      ),
    ).rejects.toThrow();
    expect(f.findJob).not.toHaveBeenCalled();
  });
  it.each(["api_key", "development", "oidc"] as const)(
    "denies %s authentication before dependencies",
    async (method) => {
      const f = await fixture();
      const principal = PrincipalContextSchema.parse({
        ...f.command.principal,
        authentication: { ...f.command.principal.authentication, method },
      });
      await expect(publish({ ...f.command, principal }, f.dependencies)).rejects.toThrow(
        "service-token",
      );
      expect(f.findJob).not.toHaveBeenCalled();
    },
  );
  it("rejects a delayed acknowledgement after its native remaining window without computing", async () => {
    const f = await fixture();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const original = f.reserveWork.getMockImplementation()!;
    f.reserveWork.mockImplementationOnce(async (command) => {
      const receipt = await original(command);
      clock.mockReturnValue(6000);
      return receipt;
    });
    try {
      await expect(publish(f.command, f.dependencies)).rejects.toThrow(
        "expired before computation",
      );
      expect(f.publishResult).not.toHaveBeenCalled();
      expect(f.graph().usage.ruleEvaluations).toBe(7);
    } finally {
      clock.mockRestore();
    }
  });
  it("rejects an incomplete original page set before any rule fee or computation", async () => {
    const f = await fixture();
    const pageSet = structuredClone(f.dependencies.pageSet);
    pageSet.pages.pop();
    await expect(publish(f.command, { ...f.dependencies, pageSet })).rejects.toThrow();
    expect(f.reserveWork).not.toHaveBeenCalled();
    expect(f.publishResult).not.toHaveBeenCalled();
  });
  it("does not turn a completed receipt into a new charged invocation", async () => {
    const f = await fixture();
    await publish(f.command, f.dependencies);
    await expect(publish(f.command, f.dependencies)).rejects.toThrow("original running attempt");
    expect(f.reserveWork).toHaveBeenCalledTimes(1);
  });
  it.each([false, undefined])(
    "refuses non-fresh acknowledgement %s without computation",
    async (created) => {
      const f = await fixture();
      const original = f.reserveWork.getMockImplementation()!;
      f.reserveWork.mockImplementationOnce(async (command) => ({
        ...(await original(command)),
        created: created as boolean,
      }));
      await expect(publish(f.command, f.dependencies)).rejects.toThrow(
        "fresh reservation occurrence",
      );
      expect(f.graph().usage.ruleEvaluations).toBe(7);
      expect(f.publishResult).not.toHaveBeenCalled();
    },
  );
  it("rejects a forged paid graph without refunding the actual committed charge", async () => {
    const f = await fixture();
    const original = f.reserveWork.getMockImplementation()!;
    f.reserveWork.mockImplementationOnce(async (command) => {
      const receipt = structuredClone(await original(command));
      receipt.snapshot.usage.ruleEvaluations++;
      return receipt;
    });
    await expect(publish(f.command, f.dependencies)).rejects.toThrow();
    expect(f.graph().usage.ruleEvaluations).toBe(7);
    expect(f.publishResult).not.toHaveBeenCalled();
  });
  it("retains an ambiguously acknowledged fee and starts no computation", async () => {
    const f = await fixture();
    const original = f.reserveWork.getMockImplementation()!;
    f.reserveWork.mockImplementationOnce(async (command) => {
      await original(command);
      throw new Error("connection lost after committed payment");
    });
    await expect(publish(f.command, f.dependencies)).rejects.toThrow("connection lost");
    expect(f.graph().usage.ruleEvaluations).toBe(7);
    expect(f.publishResult).not.toHaveBeenCalled();
    expect((await publish(f.command, f.dependencies)).snapshot.usage.ruleEvaluations).toBe(14);
  });
  it("rejects a missing immutable reservation receipt after payment", async () => {
    const f = await fixture();
    const original = f.reserveWork.getMockImplementation()!;
    f.reserveWork.mockImplementationOnce(async (command) => ({
      ...(await original(command)),
      reservation: null as unknown as PolicyEvaluationJobHistoryEntry,
    }));
    await expect(publish(f.command, f.dependencies)).rejects.toThrow(
      "fresh reservation occurrence",
    );
    expect(f.graph().usage.ruleEvaluations).toBe(7);
    expect(f.publishResult).not.toHaveBeenCalled();
  });
  it("rejects completion that refunds previously paid non-rule work", async () => {
    const f = await fixture();
    await f.reserveWork({
      reservationId: "reservation_original_read",
      delta: {
        reads: 1,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: 0,
      },
    });
    const original = f.publishResult.getMockImplementation()!;
    f.publishResult.mockImplementationOnce(async (command) => {
      const receipt = structuredClone(await original(command));
      receipt.snapshot.usage.reads = 0;
      receipt.snapshot.attempts.at(-1)!.usageAtClose!.reads = 0;
      return receipt;
    });
    await expect(publish(f.command, f.dependencies)).rejects.toThrow("paid invocation");
    expect(f.graph().usage.reads).toBe(1);
    expect(f.graph().usage.ruleEvaluations).toBe(7);
  });
  it("rejects a completion with a substituted original receipt", async () => {
    const f = await fixture();
    const original = f.publishResult.getMockImplementation()!;
    f.publishResult.mockImplementationOnce(async (command) => {
      const receipt = structuredClone(await original(command));
      receipt.evaluation.recordedAt = "2026-10-01T02:00:00.021Z";
      return receipt;
    });
    await expect(publish(f.command, f.dependencies)).rejects.toThrow();
    expect(f.graph().usage.ruleEvaluations).toBe(7);
  });
});
