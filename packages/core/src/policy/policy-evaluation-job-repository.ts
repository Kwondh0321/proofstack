import type {
  EvidenceScope,
  PolicyEvaluationRequest,
  PolicyEvaluationJobSnapshot,
  PolicyEvaluationWorkerMutationFence,
  PolicyEvaluationUsage,
  PolicyEvaluationCancellation,
  PolicyEvaluationJobHistoryHead,
  PolicyEvaluationJobHistoryPage,
  PolicyEvaluationJobHistoryEntry,
} from "@proofstack/contracts";

/** Internal store operations. Server clock/epoch and publication authority are never caller fields. */
export interface PolicyEvaluationJobReader {
  findJob(scope: EvidenceScope, jobId: string): Promise<PolicyEvaluationJobSnapshot | null>;
  findHistoryHead(
    scope: EvidenceScope,
    jobId: string,
  ): Promise<PolicyEvaluationJobHistoryHead | null>;
  readHistoryPage(
    head: PolicyEvaluationJobHistoryHead,
    pageIndex: number,
  ): Promise<PolicyEvaluationJobHistoryPage>;
}
export interface PolicyEvaluationJobControlRepository extends PolicyEvaluationJobReader {
  createJob(command: {
    readonly request: PolicyEvaluationRequest;
    readonly jobId: string;
  }): Promise<{ readonly created: boolean; readonly snapshot: PolicyEvaluationJobSnapshot }>;
  cancelJob(command: {
    readonly scope: EvidenceScope;
    readonly jobId: string;
    readonly cancellationId: string;
    readonly principalId: string;
    readonly reason: PolicyEvaluationCancellation["reason"];
  }): Promise<PolicyEvaluationJobSnapshot>;
}
export interface PolicyEvaluationJobWorkerRepository extends PolicyEvaluationJobReader {
  reserveWork(command: {
    readonly scope: EvidenceScope;
    readonly fence: PolicyEvaluationWorkerMutationFence;
    readonly reservationId: string;
    readonly delta: PolicyEvaluationUsage;
  }): Promise<{
    readonly created: boolean;
    readonly snapshot: PolicyEvaluationJobSnapshot;
    readonly reservation: PolicyEvaluationJobHistoryEntry | null;
  }>;
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
}
/** Admission on an already published owning snapshot. No source acquisition or result publication. */
export interface PolicyEvaluationJobComputationRepository extends PolicyEvaluationJobReader {
  startComputation(command: {
    readonly scope: EvidenceScope;
    readonly fence: PolicyEvaluationWorkerMutationFence;
  }): Promise<PolicyEvaluationJobSnapshot>;
}
/** Memory/conformance aggregate only. Native composition uses separate control/worker pools. */
export interface PolicyEvaluationJobRepository
  extends PolicyEvaluationJobControlRepository,
    PolicyEvaluationJobWorkerRepository {}
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
