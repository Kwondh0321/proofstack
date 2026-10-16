import {
  ReleaseApprovalIntentSchema,
  ReleaseApprovalSchema,
  type EvidenceScope,
  type ReleaseApproval,
  type ReleaseApprovalIntent,
  type ReleaseApprovalRevocation,
  type ReleaseApprovalSubject,
} from "@proofstack/contracts";
import type { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

/** Current authentication/authorization must precede retry admission in the future service/native boundary.
 * Derived current authority/login/time are not a new intent and cannot freshen the first stored receipt.
 */
export function releaseApprovalRetryIntent(record: ReleaseApproval): {
  readonly intent: ReleaseApprovalIntent;
  readonly reviewerPrincipalId: string;
} {
  const {
    schemaVersion: _version,
    definitionSha256: _sha,
    reviewer,
    authority: _authority,
    recordedAt: _at,
    ...intent
  } = ReleaseApprovalSchema.parse(record);
  return {
    intent: ReleaseApprovalIntentSchema.parse(intent),
    reviewerPrincipalId: reviewer.principalId,
  };
}
export interface OwnedReleaseApprovalSubject {
  readonly records: readonly ReleaseApproval[];
  readonly revocations: readonly ReleaseApprovalRevocation[];
}
/** Trusted declaration persistence only, never actual private authentication, quorum or decision authority. */
export interface ReleaseApprovalRepository {
  findReleaseApproval(scope: EvidenceScope, approvalId: string): Promise<ReleaseApproval | null>;
  findReleaseApprovalRevocation(
    scope: EvidenceScope,
    eventId: string,
  ): Promise<ReleaseApprovalRevocation | null>;
  publishReleaseApproval(
    record: ReleaseApproval,
  ): Promise<{ readonly created: boolean; readonly approval: ReleaseApproval }>;
  publishReleaseApprovalRevocation(
    event: ReleaseApprovalRevocation,
  ): Promise<{ readonly created: boolean; readonly event: ReleaseApprovalRevocation }>;
  /** Full exact original subject/kind inventory, including expired, opposing, superseded and revoked
   * actions. One original server meter; no caller action list, latest query or budget-truncated prefix.
   * The caller derives the subject through owning originals. This read retains no native guards.
   */
  readReleaseApprovalSubject(
    scope: EvidenceScope,
    kind: ReleaseApproval["kind"],
    subject: ReleaseApprovalSubject,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<OwnedReleaseApprovalSubject>;
}
export class ReleaseApprovalRepositoryError extends Error {
  readonly code = "release_approval_repository_invalid";
  constructor(
    readonly reason:
      | "approval_conflict"
      | "supersession_conflict"
      | "revocation_conflict"
      | "revocation_state_conflict"
      | "lineage_invalid"
      | "receipt_invalid"
      | "scope_mismatch"
      | "storage_invalid",
    options?: ErrorOptions,
  ) {
    super(`Invalid release approval persistence: ${reason}`, options);
    this.name = "ReleaseApprovalRepositoryError";
  }
}
