import {
  ReleaseApprovalReviewerReceiptSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionSessionStateSchema,
  ReleaseDecisionUserIdentityReferenceSchema,
} from "@proofstack/contracts";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";
import { prepareReleaseSelectionPublicationMaterial } from "../release/release-selection-publication.js";
import {
  releasePolicySelectionRepositoryFixture,
  selectionVersion,
} from "./release-policy-selection-repository-fixtures.js";

export const selectionPublicationFixtureBudget = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 10000,
    maxAcquisitionRecordBytes: 16 * 1024 * 1024,
    maxApprovalRecords: 0,
  });

/** Synthetic original safe preimages only, not a real login or native publication origin. */
export function releaseSelectionPublicationFixture(kind: "selection" | "lifecycle" = "selection") {
  const base = releasePolicySelectionRepositoryFixture("publication");
  const issuedAt = "2026-10-15T12:10:00.000001Z";
  const record = selectionVersion(base.original, {}, issuedAt);
  const identity = ReleaseDecisionUserIdentityReferenceSchema.parse({
    kind: "oidc_binding",
    principalId: record.issuerPrincipalId,
    bindingId: "binding_installer",
  });
  const actor = ReleaseApprovalReviewerReceiptSchema.parse({
    principalId: identity.principalId,
    principalType: "user",
    authenticationMethod: "oidc",
    authenticatedAt: "2026-10-15T12:00:00.000Z",
    credentialId: "session_installer",
    requestId: "request_설치_😀",
  });
  const grant = ReleaseDecisionIdentityGrantSchema.parse({
    identity,
    tenantId: record.scope.tenantId,
    state: "active",
    revision: 2,
    updatedAt: "2026-10-15T11:00:00.000001Z",
    roles: ["member"],
    capabilities: ["release:selection:manage"],
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
  return prepareReleaseSelectionPublicationMaterial({
    scope: record.scope,
    source:
      kind === "selection"
        ? { kind: "release_policy_selection", record }
        : {
            kind: "release_policy_selection_lifecycle",
            record: {
              ...base.withdrawal,
              actorPrincipalId: actor.principalId,
              occurredAt: issuedAt,
            },
          },
    actor,
    identity,
    grant,
    credential,
    issuedAt,
    budget: selectionPublicationFixtureBudget(),
  });
}
