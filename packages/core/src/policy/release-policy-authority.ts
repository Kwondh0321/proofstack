import type {
  EvidenceScope,
  PolicyInstallationBinding,
  ReleasePolicyDefinition,
  SourceApplicabilityScope,
  SourceReviewerQualification,
  SourceReviewRecord,
  SourceSnapshot,
} from "@proofstack/contracts";
import {
  EvidenceScopeSchema,
  evidenceTimestampOrderKey,
  OpaqueIdSchema,
  QualifiedSourceReferenceSchema,
  ReleasePolicyDefinitionSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { sourceScopeCovers } from "../evaluation/criteria-trust.js";
import { validateEvaluationRecord } from "../evaluation/evaluation-record-validation.js";
import { InvalidReleasePolicyAuthorityInputError } from "./release-policy-errors.js";
import { validatePolicyInstallationBindingRecord } from "./release-policy-record-validation.js";

export const RELEASE_POLICY_AUTHORITY_REASONS = [
  "installation_authority_evidence_unavailable",
  "installation_binding_interval_mismatch",
  "installation_binding_not_current",
  "installation_binding_not_registered",
  "installation_binding_reference_mismatch",
  "installation_binding_scope_mismatch",
  "installation_binding_unavailable",
  "issuer_not_authorized",
  "policy_mode_not_authorized",
  "policy_not_publishable_at_time",
  "reviewer_qualification_evidence_unavailable",
  "reviewer_qualification_not_current",
  "reviewer_qualification_not_independent",
  "reviewer_qualification_not_qualified",
  "reviewer_qualification_reference_mismatch",
  "reviewer_qualification_scope_mismatch",
  "reviewer_qualification_source_kind_mismatch",
  "reviewer_qualification_unavailable",
  "source_conflict_review_incomplete",
  "source_conflict_unresolved",
  "source_content_unavailable",
  "source_identity_disputed",
  "source_identity_evidence_unavailable",
  "source_identity_not_current",
  "source_identity_not_independent",
  "source_identity_unverified",
  "source_license_unusable",
  "source_not_current",
  "source_not_effective",
  "source_reference_mismatch",
  "source_review_basis_unavailable",
  "source_review_not_approved",
  "source_review_not_current",
  "source_review_not_independent",
  "source_review_relationship_disclosed",
  "source_review_unavailable",
  "source_scope_mismatch",
  "source_snapshot_unavailable",
] as const;

export type ReleasePolicyAuthorityReason = (typeof RELEASE_POLICY_AUTHORITY_REASONS)[number];
type QualifiedSourceReference = ReleasePolicyDefinition["sources"][number];
type ArtifactContentReference = SourceSnapshot["content"];

export interface ReleasePolicyAuthorityArtifactAvailability {
  readonly artifactId: string;
  readonly sha256: string;
  readonly state: "available" | "unavailable";
}

export interface ResolvedReleasePolicySourceAuthority {
  readonly reference: QualifiedSourceReference;
  readonly review: SourceReviewRecord | null;
  readonly reviewerQualification: SourceReviewerQualification | null;
  readonly source: SourceSnapshot | null;
}

export interface ValidateReleasePolicyAuthorityInput {
  /** Availability facts resolved from the installation artifact store, never caller assertions. */
  readonly artifacts: readonly ReleasePolicyAuthorityArtifactAvailability[];
  readonly at: string;
  readonly definition: ReleasePolicyDefinition;
  /** Exact operator-owned record resolved from the installation binding repository. */
  readonly installationBinding: PolicyInstallationBinding | null;
  readonly publisherPrincipalId: string;
  readonly scope: EvidenceScope;
  /** Exact records resolved from the append-only evaluation repository. */
  readonly sources: readonly ResolvedReleasePolicySourceAuthority[];
}

export interface ReleasePolicyAuthorityFinding {
  readonly reason: ReleasePolicyAuthorityReason;
  readonly sourceReviewId?: string;
  readonly sourceSnapshotId?: string;
}

export interface ReleasePolicyAuthorityValidation {
  readonly findings: readonly ReleasePolicyAuthorityFinding[];
  readonly status: "invalid" | "valid";
}

interface ParsedAuthorityInput {
  readonly artifacts: ReadonlyMap<string, "available" | "unavailable">;
  readonly at: string;
  readonly definition: ReleasePolicyDefinition;
  readonly installationBinding: PolicyInstallationBinding | null;
  readonly publisherPrincipalId: string;
  readonly scope: EvidenceScope;
  readonly sources: readonly ResolvedReleasePolicySourceAuthority[];
}

function invalid(message: string, cause?: unknown): InvalidReleasePolicyAuthorityInputError {
  return new InvalidReleasePolicyAuthorityInputError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function before(left: string, right: string): boolean {
  return evidenceTimestampOrderKey(left) < evidenceTimestampOrderKey(right);
}

function intervalCovers(
  validFrom: string,
  validUntil: string,
  effectiveAt: string,
  expiresAt: string,
): boolean {
  return !before(effectiveAt, validFrom) && !before(validUntil, expiresAt);
}

function exactSourceKey(value: QualifiedSourceReference): string {
  return [
    value.source.sourceSnapshotId,
    value.source.definitionSha256,
    value.review.sourceReviewId,
    value.review.definitionSha256,
  ].join(":");
}

function artifactKey(value: { readonly artifactId: string; readonly sha256: string }): string {
  return `${value.artifactId}:${value.sha256}`;
}

function parseArtifacts(
  input: readonly ReleasePolicyAuthorityArtifactAvailability[],
): ReadonlyMap<string, "available" | "unavailable"> {
  if (!Array.isArray(input)) throw invalid("Policy authority artifact availability is invalid");
  const artifacts = new Map<string, "available" | "unavailable">();
  for (const item of input) {
    const artifactId = OpaqueIdSchema.safeParse(item?.artifactId);
    if (
      !artifactId.success ||
      typeof item?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      (item.state !== "available" && item.state !== "unavailable")
    ) {
      throw invalid("Policy authority artifact availability is invalid");
    }
    const key = artifactKey(item);
    if (artifacts.has(key)) {
      throw invalid("Policy authority artifact availability must be unique");
    }
    artifacts.set(key, item.state);
  }
  return artifacts;
}

function exactSourceRecord(input: unknown): SourceSnapshot {
  try {
    return validateEvaluationRecord("source_snapshot", input) as SourceSnapshot;
  } catch (cause) {
    throw invalid("Policy authority source snapshot is invalid", cause);
  }
}

function exactReviewRecord(input: unknown): SourceReviewRecord {
  try {
    return validateEvaluationRecord("source_review", input) as SourceReviewRecord;
  } catch (cause) {
    throw invalid("Policy authority source review is invalid", cause);
  }
}

function exactReviewerQualification(input: unknown): SourceReviewerQualification {
  try {
    return validateEvaluationRecord(
      "source_reviewer_qualification",
      input,
    ) as SourceReviewerQualification;
  } catch (cause) {
    throw invalid("Policy authority reviewer qualification is invalid", cause);
  }
}

function parseSources(
  input: readonly ResolvedReleasePolicySourceAuthority[],
  expected: readonly QualifiedSourceReference[],
): readonly ResolvedReleasePolicySourceAuthority[] {
  if (!Array.isArray(input)) throw invalid("Policy authority source resolution is invalid");
  const expectedKeys = new Set(expected.map(exactSourceKey));
  const seen = new Set<string>();
  const sources = input.map((item) => {
    let reference: QualifiedSourceReference;
    try {
      reference = QualifiedSourceReferenceSchema.parse(item?.reference);
    } catch (cause) {
      throw invalid("Policy authority source reference is invalid", cause);
    }
    const key = exactSourceKey(reference);
    if (seen.has(key) || !expectedKeys.has(key)) {
      throw invalid("Policy authority source resolution must match the exact requested set");
    }
    seen.add(key);
    return {
      reference,
      review: item.review === null ? null : exactReviewRecord(item.review),
      reviewerQualification:
        item.reviewerQualification === null
          ? null
          : exactReviewerQualification(item.reviewerQualification),
      source: item.source === null ? null : exactSourceRecord(item.source),
    };
  });
  return sources;
}

function parseInput(input: ValidateReleasePolicyAuthorityInput): ParsedAuthorityInput {
  let definition: ReleasePolicyDefinition;
  let installationBinding: PolicyInstallationBinding | null;
  try {
    definition = ReleasePolicyDefinitionSchema.parse(input.definition);
    installationBinding =
      input.installationBinding === null
        ? null
        : validatePolicyInstallationBindingRecord(input.installationBinding);
  } catch (cause) {
    throw invalid("Policy authority definition or installation binding is invalid", cause);
  }
  const scope = EvidenceScopeSchema.safeParse(input.scope);
  const at = UtcMillisecondTimestampSchema.safeParse(input.at);
  const publisherPrincipalId = OpaqueIdSchema.safeParse(input.publisherPrincipalId);
  if (!scope.success || !at.success || !publisherPrincipalId.success) {
    throw invalid(
      "Policy authority request identity, scope, or time is invalid",
      !scope.success ? scope.error : !at.success ? at.error : publisherPrincipalId.error,
    );
  }
  const expected = [...definition.sources, ...definition.counterevidence];
  return {
    artifacts: parseArtifacts(input.artifacts),
    at: at.data,
    definition,
    installationBinding,
    publisherPrincipalId: publisherPrincipalId.data,
    scope: scope.data,
    sources: parseSources(input.sources, expected),
  };
}

function isArtifactAvailable(
  artifacts: ReadonlyMap<string, "available" | "unavailable">,
  reference: Pick<ArtifactContentReference, "artifactId" | "sha256">,
): boolean {
  return artifacts.get(artifactKey(reference)) === "available";
}

function areArtifactsAvailable(
  artifacts: ReadonlyMap<string, "available" | "unavailable">,
  references: readonly ArtifactContentReference[],
): boolean {
  return references.every((reference) => isArtifactAvailable(artifacts, reference));
}

type PolicySelector<Value extends string = string> =
  | { readonly operator: "any" }
  | { readonly operator: "equals"; readonly value: Value }
  | { readonly operator: "one_of"; readonly values: readonly Value[] };

type SourceSelector<Value extends string> =
  | { readonly mode: "any" }
  | { readonly mode: "include"; readonly values: Value[] };

function sourceSelector<Value extends string>(
  selector: PolicySelector<Value>,
): SourceSelector<Value> {
  if (selector.operator === "any") return { mode: "any" };
  return {
    mode: "include",
    values: selector.operator === "equals" ? [selector.value] : [...selector.values],
  };
}

function optionalSourceSelector(
  selector: PolicySelector | { readonly operator: "absent" },
): SourceSelector<string> {
  return selector.operator === "absent" ? { mode: "any" } : sourceSelector(selector);
}

function requiredSourceScope(
  definition: ReleasePolicyDefinition,
  scope: EvidenceScope,
): SourceApplicabilityScope {
  const populationTags = definition.applicability.populationTags;
  return {
    environments: { mode: "include", values: [scope.environmentId] },
    exclusions: [],
    jurisdictions: optionalSourceSelector(definition.applicability.jurisdiction),
    locales: optionalSourceSelector(definition.applicability.locale),
    populations:
      populationTags.operator === "exactly" && populationTags.values.length > 0
        ? { mode: "include", values: [...populationTags.values] }
        : { mode: "any" },
    riskTiers: sourceSelector(definition.applicability.riskTier),
    taskKinds: sourceSelector(definition.applicability.taskKind),
  };
}

function addInstallationFindings(
  add: (reason: ReleasePolicyAuthorityReason) => void,
  input: ParsedAuthorityInput,
): void {
  const binding = input.installationBinding;
  if (!binding) {
    add("installation_binding_unavailable");
    return;
  }
  const reference = input.definition.installationBinding;
  if (
    binding.installationId !== reference.installationId ||
    binding.bindingVersionId !== reference.bindingVersionId ||
    binding.definitionSha256 !== reference.definitionSha256
  ) {
    add("installation_binding_reference_mismatch");
  }
  if (!sameScope(binding.scope, input.scope)) add("installation_binding_scope_mismatch");
  if (before(input.at, binding.registeredAt)) add("installation_binding_not_registered");
  if (before(input.at, binding.effectiveAt) || !before(input.at, binding.expiresAt)) {
    add("installation_binding_not_current");
  }
  if (
    !intervalCovers(
      binding.effectiveAt,
      binding.expiresAt,
      input.definition.effectiveAt,
      input.definition.expiresAt,
    )
  ) {
    add("installation_binding_interval_mismatch");
  }
  if (
    input.definition.issuerPrincipalId !== input.publisherPrincipalId ||
    !binding.authorizedIssuerPrincipalIds.includes(input.publisherPrincipalId)
  ) {
    add("issuer_not_authorized");
  }
  if (!binding.allowedModes.includes(input.definition.mode)) add("policy_mode_not_authorized");
  if (!isArtifactAvailable(input.artifacts, binding.authorityEvidence)) {
    add("installation_authority_evidence_unavailable");
  }
}

function addSourceFindings(
  add: (reason: ReleasePolicyAuthorityReason, reference: QualifiedSourceReference) => void,
  input: ParsedAuthorityInput,
): void {
  const resolved = new Map(input.sources.map((value) => [exactSourceKey(value.reference), value]));
  const requiredScope = requiredSourceScope(input.definition, input.scope);
  for (const reference of [...input.definition.sources, ...input.definition.counterevidence]) {
    const evidence = resolved.get(exactSourceKey(reference));
    const source = evidence?.source ?? null;
    const review = evidence?.review ?? null;
    if (!source) add("source_snapshot_unavailable", reference);
    if (!review) add("source_review_unavailable", reference);
    if (!source || !review) continue;

    if (
      source.sourceSnapshotId !== reference.source.sourceSnapshotId ||
      source.definitionSha256 !== reference.source.definitionSha256 ||
      review.sourceReviewId !== reference.review.sourceReviewId ||
      review.definitionSha256 !== reference.review.definitionSha256 ||
      review.source.sourceSnapshotId !== source.sourceSnapshotId ||
      review.source.definitionSha256 !== source.definitionSha256
    ) {
      add("source_reference_mismatch", reference);
      continue;
    }
    if (!sameScope(source.scope, input.scope) || !sameScope(review.scope, input.scope)) {
      add("source_scope_mismatch", reference);
    }
    if (
      !sourceScopeCovers(source.applicabilityScope, requiredScope) ||
      !sourceScopeCovers(review.approvedScope, requiredScope)
    ) {
      add("source_scope_mismatch", reference);
    }
    if (!isArtifactAvailable(input.artifacts, source.content)) {
      add("source_content_unavailable", reference);
    }
    if (source.identityVerification.status === "disputed") {
      add("source_identity_disputed", reference);
    } else if (source.identityVerification.status === "unverified") {
      add("source_identity_unverified", reference);
    } else {
      if (!areArtifactsAvailable(input.artifacts, source.identityVerification.evidence)) {
        add("source_identity_evidence_unavailable", reference);
      }
      if (before(input.at, source.identityVerification.verifiedAt)) {
        add("source_identity_not_current", reference);
      }
      if (
        source.identityVerification.verifierPrincipalId === source.publishedByPrincipalId ||
        source.identityVerification.verifierPrincipalId === review.reviewedByPrincipalId ||
        source.identityVerification.verifierPrincipalId === input.publisherPrincipalId
      ) {
        add("source_identity_not_independent", reference);
      }
    }
    if (
      before(input.at, source.recordedAt) ||
      (source.effectiveAt !== undefined && before(input.definition.effectiveAt, source.effectiveAt))
    ) {
      add("source_not_effective", reference);
    }
    if (source.expiresAt !== undefined && before(source.expiresAt, input.definition.expiresAt)) {
      add("source_not_current", reference);
    }
    if (source.license.status !== "declared" || review.licensingConclusion !== "usable") {
      add("source_license_unusable", reference);
    }
    if (
      before(input.at, review.reviewedAt) ||
      !intervalCovers(
        review.validFrom,
        review.validUntil,
        input.definition.effectiveAt,
        input.definition.expiresAt,
      ) ||
      before(input.at, review.validFrom) ||
      !before(input.at, review.validUntil) ||
      review.freshnessConclusion !== "current"
    ) {
      add("source_review_not_current", reference);
    }
    if (
      review.outcome !== "approved" ||
      review.authorityConclusion !== "accepted" ||
      review.applicabilityConclusion !== "approved"
    ) {
      add("source_review_not_approved", reference);
    }
    if (review.declaredRelationships.length > 0) {
      add("source_review_relationship_disclosed", reference);
    }
    if (
      review.reviewedByPrincipalId === source.publishedByPrincipalId ||
      review.reviewedByPrincipalId === input.publisherPrincipalId
    ) {
      add("source_review_not_independent", reference);
    }
    if (review.criticalConflictStatus === "unresolved") {
      add("source_conflict_unresolved", reference);
    }
    const reviewedConflicts = new Set(
      review.reviewedConflicts.map(
        (conflict) => `${conflict.sourceSnapshotId}:${conflict.definitionSha256}`,
      ),
    );
    if (
      source.conflictsWith.some(
        (conflict) =>
          !reviewedConflicts.has(`${conflict.sourceSnapshotId}:${conflict.definitionSha256}`),
      )
    ) {
      add("source_conflict_review_incomplete", reference);
    }
    if (!areArtifactsAvailable(input.artifacts, review.reviewBasis)) {
      add("source_review_basis_unavailable", reference);
    }

    const reviewer = evidence?.reviewerQualification ?? null;
    if (!reviewer || !review.reviewerQualification) {
      add("reviewer_qualification_unavailable", reference);
      continue;
    }
    if (
      reviewer.qualificationId !== review.reviewerQualification.qualificationId ||
      reviewer.definitionSha256 !== review.reviewerQualification.definitionSha256 ||
      reviewer.reviewerPrincipalId !== review.reviewedByPrincipalId ||
      !sameScope(reviewer.scope, input.scope)
    ) {
      add("reviewer_qualification_reference_mismatch", reference);
      continue;
    }
    if (
      !sourceScopeCovers(reviewer.applicabilityScope, requiredScope) ||
      !sourceScopeCovers(reviewer.applicabilityScope, review.approvedScope)
    ) {
      add("reviewer_qualification_scope_mismatch", reference);
    }
    if (!reviewer.sourceKinds.includes(source.sourceKind)) {
      add("reviewer_qualification_source_kind_mismatch", reference);
    }
    if (reviewer.status !== "qualified") {
      add("reviewer_qualification_not_qualified", reference);
    }
    if (
      before(input.at, reviewer.recordedAt) ||
      before(input.at, reviewer.validFrom) ||
      !before(input.at, reviewer.validUntil) ||
      !intervalCovers(
        reviewer.validFrom,
        reviewer.validUntil,
        input.definition.effectiveAt,
        input.definition.expiresAt,
      )
    ) {
      add("reviewer_qualification_not_current", reference);
    }
    if (
      reviewer.verifiedByPrincipalId === reviewer.reviewerPrincipalId ||
      reviewer.verifiedByPrincipalId === source.publishedByPrincipalId ||
      reviewer.verifiedByPrincipalId === input.publisherPrincipalId
    ) {
      add("reviewer_qualification_not_independent", reference);
    }
    if (!areArtifactsAvailable(input.artifacts, reviewer.credentialEvidence)) {
      add("reviewer_qualification_evidence_unavailable", reference);
    }
  }
}

/**
 * Validates trusted resolver output required to publish a policy definition. Its records and
 * availability facts must come from installation-owned repositories, not directly from an API
 * caller. This function does not evaluate a policy, approve a release, or assert that the
 * organization's thresholds are wise.
 */
export function validateReleasePolicyAuthority(
  raw: ValidateReleasePolicyAuthorityInput,
): ReleasePolicyAuthorityValidation {
  const input = parseInput(raw);
  const findings = new Map<string, ReleasePolicyAuthorityFinding>();
  const add = (reason: ReleasePolicyAuthorityReason, reference?: QualifiedSourceReference) => {
    const finding = {
      reason,
      ...(reference
        ? {
            sourceReviewId: reference.review.sourceReviewId,
            sourceSnapshotId: reference.source.sourceSnapshotId,
          }
        : {}),
    };
    const key = `${finding.reason}:${finding.sourceSnapshotId ?? ""}:${finding.sourceReviewId ?? ""}`;
    findings.set(key, finding);
  };

  if (!before(input.at, input.definition.expiresAt)) add("policy_not_publishable_at_time");
  addInstallationFindings(add, input);
  addSourceFindings((reason, reference) => add(reason, reference), input);

  const ordered = [...findings.values()].sort((left, right) => {
    const leftKey = `${left.reason}:${left.sourceSnapshotId ?? ""}:${left.sourceReviewId ?? ""}`;
    const rightKey = `${right.reason}:${right.sourceSnapshotId ?? ""}:${right.sourceReviewId ?? ""}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { findings: ordered, status: ordered.length === 0 ? "valid" : "invalid" };
}
