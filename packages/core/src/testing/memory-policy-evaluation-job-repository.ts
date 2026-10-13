import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PolicyEvaluationTimeSchema,
  PolicyEvaluationJobSnapshotSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationJobRepository,
  PolicyEvaluationJobNotFoundError,
  PolicyEvaluationRequestConflictError,
} from "../policy/policy-evaluation-job-repository.js";
import { validatePolicyEvaluationRequestRecord } from "../policy/policy-evaluation-request-record-validation.js";
import {
  digestPolicyEvaluationJobDefinition,
  validatePolicyEvaluationJobSnapshotRecord,
} from "../policy/policy-evaluation-job-record-validation.js";
import { addPolicyEvaluationMilliseconds } from "../policy/policy-evaluation-scheduler-time.js";
import {
  claimPolicyEvaluationJob,
  heartbeatPolicyEvaluationJob,
} from "../policy/policy-evaluation-scheduler-claim.js";
import { reservePolicyEvaluationUsage } from "../policy/policy-evaluation-scheduler-budget.js";
import { cancelPolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-cancel.js";
import { interruptPolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-interrupt.js";
import { reclaimPolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-reclaim.js";

/** Atomic synchronous map commit, inside async ports. No I/O/await occurs between read and swap. */
export class MemoryPolicyEvaluationJobRepository implements PolicyEvaluationJobRepository {
  private readonly records = new Map<string, PolicyEvaluationJobSnapshot>();
  private readonly requests = new Map<string, string>();
  private recoveryEpoch = 0;
  constructor(private readonly clock: { now(): string }) {}
  private key(scope: EvidenceScope, id: string): string {
    return serializeEvaluationCanonicalJson([
      EvidenceScopeSchema.parse(scope),
      OpaqueIdSchema.parse(id),
    ]);
  }
  private inspect(
    snapshot: PolicyEvaluationJobSnapshot,
    scope = snapshot.job.scope,
    id = snapshot.job.jobId,
  ) {
    return validatePolicyEvaluationJobSnapshotRecord({
      expected: {
        scope,
        job: { jobId: id, definitionSha256: snapshot.job.definitionSha256 },
      },
      snapshot,
    });
  }
  private read(scope: EvidenceScope, id: string) {
    const key = this.key(scope, id);
    const record = this.records.get(key);
    if (!record) throw new PolicyEvaluationJobNotFoundError();
    return { key, snapshot: this.inspect(record, scope, id) };
  }
  async createJob(command: Parameters<PolicyEvaluationJobRepository["createJob"]>[0]) {
    const request = validatePolicyEvaluationRequestRecord(command.request);
    const jobId = OpaqueIdSchema.parse(command.jobId);
    const requestKey = this.key(request.scope, request.evaluationRequestId);
    const existing = this.requests.get(requestKey);
    if (existing) {
      const record = this.records.get(existing);
      if (!record) throw new Error("Stored request has no atomic job binding");
      const snapshot = this.inspect(record, request.scope);
      if (snapshot.request.definitionSha256 !== request.definitionSha256)
        throw new PolicyEvaluationRequestConflictError();
      return { created: false, snapshot };
    }
    const key = this.key(request.scope, jobId);
    if (this.records.has(key)) throw new PolicyEvaluationRequestConflictError();
    const now = PolicyEvaluationTimeSchema.parse(this.clock.now());
    const reference = {
      evaluationRequestId: request.evaluationRequestId,
      definitionSha256: request.definitionSha256,
    };
    const snapshot = PolicyEvaluationJobSnapshotSchema.parse({
      request,
      attempts: [],
      cancellation: null,
      usage: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: 0,
      },
      job: {
        schemaVersion: "0.1",
        jobId,
        scope: request.scope,
        request: reference,
        definitionSha256: digestPolicyEvaluationJobDefinition(request.scope, {
          jobId,
          request: reference,
        }),
        createdAt: now,
        createdByPrincipalId: request.createdByPrincipalId,
        updatedAt: now,
        deadlineAt: addPolicyEvaluationMilliseconds(
          request.createdAt,
          request.limits.totalDeadlineMilliseconds,
        ),
        stateVersion: 1,
        recoveryEpoch: this.recoveryEpoch,
        lastFencingToken: 0,
        attemptCount: 0,
        status: "queued",
        currentLease: null,
        snapshot: null,
        result: null,
        retryAt: null,
        terminal: null,
      },
    });
    const admitted = this.inspect(snapshot);
    this.records.set(key, admitted);
    this.requests.set(requestKey, key);
    return { created: true, snapshot: structuredClone(admitted) };
  }
  async findJob(scope: EvidenceScope, jobId: string) {
    const record = this.records.get(this.key(scope, jobId));
    return record ? this.inspect(record, scope, jobId) : null;
  }
  private mutate(
    scope: EvidenceScope,
    id: string,
    work: (snapshot: PolicyEvaluationJobSnapshot, now: string) => PolicyEvaluationJobSnapshot,
  ) {
    const { key, snapshot } = this.read(scope, id);
    const result = this.inspect(
      work(snapshot, PolicyEvaluationTimeSchema.parse(this.clock.now())),
      scope,
      id,
    );
    this.records.set(key, result);
    return structuredClone(result);
  }
  async claimJob(command: Parameters<PolicyEvaluationJobRepository["claimJob"]>[0]) {
    return this.mutate(command.scope, command.jobId, (snapshot, now) =>
      claimPolicyEvaluationJob({
        snapshot,
        now,
        recoveryEpoch: this.recoveryEpoch,
        workerId: command.workerId,
        attemptId: command.attemptId,
        leaseId: command.leaseId,
      }),
    );
  }
  async reclaimJob(command: Parameters<PolicyEvaluationJobRepository["reclaimJob"]>[0]) {
    return this.mutate(command.scope, command.jobId, (snapshot, now) =>
      reclaimPolicyEvaluationJob({ snapshot, now, recoveryEpoch: this.recoveryEpoch }),
    );
  }
  async heartbeatJob(command: Parameters<PolicyEvaluationJobRepository["heartbeatJob"]>[0]) {
    return this.mutate(command.scope, command.fence.jobId, (snapshot, now) =>
      heartbeatPolicyEvaluationJob({
        snapshot,
        now,
        recoveryEpoch: this.recoveryEpoch,
        fence: command.fence,
      }),
    );
  }
  async reserveUsage(command: Parameters<PolicyEvaluationJobRepository["reserveUsage"]>[0]) {
    return this.mutate(command.scope, command.fence.jobId, (snapshot, now) =>
      reservePolicyEvaluationUsage({
        snapshot,
        now,
        recoveryEpoch: this.recoveryEpoch,
        fence: command.fence,
        delta: command.delta,
      }),
    );
  }
  async interruptJob(command: Parameters<PolicyEvaluationJobRepository["interruptJob"]>[0]) {
    return this.mutate(command.scope, command.fence.jobId, (snapshot, now) =>
      interruptPolicyEvaluationJob({
        snapshot,
        now,
        recoveryEpoch: this.recoveryEpoch,
        fence: command.fence,
        reason: command.reason,
      }),
    );
  }
  async cancelJob(command: Parameters<PolicyEvaluationJobRepository["cancelJob"]>[0]) {
    return this.mutate(command.scope, command.jobId, (snapshot, now) =>
      cancelPolicyEvaluationJob({
        snapshot,
        intent: {
          jobId: command.jobId,
          scope: command.scope,
          cancellationId: snapshot.cancellation?.cancellationId ?? command.cancellationId,
          requestedAt: now,
          requestedByPrincipalId: command.principalId,
          reason: command.reason,
        },
      }),
    );
  }
}
