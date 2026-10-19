import {
  ReleaseApprovalReviewerReceiptSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionSessionStateSchema,
  ReleaseDecisionUserIdentityReferenceSchema,
} from "@proofstack/contracts";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";
import { prepareReleaseReviewerPublicationMaterial } from "../release/release-reviewer-publication.js";
import {
  authorityVersion,
  releaseReviewerAuthorityRepositoryFixture,
} from "./release-reviewer-authority-repository-fixtures.js";

export const reviewerPublicationFixtureBudget = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 10000,
    maxAcquisitionRecordBytes: 16 * 1024 * 1024,
    maxApprovalRecords: 0,
  });

/** Synthetic safe preimages only; neither actual authentication nor reviewer expertise. */
export function releaseReviewerPublicationFixture(
  kind: "authority" | "lifecycle" = "authority",
  issuedAt = kind === "authority" ? "2026-10-15T12:10:00.000001Z" : "2026-10-15T12:11:00.000002Z",
) {
  const base = releaseReviewerAuthorityRepositoryFixture("reviewer_publication");
  const record = authorityVersion(base.original, {}, issuedAt);
  const identity = ReleaseDecisionUserIdentityReferenceSchema.parse({
    kind: "oidc_binding",
    principalId: record.issuerPrincipalId,
    bindingId: "binding_reviewer_administrator",
  });
  const actor = ReleaseApprovalReviewerReceiptSchema.parse({
    principalId: identity.principalId,
    principalType: "user",
    authenticationMethod: "oidc",
    authenticatedAt: "2026-10-15T12:00:00.000Z",
    credentialId: "session_reviewer_administrator",
    requestId: "request_검토_😀",
  });
  const grant = ReleaseDecisionIdentityGrantSchema.parse({
    identity,
    tenantId: record.scope.tenantId,
    state: "active",
    revision: 2,
    updatedAt: "2026-10-15T11:00:00.000001Z",
    roles: ["member"],
    capabilities: ["approval:authority:manage"],
    resourceScope: {
      mode: "restricted",
      projects: [
        { projectId: record.scope.projectId, environmentIds: [record.scope.environmentId] },
      ],
    },
  });
  const credential = ReleaseDecisionSessionStateSchema.parse({
    schemaVersion: "0.1",
    kind: "oidc_session",
    credentialId: actor.credentialId,
    principalId: actor.principalId,
    tenantId: record.scope.tenantId,
    bindingId: identity.bindingId,
    createdAt: "2026-10-15T12:00:00.000001Z",
    absoluteExpiresAt: "2026-10-15T13:00:00.000001Z",
    idleExpiresAt: "2026-10-15T12:30:10.000001Z",
    idleLifetimeSeconds: 1800,
    lastUsedAt: "2026-10-15T12:00:10.000001Z",
    useCount: 1,
    revokedAt: null,
    revocationReason: null,
  });
  return prepareReleaseReviewerPublicationMaterial({
    scope: record.scope,
    source:
      kind === "authority"
        ? { kind: "release_reviewer_authority", record }
        : {
            kind: "release_reviewer_authority_lifecycle",
            record: {
              ...base.revocation,
              actorPrincipalId: actor.principalId,
              occurredAt: issuedAt,
            },
          },
    actor,
    identity,
    grant,
    credential,
    issuedAt,
    budget: reviewerPublicationFixtureBudget(),
  });
}
