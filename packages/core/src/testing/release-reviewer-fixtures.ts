import { readFileSync } from "node:fs";
import {
  ReleaseReviewerAuthorityDefinitionSchema,
  ReleaseReviewerAuthoritySchema,
  ReleaseDecisionIdentityReferenceSchema,
  ReleaseDecisionIdentityObservationSchema,
  ReleaseDecisionCredentialObservationSchema,
  ReleaseApprovalReviewerReceiptSchema,
  type ReleaseReviewerAuthorityDefinition,
  type ReleaseReviewerAuthorityLifecycleEvent,
} from "@proofstack/contracts";
import {
  digestReleaseReviewerAuthorityDefinition,
  releaseReviewerAuthorityReference,
} from "../release/release-authority-record-validation.js";
import type { CapturedReleaseReviewContext } from "../release/captured-release-reviewer-eligibility.js";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";

/** Synthetic immutable preimages for tests; no real authentication or expertise certification. */
export function capturedReleaseReviewerFixture(
  patch: Partial<ReleaseReviewerAuthorityDefinition> = {},
) {
  const vector = JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/release-approval-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ).vectors[0];
  const definition = ReleaseReviewerAuthorityDefinitionSchema.parse({
    ...vector.input.definition,
    ...patch,
  });
  const authority = ReleaseReviewerAuthoritySchema.parse({
    ...definition,
    schemaVersion: "0.1",
    publishedAt: definition.effectiveAt,
    publishedByPrincipalId: definition.issuerPrincipalId,
    definitionSha256: digestReleaseReviewerAuthorityDefinition(definition.scope, definition),
  });
  const reference = releaseReviewerAuthorityReference(authority);
  const identity = ReleaseDecisionIdentityReferenceSchema.parse({
    kind: "oidc_binding",
    principalId: reference.reviewerPrincipalId,
    bindingId: `binding_${definition.reviewerPrincipalId}`,
  });
  const receipt = ReleaseApprovalReviewerReceiptSchema.parse({
    principalId: reference.reviewerPrincipalId,
    principalType: "user",
    authenticationMethod: "oidc",
    authenticatedAt: "2026-10-15T10:00:00.000Z",
    credentialId: `session_${definition.reviewerPrincipalId}`,
    requestId: "request_original",
  });
  const grant = ReleaseDecisionIdentityObservationSchema.parse({
    state: "observed",
    reference: identity,
    record: {
      identity,
      tenantId: definition.scope.tenantId,
      state: "active",
      revision: 1,
      updatedAt: "2026-10-15T09:00:00.000001Z",
      roles: ["member"],
      capabilities: ["approval:decide"],
      resourceScope: { mode: "tenant" },
    },
  });
  const credential = ReleaseDecisionCredentialObservationSchema.parse({
    state: "observed",
    reference: {
      kind: "oidc_session",
      principalId: receipt.principalId,
      credentialId: receipt.credentialId,
    },
    record: {
      schemaVersion: "0.1",
      kind: "oidc_session",
      credentialId: receipt.credentialId,
      principalId: receipt.principalId,
      tenantId: definition.scope.tenantId,
      bindingId: `binding_${definition.reviewerPrincipalId}`,
      createdAt: "2026-10-15T10:00:00.000001Z",
      absoluteExpiresAt: "2026-10-15T11:00:00.000001Z",
      idleExpiresAt: "2026-10-15T10:30:00.000001Z",
      idleLifetimeSeconds: 1800,
      lastUsedAt: null,
      useCount: 0,
      revokedAt: null,
      revocationReason: null,
    },
  });
  return {
    scope: definition.scope,
    reference,
    census: {
      state: "complete" as const,
      records: [authority],
      lifecycle: [] as ReleaseReviewerAuthorityLifecycleEvent[],
    },
    authority,
    receipt,
    identity,
    grant,
    credential,
    recordedAt: "2026-10-15T10:00:05.000001Z",
    capturedAt: "2026-10-15T10:30:00.000001Z",
    context: {
      purpose: "normal_approval",
      requirement: {
        kind: "approval_required",
        conflictRule: "reject_declared_conflict",
        excludePolicyAuthor: true,
        excludeCandidateAuthor: false,
        quorum: 1,
        humanReviewerGroupIds: ["group_release_review"],
        independenceGroupIds: ["group_release_review"],
        reviewerRoleIds: ["release_reviewer"],
      },
      candidateAuthorPrincipalId: "user_candidate_author",
      policyAuthorPrincipalId: "user_policy_author",
      evaluatorPrincipalIds: null,
    } as CapturedReleaseReviewContext,
    budget: new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 100,
      maxAcquisitionRecordBytes: 1_000_000,
      maxApprovalRecords: 0,
    }),
  };
}
