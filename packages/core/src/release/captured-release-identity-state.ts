import {
  EvidenceScopeSchema,
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  ReleaseDecisionCredentialObservationSchema,
  ReleaseDecisionIdentityObservationSchema,
  ReleaseDecisionIdentityReferenceSchema,
  ReleaseDecisionPublisherReceiptSchema,
  serializeEvaluationCanonicalJson,
  type Capability,
  type EvidenceScope,
  type ReleaseDecisionCredentialObservation,
  type ReleaseDecisionIdentityObservation,
  type ReleaseDecisionIdentityReference,
  type ReleaseDecisionPublisherReceipt,
} from "@proofstack/contracts";
import { requireEnvironmentAccess } from "../auth/authorization.js";
import { ForbiddenError } from "../errors.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

const capabilities = {
  publish_decision: "release:decision:publish",
  create_approval: "approval:decide",
  retain_review: "approval:decide",
  manage_selection: "release:selection:manage",
  manage_reviewer_authority: "approval:authority:manage",
} as const satisfies Record<string, Capability>;
export type CapturedReleaseIdentityOperation = keyof typeof capabilities;
export type CapturedReleaseIdentityState =
  | { readonly state: "eligible"; readonly credentialLimit: string | null }
  | {
      readonly state: "unavailable";
      readonly reason: "identity_unavailable" | "credential_unavailable";
    }
  | {
      readonly state: "ineligible";
      readonly reason:
        | "principal_type_not_allowed"
        | "identity_inactive"
        | "capability_missing"
        | "scope_denied"
        | "credential_revoked"
        | "credential_expired";
    };
export class InvalidCapturedReleaseIdentityError extends Error {
  readonly code = "captured_release_identity_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid exact captured release identity state", options);
    this.name = "InvalidCapturedReleaseIdentityError";
  }
}
function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}
function millisecondFloor(value: bigint): bigint {
  const unit = POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND;
  return value - (((value % unit) + unit) % unit);
}

/**
 * Inspect retained public preimages, never authenticate a cookie/token or confer publication.
 * Native composition must independently verify actual private proof and retain all guards.
 * Natural expiry of an old login does not revoke an already-recorded review; explicit credential
 * revocation and current binding/grant changes still apply. Every new action requires a live login.
 */
export function inspectCapturedReleaseIdentityState(input: {
  readonly scope: EvidenceScope;
  readonly receipt: ReleaseDecisionPublisherReceipt;
  readonly identity: ReleaseDecisionIdentityReference;
  readonly grant: ReleaseDecisionIdentityObservation;
  readonly credential: ReleaseDecisionCredentialObservation;
  readonly capturedAt: string;
  readonly operation: CapturedReleaseIdentityOperation;
  readonly budget: ReleaseDecisionVerificationBudget;
}): CapturedReleaseIdentityState {
  try {
    const scope = EvidenceScopeSchema.parse(input.scope);
    const receipt = ReleaseDecisionPublisherReceiptSchema.parse(input.receipt);
    const identity = ReleaseDecisionIdentityReferenceSchema.parse(input.identity);
    const cut = policyEvaluationTimestampOrderKey(
      PolicyEvaluationTimeSchema.parse(input.capturedAt),
    );
    if (!Object.hasOwn(capabilities, input.operation))
      throw new InvalidCapturedReleaseIdentityError();
    input.budget.observe(input.grant);
    input.budget.observe(input.credential);
    const grant = ReleaseDecisionIdentityObservationSchema.parse(input.grant);
    const credential = ReleaseDecisionCredentialObservationSchema.parse(input.credential);
    if (
      identity.principalId !== receipt.principalId ||
      !same(grant.reference, identity) ||
      (identity.kind === "oidc_binding") !== (receipt.principalType === "user") ||
      (identity.kind === "service_credential" && identity.credentialId !== receipt.credentialId) ||
      !same(credential.reference, {
        kind: receipt.principalType === "user" ? "oidc_session" : "service_credential",
        principalId: receipt.principalId,
        credentialId: receipt.credentialId,
      })
    )
      throw new InvalidCapturedReleaseIdentityError();
    if (receipt.principalType !== "user" && input.operation !== "publish_decision")
      return { state: "ineligible", reason: "principal_type_not_allowed" };
    if (grant.state !== "observed") return { state: "unavailable", reason: "identity_unavailable" };
    if (credential.state !== "observed")
      return { state: "unavailable", reason: "credential_unavailable" };
    const value = credential.record;
    const created = policyEvaluationTimestampOrderKey(value.createdAt);
    const authenticated = policyEvaluationTimestampOrderKey(receipt.authenticatedAt);
    if (
      grant.record.tenantId !== scope.tenantId ||
      value.tenantId !== scope.tenantId ||
      !same(grant.record.identity, identity) ||
      policyEvaluationTimestampOrderKey(grant.record.updatedAt) > cut ||
      created > cut ||
      authenticated > cut ||
      (value.revokedAt !== null && policyEvaluationTimestampOrderKey(value.revokedAt) > cut) ||
      (value.kind === "oidc_session" &&
        value.lastUsedAt !== null &&
        policyEvaluationTimestampOrderKey(value.lastUsedAt) > cut)
    )
      throw new InvalidCapturedReleaseIdentityError();
    if (value.kind === "oidc_session") {
      if (
        identity.kind !== "oidc_binding" ||
        value.bindingId !== identity.bindingId ||
        authenticated !== millisecondFloor(created)
      )
        throw new InvalidCapturedReleaseIdentityError();
    } else if (authenticated < millisecondFloor(created))
      throw new InvalidCapturedReleaseIdentityError();
    if (grant.record.state !== "active")
      return { state: "ineligible", reason: "identity_inactive" };
    if (!grant.record.capabilities.includes(capabilities[input.operation]))
      return { state: "ineligible", reason: "capability_missing" };
    try {
      requireEnvironmentAccess(grant.record, scope.projectId, scope.environmentId);
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
      return { state: "ineligible", reason: "scope_denied" };
    }
    if (value.revokedAt !== null) return { state: "ineligible", reason: "credential_revoked" };
    if (input.operation === "retain_review") return { state: "eligible", credentialLimit: null };
    const credentialLimit =
      value.kind === "service_credential" ? value.expiresAt : value.idleExpiresAt;
    if (policyEvaluationTimestampOrderKey(credentialLimit) <= cut)
      return { state: "ineligible", reason: "credential_expired" };
    return { state: "eligible", credentialLimit };
  } catch (cause) {
    if (
      cause instanceof InvalidCapturedReleaseIdentityError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidCapturedReleaseIdentityError({ cause });
  }
}
