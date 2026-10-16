import { readFileSync } from "node:fs";
import {
  ReleaseReviewerAuthorityDefinitionSchema,
  ReleaseReviewerAuthoritySchema,
  type ReleaseReviewerAuthority,
  type ReleaseReviewerAuthorityDefinition,
  type ReleaseReviewerAuthorityLifecycleEvent,
} from "@proofstack/contracts";
import {
  digestReleaseReviewerAuthorityDefinition,
  releaseReviewerAuthorityReference,
} from "../release/release-authority-record-validation.js";

export function releaseReviewerAuthorityRepositoryFixture(namespace: string) {
  const vector = JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/release-approval-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ).vectors[0];
  const definition = ReleaseReviewerAuthorityDefinitionSchema.parse({
    ...vector.input.definition,
    authorityId: `authority_${namespace}`,
    authorityVersionId: `version_${namespace}_a`,
    installationId: `installation_${namespace}`,
    gateTargetId: `gate_${namespace}`,
    reviewerPrincipalId: `reviewer_${namespace}`,
  });
  const original = authorityVersion(definition, {}, definition.effectiveAt);
  const successor = authorityVersion(
    definition,
    {
      authorityVersionId: `version_${namespace}_b`,
      predecessor: releaseReviewerAuthorityReference(original),
      effectiveAt: "2026-10-15T11:00:00.000001Z",
    },
    "2026-10-15T11:00:00.000001Z",
  );
  const revocation: ReleaseReviewerAuthorityLifecycleEvent = {
    schemaVersion: "0.1",
    eventId: `event_${namespace}_revoked`,
    scope: original.scope,
    authority: releaseReviewerAuthorityReference(original),
    kind: "revoked",
    actorPrincipalId: "principal_installer",
    occurredAt: "2026-10-15T11:00:00.000001Z",
    reason: "Revoke this exact reviewer authority declaration.",
  };
  const supersession: ReleaseReviewerAuthorityLifecycleEvent = {
    ...revocation,
    eventId: `event_${namespace}_superseded`,
    kind: "superseded",
    successor: releaseReviewerAuthorityReference(successor),
  };
  return {
    original,
    successor,
    revocation,
    supersession,
    scope: original.scope,
    target: {
      installationId: original.installationId,
      gateTargetId: original.gateTargetId,
      reviewerPrincipalId: original.reviewerPrincipalId,
    },
  };
}
export function authorityVersion(
  original: ReleaseReviewerAuthorityDefinition | ReleaseReviewerAuthority,
  patch: Partial<ReleaseReviewerAuthorityDefinition>,
  publishedAt: string,
): ReleaseReviewerAuthority {
  const parsed = ReleaseReviewerAuthorityDefinitionSchema.parse(
    Object.fromEntries(
      Object.entries({ ...original, ...patch }).filter(
        ([key]) =>
          !["schemaVersion", "definitionSha256", "publishedAt", "publishedByPrincipalId"].includes(
            key,
          ),
      ),
    ),
  );
  return ReleaseReviewerAuthoritySchema.parse({
    ...parsed,
    schemaVersion: "0.1",
    publishedAt,
    publishedByPrincipalId: parsed.issuerPrincipalId,
    definitionSha256: digestReleaseReviewerAuthorityDefinition(parsed.scope, parsed),
  });
}
