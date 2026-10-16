import type {
  EvidenceScope,
  ReleaseCandidate,
  ReleaseDecisionInput,
  ReleasePolicy,
  ReleasePolicySelection,
} from "@proofstack/contracts";
import type { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

/** Original planning witnesses, not a current authority snapshot or a completed evaluation. */
export interface ReleaseDecisionInputGraph {
  readonly request: ReleaseDecisionInput;
  readonly candidate: ReleaseCandidate;
  readonly selection: ReleasePolicySelection;
  readonly policies: readonly ReleasePolicy[];
}
/** Trusted immutable storage. Actual authentication, owning source acquisition, atomic native
 * job reservation and current publication authority are separate fixed service boundaries.
 */
export interface ReleaseDecisionInputRepository {
  findReleaseDecisionInput(
    scope: EvidenceScope,
    requestId: string,
    budget?: ReleaseDecisionVerificationBudget,
  ): Promise<ReleaseDecisionInputGraph | null>;
  publishReleaseDecisionInput(
    graph: ReleaseDecisionInputGraph,
  ): Promise<{ readonly created: boolean; readonly graph: ReleaseDecisionInputGraph }>;
}
export class ReleaseDecisionInputRepositoryError extends Error {
  readonly code = "release_decision_input_repository_invalid";
  constructor(
    readonly reason: "input_conflict" | "planned_request_conflict" | "storage_invalid",
    options?: ErrorOptions,
  ) {
    super("Original release decision input storage was rejected", options);
    this.name = "ReleaseDecisionInputRepositoryError";
  }
}
/** Only original public intent and the accountable principal enter retry equality. Fresh login,
 * native cut, server limits and derived planned definitions cannot replace the first graph.
 */
export function releaseDecisionInputRetryIntent(input: ReleaseDecisionInput) {
  return {
    scope: input.scope,
    decisionInputRequestId: input.decisionInputRequestId,
    candidate: input.candidate,
    selection: input.selection,
    rationale: input.rationale,
    publisher: {
      principalId: input.publisher.principalId,
      principalType: input.publisher.principalType,
      authenticationMethod: input.publisher.authenticationMethod,
    },
  };
}
