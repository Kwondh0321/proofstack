import type {
  EvidenceScope,
  PolicyEvaluationRequest,
  PolicyEvaluationJobSnapshot,
  PolicyEvaluationWorkerMutationFence,
  PolicyEvaluationUsage,
  PolicyEvaluationCancellation,
} from "@proofstack/contracts";

/** Internal store operations. Server clock/epoch and publication authority are never caller fields. */
export interface PolicyEvaluationJobRepository {
  createJob(command: {
    readonly request: PolicyEvaluationRequest;
    readonly jobId: string;
  }): Promise<{ readonly created: boolean; readonly snapshot: PolicyEvaluationJobSnapshot }>;
  findJob(scope: EvidenceScope, jobId: string): Promise<PolicyEvaluationJobSnapshot | null>;
  reclaimJob(command: {
    readonly scope: EvidenceScope;
    readonly jobId: string;
  }): Promise<PolicyEvaluationJobSnapshot>;
  claimJob(command: {
    readonly scope: EvidenceScope;
    readonly jobId: string;
    readonly workerId: string;
    readonly attemptId: string;
    readonly leaseId: string;
  }): Promise<PolicyEvaluationJobSnapshot>;
  heartbeatJob(command: {
    readonly scope: EvidenceScope;
    readonly fence: PolicyEvaluationWorkerMutationFence;
  }): Promise<PolicyEvaluationJobSnapshot>;
  reserveUsage(command: {
    readonly scope: EvidenceScope;
    readonly fence: PolicyEvaluationWorkerMutationFence;
    readonly delta: PolicyEvaluationUsage;
  }): Promise<PolicyEvaluationJobSnapshot>;
  interruptJob(command: {
    readonly scope: EvidenceScope;
    readonly fence: PolicyEvaluationWorkerMutationFence;
    readonly reason:
      | "source_revision_changed"
      | "source_temporarily_unavailable"
      | "worker_interrupted";
  }): Promise<PolicyEvaluationJobSnapshot>;
  cancelJob(command: {
    readonly scope: EvidenceScope;
    readonly jobId: string;
    readonly cancellationId: string;
    readonly principalId: string;
    readonly reason: PolicyEvaluationCancellation["reason"];
  }): Promise<PolicyEvaluationJobSnapshot>;
}
export class PolicyEvaluationJobNotFoundError extends Error {
  readonly code = "policy_evaluation_job_not_found";
  constructor() {
    super("Policy evaluation job was not found in its exact scope");
    this.name = "PolicyEvaluationJobNotFoundError";
  }
}
export class PolicyEvaluationRequestConflictError extends Error {
  readonly code = "policy_evaluation_request_conflict";
  constructor() {
    super("Policy evaluation request or job identity already binds different semantic input");
    this.name = "PolicyEvaluationRequestConflictError";
  }
}
