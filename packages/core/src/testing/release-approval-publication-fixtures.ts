import { readFileSync } from "node:fs";
import {
  ReleaseApprovalSchema,
  ReleaseApprovalRevocationSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionSessionStateSchema,
} from "@proofstack/contracts";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";
import { prepareReleaseApprovalPublicationMaterial } from "../release/release-approval-publication.js";

export const approvalPublicationFixtureBudget = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 10000,
    maxAcquisitionRecordBytes: 16 * 1024 * 1024,
    maxApprovalRecords: 4096,
  });

/** Synthetic original preimages, not actual authentication or current approval authority. */
export function releaseApprovalPublicationFixture(kind: "approval" | "revocation" = "approval") {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/release-approval-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ).vectors;
  const original = vectors[1];
  const approval = ReleaseApprovalSchema.parse({
    ...original.input.definition,
    schemaVersion: "0.1",
    definitionSha256: original.sha256,
  });
  const scope = approval.subject.scope;
  const actor = approval.reviewer;
  const identity = {
    kind: "oidc_binding" as const,
    principalId: actor.principalId,
    bindingId: "binding_release_reviewer",
  };
  const grant = ReleaseDecisionIdentityGrantSchema.parse({
    identity,
    tenantId: scope.tenantId,
    state: "active",
    revision: 1,
    updatedAt: "2026-10-15T09:00:00.000001Z",
    roles: ["member"],
    capabilities: ["approval:decide"],
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
  });
  const credential = ReleaseDecisionSessionStateSchema.parse({
    schemaVersion: "0.1",
    kind: "oidc_session",
    credentialId: actor.credentialId,
    principalId: actor.principalId,
    tenantId: scope.tenantId,
    bindingId: identity.bindingId,
    createdAt: "2026-10-15T10:00:00.000001Z",
    absoluteExpiresAt: "2026-10-15T11:00:00.000001Z",
    idleExpiresAt: "2026-10-15T10:30:00.000001Z",
    idleLifetimeSeconds: 1800,
    lastUsedAt: "2026-10-15T10:00:00.000001Z",
    useCount: 1,
    revokedAt: null,
    revocationReason: null,
  });
  const event = ReleaseApprovalRevocationSchema.parse({
    schemaVersion: "0.1",
    eventId: "event_approval_revoked",
    scope,
    approval: { approvalId: approval.approvalId, definitionSha256: approval.definitionSha256 },
    reviewer: actor,
    occurredAt: "2026-10-15T10:01:00.000002Z",
    reason: "Withdraw this exact synthetic approval; 운영 승인이 아닙니다.",
  });
  return prepareReleaseApprovalPublicationMaterial({
    scope,
    source:
      kind === "approval"
        ? { kind: "release_approval", record: approval }
        : { kind: "release_approval_revocation", record: event },
    actor,
    identity,
    grant,
    credential,
    issuedAt: kind === "approval" ? approval.recordedAt : event.occurredAt,
    budget: approvalPublicationFixtureBudget(),
  });
}
