import { createHash } from "node:crypto";
import {
  encodeReleaseApprovalDefinition,
  encodeReleasePolicySelectionDefinition,
  encodeReleaseReviewerAuthorityDefinition,
  EvidenceScopeSchema,
  ReleaseApprovalReferenceSchema,
  ReleaseApprovalSchema,
  ReleasePolicySelectionReferenceSchema,
  ReleasePolicySelectionSchema,
  ReleaseReviewerAuthorityReferenceSchema,
  ReleaseReviewerAuthoritySchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApproval,
  type ReleaseApprovalDefinition,
  type ReleaseApprovalReference,
  type ReleasePolicySelection,
  type ReleasePolicySelectionDefinition,
  type ReleasePolicySelectionReference,
  type ReleaseReviewerAuthority,
  type ReleaseReviewerAuthorityDefinition,
  type ReleaseReviewerAuthorityReference,
} from "@proofstack/contracts";

export type ReleaseAuthorityRecordKind = "selection" | "reviewer_authority" | "approval";
export class InvalidReleaseAuthorityRecordError extends Error {
  readonly code = "release_authority_record_invalid";
  constructor(
    readonly kind: ReleaseAuthorityRecordKind,
    options?: ErrorOptions,
  ) {
    super(`Invalid exact release ${kind} record`, options);
    this.name = "InvalidReleaseAuthorityRecordError";
  }
}

const publicationReceiptKeys = new Set([
  "schemaVersion",
  "definitionSha256",
  "publishedAt",
  "publishedByPrincipalId",
]);
const approvalReceiptKeys = new Set(["schemaVersion", "definitionSha256"]);
function definitionOf(record: object, receipts: ReadonlySet<string>): unknown {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !receipts.has(key)));
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}
export function digestReleasePolicySelectionDefinition(
  scope: EvidenceScope,
  definition: ReleasePolicySelectionDefinition,
): string {
  return digest(encodeReleasePolicySelectionDefinition({ scope, definition }));
}
export function digestReleaseReviewerAuthorityDefinition(
  scope: EvidenceScope,
  definition: ReleaseReviewerAuthorityDefinition,
): string {
  return digest(encodeReleaseReviewerAuthorityDefinition({ scope, definition }));
}
export function digestReleaseApprovalDefinition(
  scope: EvidenceScope,
  definition: ReleaseApprovalDefinition,
): string {
  return digest(encodeReleaseApprovalDefinition({ scope, definition }));
}
export function releasePolicySelectionReference(
  record: ReleasePolicySelection,
): ReleasePolicySelectionReference {
  return {
    selectionId: record.selectionId,
    selectionVersionId: record.selectionVersionId,
    definitionSha256: record.definitionSha256,
    installationId: record.installationId,
    gateTargetId: record.gateTargetId,
  };
}
export function releaseReviewerAuthorityReference(
  record: ReleaseReviewerAuthority,
): ReleaseReviewerAuthorityReference {
  return {
    authorityId: record.authorityId,
    authorityVersionId: record.authorityVersionId,
    definitionSha256: record.definitionSha256,
    installationId: record.installationId,
    gateTargetId: record.gateTargetId,
    reviewerPrincipalId: record.reviewerPrincipalId,
  };
}
export function releaseApprovalReference(record: ReleaseApproval): ReleaseApprovalReference {
  return { approvalId: record.approvalId, definitionSha256: record.definitionSha256 };
}

/** Immutable integrity only: no current lifecycle, private identity proof, quorum or publication. */
export function validateReleasePolicySelectionRecord(input: {
  readonly expected: {
    readonly scope: EvidenceScope;
    readonly reference: ReleasePolicySelectionReference;
  };
  readonly record: unknown;
}): ReleasePolicySelection {
  try {
    const record = ReleasePolicySelectionSchema.parse(input.record);
    const scope = EvidenceScopeSchema.parse(input.expected.scope);
    const reference = ReleasePolicySelectionReferenceSchema.parse(input.expected.reference);
    const definition = definitionOf(
      record,
      publicationReceiptKeys,
    ) as ReleasePolicySelectionDefinition;
    if (
      !same(scope, record.scope) ||
      !same(reference, releasePolicySelectionReference(record)) ||
      record.definitionSha256 !== digestReleasePolicySelectionDefinition(scope, definition)
    )
      throw new Error("Original selection reference, scope or canonical definition mismatch");
    return record;
  } catch (cause) {
    throw new InvalidReleaseAuthorityRecordError("selection", { cause });
  }
}

/** An attributable reviewer declaration is not evidence of expertise or an authenticated review. */
export function validateReleaseReviewerAuthorityRecord(input: {
  readonly expected: {
    readonly scope: EvidenceScope;
    readonly reference: ReleaseReviewerAuthorityReference;
  };
  readonly record: unknown;
}): ReleaseReviewerAuthority {
  try {
    const record = ReleaseReviewerAuthoritySchema.parse(input.record);
    const scope = EvidenceScopeSchema.parse(input.expected.scope);
    const reference = ReleaseReviewerAuthorityReferenceSchema.parse(input.expected.reference);
    const definition = definitionOf(
      record,
      publicationReceiptKeys,
    ) as ReleaseReviewerAuthorityDefinition;
    if (
      !same(scope, record.scope) ||
      !same(reference, releaseReviewerAuthorityReference(record)) ||
      record.definitionSha256 !== digestReleaseReviewerAuthorityDefinition(scope, definition)
    )
      throw new Error("Original reviewer reference, scope or canonical definition mismatch");
    return record;
  } catch (cause) {
    throw new InvalidReleaseAuthorityRecordError("reviewer_authority", { cause });
  }
}

/** Preserve the entire original authenticated-action receipt; current authority is separate. */
export function validateReleaseApprovalRecord(input: {
  readonly expected: {
    readonly scope: EvidenceScope;
    readonly reference: ReleaseApprovalReference;
  };
  readonly record: unknown;
}): ReleaseApproval {
  try {
    const record = ReleaseApprovalSchema.parse(input.record);
    const scope = EvidenceScopeSchema.parse(input.expected.scope);
    const reference = ReleaseApprovalReferenceSchema.parse(input.expected.reference);
    const definition = definitionOf(record, approvalReceiptKeys) as ReleaseApprovalDefinition;
    if (
      !same(scope, record.subject.scope) ||
      !same(reference, releaseApprovalReference(record)) ||
      record.definitionSha256 !== digestReleaseApprovalDefinition(scope, definition)
    )
      throw new Error("Original approval reference, scope or canonical definition mismatch");
    return record;
  } catch (cause) {
    throw new InvalidReleaseAuthorityRecordError("approval", { cause });
  }
}
