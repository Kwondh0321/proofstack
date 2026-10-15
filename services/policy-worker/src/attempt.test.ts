import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  PrincipalContextSchema,
  MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES,
  type PrincipalContext,
} from "@proofstack/contracts";
import {
  PolicyEvaluationSchedulerTransitionError,
  exhaustPolicyEvaluationJobHistory,
} from "@proofstack/core";
import {
  MemoryPolicyEvaluationJobRepository,
  policySnapshotRepositoryFixture,
} from "@proofstack/core/testing";
import {
  generateServiceToken,
  hashServiceTokenSecret,
  ServiceTokenAuthenticator,
  type AuthenticatableServiceToken,
} from "@proofstack/identity";
import {
  runPolicyWorkerAttempt,
  PolicyWorkerAttemptError,
  PolicyWorkerJobUnavailableError,
  type PolicyWorkerAttemptPorts,
} from "./attempt.js";

const token = generateServiceToken();
let secretHash: AuthenticatableServiceToken["passwordHash"];
beforeAll(async () => {
  secretHash = await hashServiceTokenSecret(token.secret);
});
/** Real memory transitions/material/results. The seal port models composition, not native guards. */
async function fixture(create = true) {
  const f = policySnapshotRepositoryFixture();
  const time = { now: f.request.createdAt };
  const repository = new MemoryPolicyEvaluationJobRepository({ now: () => time.now });
  if (create) await repository.createJob({ request: f.request, jobId: f.jobId });
  const credential: AuthenticatableServiceToken = {
    kind: "service_token",
    prefix: token.prefix,
    passwordHash: secretHash,
    authenticatedAt: "2026-10-15T00:00:00.000Z",
    credentialId: "credential_policy_attempt",
    principalId: f.workerId,
    tenantId: f.scope.tenantId,
    capabilities: ["policy:evaluation:execute", "artifact:read"],
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: f.scope.projectId, environmentIds: [f.scope.environmentId] }],
    },
  };
  const authenticator = new ServiceTokenAuthenticator({
    findActiveServiceByPrefix: async () => credential,
    confirmActiveServiceUse: async () => true,
  });
  const principal = PrincipalContextSchema.parse({
    authentication: {
      method: "service_token",
      credentialId: credential.credentialId,
      authenticatedAt: credential.authenticatedAt,
    },
    principalType: "service",
    principalId: f.workerId,
    tenantId: f.scope.tenantId,
    capabilities: credential.capabilities,
    resourceScope: credential.resourceScope,
    roles: ["member"],
    requestId: "request_policy_attempt",
  });
  const seal = vi
    .fn<PolicyWorkerAttemptPorts["seal"]>()
    .mockImplementation(async ({ request, fence, principal: actor }) => {
      expect(request).toEqual(f.request);
      expect(actor.principalId).toBe(f.workerId);
      time.now = f.publicationAt;
      return repository.publishSnapshot({
        scope: f.scope,
        fence,
        pageSet: f.pageSet,
        principalId: actor.principalId,
      });
    });
  const close = vi.fn(async () => undefined);
  const ports: PolicyWorkerAttemptPorts = {
    worker: repository,
    snapshots: repository,
    results: repository,
    seal,
    close,
  };
  let sequence = 0;
  const nextId = vi.fn(
    (kind: "attempt" | "lease" | "rule_reservation" | "evaluation") => `${kind}_${++sequence}`,
  );
  const createRuntime = vi.fn(async () => ports);
  const dependencies = { authenticator, createRuntime, nextId };
  const command = {
    serviceToken: token.value,
    requestId: "request_policy_attempt",
    delivery: {
      schemaVersion: "0.1",
      projectId: f.scope.projectId,
      environmentId: f.scope.environmentId,
      jobId: f.jobId,
    },
  };
  return {
    ...f,
    repository,
    time,
    credential,
    principal,
    seal,
    close,
    ports,
    dependencies,
    command,
    nextId,
    createRuntime,
    run: () => runPolicyWorkerAttempt(command, dependencies),
  };
}

describe("authenticated owning policy attempt", () => {
  it("rejects changed original request receipts even when the substituted graph is internally valid", async () => {
    const f = await fixture();
    const original = (await f.repository.findJob(f.scope, f.jobId))!;
    const changed = structuredClone(original);
    changed.request.createdByPrincipalId = "other_original_creator";
    changed.job.createdByPrincipalId = "other_original_creator";
    vi.spyOn(f.repository, "findJob")
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
    await expect(f.run()).rejects.toThrow("changed original request receipts");
    expect(f.seal).not.toHaveBeenCalled();
  });
  it.each(["transport", "stale_fence"] as const)(
    "does not classify a %s reclaim failure as a healthy lease",
    async (failure) => {
      const f = await fixture();
      const error =
        failure === "transport"
          ? new Error("transport_failed")
          : new PolicyEvaluationSchedulerTransitionError("stale_fence");
      vi.spyOn(f.repository, "reclaimJob").mockRejectedValueOnce(error);
      await expect(f.run()).rejects.toBe(error);
      expect(f.nextId).not.toHaveBeenCalled();
    },
  );
  it("does not treat an unknown claim failure as a deferred success", async () => {
    const f = await fixture(),
      failure = new Error("claim_transport_failed");
    vi.spyOn(f.repository, "claimJob").mockRejectedValueOnce(failure);
    await expect(f.run()).rejects.toBe(failure);
    expect(f.seal).not.toHaveBeenCalled();
  });
  it("observes cancellation that wins a claim race without claiming or sealing again", async () => {
    const f = await fixture();
    vi.spyOn(f.repository, "claimJob").mockImplementationOnce(async () => {
      await f.repository.cancelJob({
        scope: f.scope,
        jobId: f.jobId,
        cancellationId: "cancel_claim_race",
        principalId: "operator_claim_race",
        reason: "operator_requested",
      });
      throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
    });
    const result = await f.run();
    expect(result.disposition).toBe("observed_terminal");
    expect(result.job.job.status).toBe("cancelled");
    expect(f.seal).not.toHaveBeenCalled();
  });
  it.each(["normal", "lost_ack", "transport_error"] as const)(
    "rechecks native deadline crossed during claim (%s)",
    async (mode) => {
      const f = await fixture();
      const originalClaim = f.repository.claimJob.bind(f.repository),
        originalReclaim = f.repository.reclaimJob.bind(f.repository);
      let deadlineCrossed = false;
      const failure = new Error("deadline_probe_unavailable");
      vi.spyOn(f.repository, "claimJob").mockImplementationOnce(async (command) => {
        f.time.now = (await f.repository.findJob(f.scope, f.jobId))!.job.deadlineAt;
        deadlineCrossed = true;
        return originalClaim(command);
      });
      vi.spyOn(f.repository, "reclaimJob").mockImplementation(async (command) => {
        if (deadlineCrossed && mode === "transport_error") throw failure;
        const result = await originalReclaim(command);
        if (deadlineCrossed && mode === "lost_ack")
          throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
        return result;
      });
      if (mode === "transport_error") await expect(f.run()).rejects.toBe(failure);
      else {
        const result = await f.run();
        expect(result.disposition).toBe("observed_terminal");
        expect(result.job.job.status).toBe("timed_out");
      }
      expect(f.seal).not.toHaveBeenCalled();
    },
  );
  it("accepts a terminal budget observation returned by claim admission without fabricating a lease", async () => {
    const f = await fixture();
    vi.spyOn(f.repository, "claimJob").mockImplementationOnce(async () => {
      // Transport model of the existing exact final-history-slot transition, not memory persistence.
      const before = (await f.repository.findJob(f.scope, f.jobId))!;
      before.job.stateVersion = MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1;
      return exhaustPolicyEvaluationJobHistory(before, f.time.now);
    });
    const result = await f.run();
    expect(result.job.job.status).toBe("budget_exhausted");
    expect(result.evaluation).toBeNull();
    expect(f.seal).not.toHaveBeenCalled();
  });
  it.each(["seal_state", "seal_fence", "computation_state", "computation_fence"] as const)(
    "rejects a substituted %s receipt",
    async (fault) => {
      const f = await fixture();
      const changeFence = (job: Awaited<ReturnType<typeof f.repository.claimJob>>) => {
        const changed = structuredClone(job);
        changed.job.currentLease!.mutationFence.workerId = "worker_substituted";
        changed.attempts.at(-1)!.mutationFence.workerId = "worker_substituted";
        return changed;
      };
      if (fault.startsWith("seal")) {
        const seal = f.seal.getMockImplementation()!;
        f.seal.mockImplementationOnce(async (command) => {
          const before = (await f.repository.findJob(f.scope, f.jobId))!;
          const result = await seal(command);
          return { ...result, job: fault === "seal_state" ? before : changeFence(result.job) };
        });
      } else {
        const start = f.repository.startComputation.bind(f.repository);
        vi.spyOn(f.repository, "startComputation").mockImplementationOnce(async (command) => {
          if (fault === "computation_state") return (await f.repository.findJob(f.scope, f.jobId))!;
          return changeFence(await start(command));
        });
      }
      const error = await f.run().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(PolicyWorkerAttemptError);
      expect((error as PolicyWorkerAttemptError).cause).toBeInstanceOf(Error);
      expect((error as PolicyWorkerAttemptError).job.usage.ruleEvaluations).toBe(0);
    },
  );
  it("refuses missing original pages before charging computation", async () => {
    const f = await fixture();
    vi.spyOn(f.repository, "findSnapshot").mockResolvedValueOnce(null);
    const error = await f.run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PolicyWorkerAttemptError);
    expect((error as PolicyWorkerAttemptError).cause).toEqual(
      new Error("Policy worker omitted exact stored snapshot pages"),
    );
    expect((error as PolicyWorkerAttemptError).job.usage.ruleEvaluations).toBe(0);
  });
  it("refuses an absent result behind an already completed job without changing history", async () => {
    const f = await fixture();
    await f.run();
    const head = await f.repository.findHistoryHead(f.scope, f.jobId);
    vi.spyOn(f.repository, "findResult").mockResolvedValueOnce(null);
    await expect(f.run()).rejects.toThrow("Completed policy job omitted original result");
    expect(await f.repository.findHistoryHead(f.scope, f.jobId)).toEqual(head);
  });
  it("uses store-controlled reclaim after expiry instead of writing the old fence", async () => {
    const f = await fixture(),
      failure = new Error("content_took_too_long");
    f.seal.mockImplementationOnce(async () => {
      f.time.now = (await f.repository.findJob(f.scope, f.jobId))!.job.currentLease!.expiresAt;
      throw failure;
    });
    const error = await f.run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PolicyWorkerAttemptError);
    const job = (error as PolicyWorkerAttemptError).job;
    expect(job.job.currentLease).toBeNull();
    expect(job.attempts[0]?.closure).toMatchObject({
      status: "interrupted",
      reason: "lease_expired",
    });
  });
  it("preserves cancellation that already cleared the lease before failure settlement", async () => {
    const f = await fixture(),
      failure = new Error("capture_cancelled");
    f.seal.mockImplementationOnce(async () => {
      await f.repository.cancelJob({
        scope: f.scope,
        jobId: f.jobId,
        cancellationId: "cancel_before_settlement",
        principalId: "operator_cancel",
        reason: "operator_requested",
      });
      throw failure;
    });
    const error = await f.run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PolicyWorkerAttemptError);
    expect((error as PolicyWorkerAttemptError).job.job.status).toBe("cancelled");
    expect((error as PolicyWorkerAttemptError).cause).toBe(failure);
  });
  it.each(["state_conflict", "stale_fence"] as const)(
    "rereads a %s settlement race rather than overwriting cancellation",
    async (reason) => {
      const f = await fixture();
      f.seal.mockRejectedValueOnce(new Error("capture_failed"));
      vi.spyOn(f.repository, "interruptJob").mockImplementationOnce(async () => {
        await f.repository.cancelJob({
          scope: f.scope,
          jobId: f.jobId,
          cancellationId: "cancel_settlement_race",
          principalId: "operator_cancel",
          reason: "operator_requested",
        });
        throw new PolicyEvaluationSchedulerTransitionError(reason);
      });
      const error = await f.run().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(PolicyWorkerAttemptError);
      expect((error as PolicyWorkerAttemptError).job.job.status).toBe("cancelled");
    },
  );
  it("does not interrupt a replacement worker observed during settlement", async () => {
    const f = await fixture(),
      interrupt = f.repository.interruptJob.bind(f.repository);
    f.seal.mockRejectedValueOnce(new Error("capture_failed"));
    vi.spyOn(f.repository, "interruptJob").mockImplementationOnce(async (command) => {
      const closed = await interrupt(command);
      f.time.now = closed.job.retryAt!;
      await f.repository.claimJob({
        scope: f.scope,
        jobId: f.jobId,
        workerId: "worker_replacement",
        attemptId: "attempt_replacement",
        leaseId: "lease_replacement",
      });
      throw new PolicyEvaluationSchedulerTransitionError("stale_fence");
    });
    const error = await f.run().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PolicyWorkerAttemptError);
    expect((error as PolicyWorkerAttemptError).job.job.currentLease?.mutationFence.workerId).toBe(
      "worker_replacement",
    );
  });
  it.each(["state_conflict", "counter_exhausted"] as const)(
    "preserves an unresolved owning %s settlement failure",
    async (reason) => {
      const f = await fixture(),
        failure = new Error("capture_failed"),
        settlement = new PolicyEvaluationSchedulerTransitionError(reason);
      f.seal.mockRejectedValueOnce(failure);
      vi.spyOn(f.repository, "interruptJob").mockRejectedValueOnce(settlement);
      const error = await f.run().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([failure, settlement]);
    },
  );
  it("fails closed if the owning job disappears while an execution error is being settled", async () => {
    const f = await fixture(),
      failure = new Error("capture_failed");
    f.seal.mockImplementationOnce(async () => {
      vi.spyOn(f.repository, "findJob").mockResolvedValueOnce(null);
      throw failure;
    });
    const error = await f.run().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(failure);
    expect((error as AggregateError).errors[1]).toBeInstanceOf(PolicyWorkerJobUnavailableError);
  });
  it("preserves a completed result when only runtime cleanup fails", async () => {
    const f = await fixture(),
      failure = new Error("cleanup_failed");
    f.close.mockRejectedValueOnce(failure);
    await expect(f.run()).rejects.toBe(failure);
    const job = (await f.repository.findJob(f.scope, f.jobId))!;
    expect(job.job.status).toBe("completed");
    expect(job.usage.ruleEvaluations).toBe(f.inputs.rules.ruleCount);
  });
  it("authorizes a real service token and atomically completes one owning paid attempt", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.disposition).toBe("completed");
    expect(result.job.job.status).toBe("completed");
    expect(result.evaluation?.ruleCount).toBe(f.inputs.rules.ruleCount);
    expect(result.job.usage.ruleEvaluations).toBe(f.inputs.rules.ruleCount);
    expect(result.job.attempts[0]?.mutationFence.workerId).toBe(f.workerId);
    expect(f.seal).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("observes an existing completed receipt without another claim, seal or computation charge", async () => {
    const f = await fixture();
    const first = await f.run();
    const before = await f.repository.findHistoryHead(f.scope, f.jobId);
    const result = await f.run();
    expect(result).toEqual({ ...first, disposition: "observed_terminal" });
    expect(f.seal).toHaveBeenCalledOnce();
    expect(await f.repository.findHistoryHead(f.scope, f.jobId)).toEqual(before);
  });
  it("refuses API namespaces before payload access or runtime construction", async () => {
    const f = await fixture();
    const command = { ...f.command, serviceToken: "invalid" };
    Object.defineProperty(command, "delivery", {
      get() {
        throw new Error("payload_read");
      },
    });
    await expect(runPolicyWorkerAttempt(command, f.dependencies)).rejects.toThrow(
      "Service token is invalid",
    );
    expect(f.createRuntime).not.toHaveBeenCalled();
  });
  it.each(["capability", "type", "method"] as const)(
    "refuses a substituted %s before payload parsing",
    async (fault) => {
      const f = await fixture();
      const principal: PrincipalContext = {
        ...f.principal,
        ...(fault === "capability"
          ? { capabilities: [] }
          : fault === "type"
            ? { principalType: "workload" as const }
            : { authentication: { ...f.principal.authentication, method: "api_key" as const } }),
      };
      const command = { ...f.command };
      Object.defineProperty(command, "delivery", {
        get() {
          throw new Error("payload_read");
        },
      });
      await expect(
        runPolicyWorkerAttempt(command, {
          ...f.dependencies,
          authenticator: { authenticate: vi.fn(async () => principal) },
        }),
      ).rejects.not.toThrow("payload_read");
      expect(f.createRuntime).not.toHaveBeenCalled();
    },
  );
  it.each(["tenantId", "workerId", "fence", "outcomes"])(
    "rejects caller-owned %s fields before runtime creation",
    async (field) => {
      const f = await fixture();
      await expect(
        runPolicyWorkerAttempt(
          { ...f.command, delivery: { ...f.command.delivery, [field]: "not_allowed" } },
          f.dependencies,
        ),
      ).rejects.toThrow();
      expect(f.createRuntime).not.toHaveBeenCalled();
    },
  );
  it("denies a different environment before opening its runtime", async () => {
    const f = await fixture();
    await expect(
      runPolicyWorkerAttempt(
        { ...f.command, delivery: { ...f.command.delivery, environmentId: "outside_environment" } },
        f.dependencies,
      ),
    ).rejects.toThrow("cannot access environment");
    expect(f.createRuntime).not.toHaveBeenCalled();
  });
  it("closes its own runtime when the exact job is absent", async () => {
    const f = await fixture(false);
    await expect(f.run()).rejects.toBeInstanceOf(PolicyWorkerJobUnavailableError);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("defers a live lease without stealing another worker's attempt", async () => {
    const f = await fixture();
    const before = await f.repository.claimJob({
      scope: f.scope,
      jobId: f.jobId,
      workerId: "worker_other",
      attemptId: "attempt_other",
      leaseId: "lease_other",
    });
    const result = await f.run();
    expect(result.disposition).toBe("deferred");
    expect(result.job).toEqual(before);
    expect(f.nextId).not.toHaveBeenCalled();
    expect(f.seal).not.toHaveBeenCalled();
  });
  it("observes native-owned deadline closure before generating a new attempt", async () => {
    const f = await fixture();
    f.time.now = (await f.repository.findJob(f.scope, f.jobId))!.job.deadlineAt;
    const result = await f.run();
    expect(result.disposition).toBe("observed_terminal");
    expect(result.job.job.status).toBe("timed_out");
    expect(f.nextId).not.toHaveBeenCalled();
    expect(f.seal).not.toHaveBeenCalled();
  });
  it("defers the fixed retry backoff without changing its request, attempt history or work", async () => {
    const f = await fixture();
    const claimed = await f.repository.claimJob({
      scope: f.scope,
      jobId: f.jobId,
      workerId: f.workerId,
      attemptId: "attempt_interrupted",
      leaseId: "lease_interrupted",
    });
    const before = await f.repository.interruptJob({
      scope: f.scope,
      fence: claimed.job.currentLease!.mutationFence,
      reason: "worker_interrupted",
    });
    const result = await f.run();
    expect(result).toEqual({ disposition: "deferred", job: before, evaluation: null });
    expect(f.seal).not.toHaveBeenCalled();
  });
  it("burns unmeasurable started acquisition on failure and preserves its closed attempt", async () => {
    const f = await fixture(),
      failure = new Error("source_failed");
    f.seal.mockImplementationOnce(async ({ fence }) => {
      await f.repository.reserveAcquisition({
        scope: f.scope,
        fence,
        allowanceId: "allowance_attempt_failed",
      });
      throw failure;
    });
    const error = await f.run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PolicyWorkerAttemptError);
    expect((error as PolicyWorkerAttemptError).cause).toBe(failure);
    expect((error as PolicyWorkerAttemptError).phase).toBe("acquisition");
    const job = (await f.repository.findJob(f.scope, f.jobId))!;
    expect(job.acquisitionAllowance).toBeNull();
    expect(job.job.status).toBe("budget_exhausted");
    expect(job.usage.records).toBe(f.request.limits.maxAcquisitionRecords);
    expect(job.attempts[0]?.usageAtClose).toEqual(job.usage);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("retains paid computation and retries only the original seal on a fresh deciding fence", async () => {
    const f = await fixture();
    const publisher = vi
      .spyOn(f.repository, "publishResult")
      .mockRejectedValueOnce(new Error("publication_failed"));
    await expect(f.run()).rejects.toBeInstanceOf(PolicyWorkerAttemptError);
    const interrupted = (await f.repository.findJob(f.scope, f.jobId))!;
    expect(interrupted.job.status).toBe("retry_ready");
    expect(interrupted.usage.ruleEvaluations).toBe(f.inputs.rules.ruleCount);
    const original = structuredClone(interrupted.job.snapshot);
    f.time.now = interrupted.job.retryAt!;
    const result = await f.run();
    expect(result.disposition).toBe("completed");
    expect(result.job.job.snapshot).toEqual(original);
    expect(result.job.usage.ruleEvaluations).toBe(f.inputs.rules.ruleCount * 2);
    expect(result.job.attempts).toHaveLength(2);
    expect(f.seal).toHaveBeenCalledOnce();
    expect(publisher).toHaveBeenCalledTimes(2);
  });
  it("independently reads a committed result after a lost completion acknowledgement", async () => {
    const f = await fixture();
    const publish = f.repository.publishResult.bind(f.repository);
    vi.spyOn(f.repository, "publishResult").mockImplementationOnce(async (command) => {
      await publish(command);
      throw new Error("acknowledgement_lost");
    });
    const interrupt = vi.spyOn(f.repository, "interruptJob");
    const result = await f.run();
    expect(result.disposition).toBe("observed_terminal");
    expect(result.job.job.status).toBe("completed");
    expect(result.job.usage.ruleEvaluations).toBe(f.inputs.rules.ruleCount);
    expect(result.evaluation?.definitionSha256).toBe(result.job.job.result?.definitionSha256);
    expect(interrupt).not.toHaveBeenCalled();
  });
  it("keeps both the original failure and an unsuccessful attempt settlement", async () => {
    const f = await fixture(),
      original = new Error("source_failed"),
      settlement = new Error("settlement_failed");
    f.seal.mockRejectedValueOnce(original);
    vi.spyOn(f.repository, "interruptJob").mockRejectedValueOnce(settlement);
    const error = await f.run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([original, settlement]);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("preserves operational failure together with runtime cleanup failure", async () => {
    const f = await fixture(false),
      cleanup = new Error("close_failed");
    f.close.mockRejectedValueOnce(cleanup);
    const error = await f.run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBeInstanceOf(PolicyWorkerJobUnavailableError);
    expect((error as AggregateError).errors[1]).toBe(cleanup);
  });
});
