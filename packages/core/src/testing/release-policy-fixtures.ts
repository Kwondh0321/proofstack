import { readFileSync } from "node:fs";
import type {
  EvidenceScope,
  PolicyInstallationBinding,
  PolicyInstallationBindingDefinition,
  ReleasePolicy,
  ReleasePolicyDefinition,
  SourceApplicabilityScope,
  SourceReviewDefinition,
  SourceReviewerQualification,
  SourceReviewerQualificationDefinition,
  SourceReviewRecord,
  SourceSnapshot,
  SourceSnapshotDefinition,
} from "@proofstack/contracts";
import {
  EvidenceScopeSchema,
  POLICY_INSTALLATION_BINDING_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  SOURCE_REVIEW_SCHEMA_VERSION,
  SOURCE_REVIEWER_QUALIFICATION_SCHEMA_VERSION,
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
} from "@proofstack/contracts";
import { digestEvaluationRecordDefinition } from "../evaluation/evaluation-record-validation.js";
import type {
  ReleasePolicyAuthorityArtifactAvailability,
  ValidateReleasePolicyAuthorityInput,
} from "../policy/release-policy-authority.js";
import {
  digestPolicyInstallationBindingDefinition,
  digestReleasePolicyDefinition,
} from "../policy/release-policy-record-validation.js";

interface StoredVector {
  readonly input: { readonly definition: unknown; readonly scope?: EvidenceScope };
  readonly kind: string;
}

const sourceVectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/evaluation-source-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly StoredVector[] }
).vectors;

const policyVectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/release-policy-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly StoredVector[] }
).vectors;

function definition<Definition>(vectors: readonly StoredVector[], kind: string): Definition {
  const vector = vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Missing ${kind} vector`);
  return structuredClone(vector.input.definition) as Definition;
}

export function anyPolicySourceScope(): SourceApplicabilityScope {
  return {
    environments: { mode: "any" },
    exclusions: [],
    jurisdictions: { mode: "any" },
    locales: { mode: "any" },
    populations: { mode: "any" },
    riskTiers: { mode: "any" },
    taskKinds: { mode: "any" },
  };
}

function sourceReference(source: SourceSnapshot) {
  return {
    definitionSha256: source.definitionSha256,
    sourceSnapshotId: source.sourceSnapshotId,
  };
}

function reviewReference(review: SourceReviewRecord) {
  return {
    definitionSha256: review.definitionSha256,
    sourceReviewId: review.sourceReviewId,
  };
}

function qualificationReference(qualification: SourceReviewerQualification) {
  return {
    definitionSha256: qualification.definitionSha256,
    qualificationId: qualification.qualificationId,
  };
}

function artifactAvailability(
  references: readonly { readonly artifactId: string; readonly sha256: string }[],
): ReleasePolicyAuthorityArtifactAvailability[] {
  return [
    ...new Map(
      references.map((reference) => [
        `${reference.artifactId}:${reference.sha256}`,
        { ...reference, state: "available" as const },
      ]),
    ).values(),
  ];
}

export interface PolicyAuthorityFixtureOptions {
  readonly mutateBinding?: (definition: PolicyInstallationBindingDefinition) => void;
  readonly mutatePolicy?: (definition: ReleasePolicyDefinition) => void;
  readonly mutateReview?: (definition: SourceReviewDefinition) => void;
  readonly mutateReviewer?: (definition: SourceReviewerQualificationDefinition) => void;
  readonly mutateSource?: (definition: SourceSnapshotDefinition) => void;
  readonly scope?: EvidenceScope;
}

export interface PolicyAuthorityFixture {
  readonly binding: PolicyInstallationBinding;
  readonly input: ValidateReleasePolicyAuthorityInput;
  readonly policy: ReleasePolicy;
  readonly review: SourceReviewRecord;
  readonly reviewer: SourceReviewerQualification;
  readonly source: SourceSnapshot;
}

export function policyAuthorityFixture(
  options: PolicyAuthorityFixtureOptions = {},
): PolicyAuthorityFixture {
  const scope = EvidenceScopeSchema.parse(
    options.scope ?? {
      environmentId: "env_staging",
      projectId: "project_checkout",
      tenantId: "tenant_example",
    },
  );

  const sourceDefinition = definition<SourceSnapshotDefinition>(sourceVectors, "source_snapshot");
  sourceDefinition.applicabilityScope = anyPolicySourceScope();
  sourceDefinition.conflictsWith = [];
  sourceDefinition.effectiveAt = "2026-01-01T00:00:00Z";
  sourceDefinition.expiresAt = "2027-04-01T00:00:00Z";
  sourceDefinition.identityVerification = {
    ...sourceDefinition.identityVerification,
    evidence:
      sourceDefinition.identityVerification.status === "verified"
        ? sourceDefinition.identityVerification.evidence
        : [],
    method: "digital_signature",
    status: "verified",
    verifiedAt: "2026-01-02T00:00:00Z",
    verifierPrincipalId: "principal_identity_verifier",
  };
  sourceDefinition.sourceSnapshotId = "source_release_standard";
  sourceDefinition.supersedes = [];
  options.mutateSource?.(sourceDefinition);
  const source = {
    ...sourceDefinition,
    definitionSha256: digestEvaluationRecordDefinition("source_snapshot", scope, sourceDefinition),
    publishedByPrincipalId: "principal_source_publisher",
    recordedAt: "2026-01-03T00:00:00.000Z",
    schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION,
    scope,
  } as SourceSnapshot;

  const reviewerDefinition = definition<SourceReviewerQualificationDefinition>(
    sourceVectors,
    "source_reviewer_qualification",
  );
  reviewerDefinition.applicabilityScope = anyPolicySourceScope();
  reviewerDefinition.qualificationId = "qualification_release_reviewer";
  reviewerDefinition.reviewerPrincipalId = "principal_source_reviewer";
  reviewerDefinition.sourceKinds = [source.sourceKind];
  reviewerDefinition.validFrom = "2026-01-01T00:00:00Z";
  reviewerDefinition.validUntil = "2027-04-01T00:00:00Z";
  options.mutateReviewer?.(reviewerDefinition);
  const reviewer = {
    ...reviewerDefinition,
    definitionSha256: digestEvaluationRecordDefinition(
      "source_reviewer_qualification",
      scope,
      reviewerDefinition,
    ),
    recordedAt: "2026-01-04T00:00:00.000Z",
    schemaVersion: SOURCE_REVIEWER_QUALIFICATION_SCHEMA_VERSION,
    scope,
    verifiedByPrincipalId: "principal_credential_authority",
  } as SourceReviewerQualification;

  const reviewDefinition = definition<SourceReviewDefinition>(sourceVectors, "source_review");
  reviewDefinition.approvedScope = anyPolicySourceScope();
  reviewDefinition.criticalConflictStatus = "none";
  reviewDefinition.declaredRelationships = [];
  reviewDefinition.reviewedConflicts = [];
  reviewDefinition.reviewerQualification = qualificationReference(reviewer);
  reviewDefinition.source = sourceReference(source);
  reviewDefinition.sourceReviewId = "review_release_standard";
  reviewDefinition.validFrom = "2026-01-01T00:00:00Z";
  reviewDefinition.validUntil = "2027-04-01T00:00:00Z";
  options.mutateReview?.(reviewDefinition);
  const review = {
    ...reviewDefinition,
    definitionSha256: digestEvaluationRecordDefinition("source_review", scope, reviewDefinition),
    reviewedAt: "2026-01-05T00:00:00.000Z",
    reviewedByPrincipalId: reviewer.reviewerPrincipalId,
    reviewerRole: "Independent release policy source reviewer",
    schemaVersion: SOURCE_REVIEW_SCHEMA_VERSION,
    scope,
  } as SourceReviewRecord;

  const exactSource = {
    review: reviewReference(review),
    source: sourceReference(source),
  };
  const policyDefinition = definition<ReleasePolicyDefinition>(policyVectors, "release_policy");
  policyDefinition.counterevidence = [];
  policyDefinition.effectiveAt = "2026-09-07T00:00:00.000Z";
  policyDefinition.expiresAt = "2027-03-07T00:00:00.000Z";
  policyDefinition.sources = [exactSource];
  policyDefinition.rules = policyDefinition.rules.map((rule) => ({
    ...rule,
    sources: [exactSource],
  }));

  const bindingDefinition = definition<PolicyInstallationBindingDefinition>(
    policyVectors,
    "policy_installation_binding",
  );
  bindingDefinition.effectiveAt = "2026-01-01T00:00:00.000Z";
  bindingDefinition.expiresAt = "2027-09-01T00:00:00.000Z";
  bindingDefinition.scope = scope;
  options.mutateBinding?.(bindingDefinition);
  const binding = {
    ...bindingDefinition,
    definitionSha256: digestPolicyInstallationBindingDefinition(
      bindingDefinition.scope,
      bindingDefinition,
    ),
    registeredAt: "2026-01-01T00:00:00.000Z",
    registeredByPrincipalId: "principal_operator",
    schemaVersion: POLICY_INSTALLATION_BINDING_SCHEMA_VERSION,
  } as PolicyInstallationBinding;

  policyDefinition.installationBinding = {
    bindingVersionId: binding.bindingVersionId,
    definitionSha256: binding.definitionSha256,
    installationId: binding.installationId,
  };
  options.mutatePolicy?.(policyDefinition);

  const artifacts = artifactAvailability([
    binding.authorityEvidence,
    source.content,
    ...(source.identityVerification.status === "verified"
      ? source.identityVerification.evidence
      : []),
    ...review.reviewBasis,
    ...reviewer.credentialEvidence,
  ]);
  const policy = {
    ...policyDefinition,
    definitionSha256: digestReleasePolicyDefinition(scope, policyDefinition),
    publishedAt: "2026-09-06T23:00:00.000Z",
    publishedByPrincipalId: policyDefinition.issuerPrincipalId,
    schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
    scope,
  } as ReleasePolicy;

  return {
    binding,
    input: {
      artifacts,
      at: policy.publishedAt,
      definition: policyDefinition,
      installationBinding: binding,
      publisherPrincipalId: policy.publishedByPrincipalId,
      scope,
      sources: [
        {
          reference: exactSource,
          review,
          reviewerQualification: reviewer,
          source,
        },
      ],
    },
    policy,
    review,
    reviewer,
    source,
  };
}
