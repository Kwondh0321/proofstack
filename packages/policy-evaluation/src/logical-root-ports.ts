import type {
  ComparisonLogicalRootReader,
  EvaluationLogicalRootReader,
  ReleaseCandidateLogicalRootReader,
  ReleasePolicyLogicalRootReader,
} from "@proofstack/core";
import type { RegressionLogicalRootReader } from "@proofstack/datasets";

/** Fixed owning original bindings; no caller-selected root, SQL, content or publication port. */
export interface PolicyEvaluationLogicalRootPorts {
  readonly evaluation: EvaluationLogicalRootReader;
  readonly comparison: ComparisonLogicalRootReader;
  readonly releaseCandidate: ReleaseCandidateLogicalRootReader;
  readonly releasePolicy: ReleasePolicyLogicalRootReader;
  readonly datasets: RegressionLogicalRootReader;
}
