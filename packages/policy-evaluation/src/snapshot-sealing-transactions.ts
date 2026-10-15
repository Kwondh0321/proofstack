import type {
  EvidenceScope,
  PolicyEvaluationJobSnapshot,
  PolicyEvaluationSnapshot,
  PolicyEvaluationSnapshotPageSet,
  PolicyEvaluationWorkerMutationFence,
  PolicyEvaluationAcquisitionUsage,
} from "@proofstack/contracts";
import type { PolicyEvaluationMetadataPorts } from "./metadata-transactions.js";

export interface PolicyEvaluationSnapshotSealReceipt {
  readonly snapshot: PolicyEvaluationSnapshot;
  readonly job: PolicyEvaluationJobSnapshot;
}
/** Trusted worker composition only. Page definitions are produced internally while guards are held. */
export interface PolicyEvaluationSnapshotSealingPorts extends PolicyEvaluationMetadataPorts {
  /** Fixed same-client settlement; no independent transaction while this port holds the job. */
  settleAcquisition?(
    allowanceId: string,
    usage: PolicyEvaluationAcquisitionUsage,
  ): Promise<PolicyEvaluationJobSnapshot>;
  publishSnapshot(
    definition: PolicyEvaluationSnapshotPageSet,
    principalId: string,
  ): Promise<PolicyEvaluationSnapshotSealReceipt>;
}
/** Locks current job/attempt before metadata guards; retains one client/fence through publication. */
export interface PolicyEvaluationSnapshotSealingTransactions {
  runSealing<T>(
    command: { readonly scope: EvidenceScope; readonly fence: PolicyEvaluationWorkerMutationFence },
    operation: (ports: PolicyEvaluationSnapshotSealingPorts) => Promise<T>,
  ): Promise<T>;
}
