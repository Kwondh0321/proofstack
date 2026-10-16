import { readFileSync } from "node:fs";
import {
  ReleaseApprovalDefinitionSchema,
  ReleaseApprovalSchema,
  ReleaseApprovalRevocationSchema,
  type ReleaseApproval,
  type ReleaseApprovalDefinition,
  type ReleaseApprovalRevocation,
} from "@proofstack/contracts";
import {
  digestReleaseApprovalDefinition,
  releaseApprovalReference,
} from "../release/release-authority-record-validation.js";

/** Synthetic declaration/receipt fixtures, never actual OIDC authentication or release authority. */
export function releaseApprovalRepositoryFixture(namespace: string) {
  const vector = JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/release-approval-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ).vectors[1];
  const original = approvalVersion(
    ReleaseApprovalDefinitionSchema.parse({
      ...vector.input.definition,
      approvalId: `approval_${namespace}_a`,
    }),
  );
  const successor = approvalVersion(original, {
    approvalId: `approval_${namespace}_b`,
    supersedes: releaseApprovalReference(original),
    recordedAt: "2026-10-15T10:10:00.000001Z",
  });
  const revocation = ReleaseApprovalRevocationSchema.parse({
    schemaVersion: "0.1",
    eventId: `event_${namespace}_revoke`,
    scope: original.subject.scope,
    approval: releaseApprovalReference(original),
    reviewer: { ...original.reviewer, requestId: "request_revoke" },
    occurredAt: "2026-10-15T10:20:00.000001Z",
    reason: "The original reviewer revoked this exact synthetic action.",
  });
  return {
    original,
    successor,
    revocation,
    scope: original.subject.scope,
    subject: original.subject,
  };
}
export function approvalVersion(
  original: ReleaseApprovalDefinition | ReleaseApproval,
  patch: Partial<ReleaseApprovalDefinition> = {},
): ReleaseApproval {
  const {
    schemaVersion: _version,
    definitionSha256: _sha,
    ...input
  } = { ...original, ...patch } as ReleaseApproval;
  const definition = ReleaseApprovalDefinitionSchema.parse(input);
  return ReleaseApprovalSchema.parse({
    ...definition,
    schemaVersion: "0.1",
    definitionSha256: digestReleaseApprovalDefinition(definition.subject.scope, definition),
  });
}
export function approvalRevocation(
  original: ReleaseApprovalRevocation,
  patch: Partial<ReleaseApprovalRevocation> = {},
) {
  return ReleaseApprovalRevocationSchema.parse({ ...original, ...patch });
}
