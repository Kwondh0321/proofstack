import type {
  EvidenceScope,
  PolicyEvaluation,
  PolicyEvaluationJobSnapshot,
  PolicyEvaluationSnapshotPageSet,
  PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";

/** Fixed internal worker publication. Original identity comes from the store's owning job. */
export interface PolicyEvaluationResultPublisher {
  publishResult(command: {
    readonly scope: EvidenceScope;
    readonly fence: PolicyEvaluationWorkerMutationFence;
    readonly evaluationId: string;
    readonly pageSet: PolicyEvaluationSnapshotPageSet;
  }): Promise<{
    readonly created: boolean;
    readonly evaluation: PolicyEvaluation;
    readonly snapshot: PolicyEvaluationJobSnapshot;
  }>;
}
/** Historical exact reads must recompute original sealed evidence, never consult newer sources. */
export interface PolicyEvaluationResultReader {
  findResult(
    scope: EvidenceScope,
    jobId: string,
    pageSet: PolicyEvaluationSnapshotPageSet,
  ): Promise<PolicyEvaluation | null>;
}
