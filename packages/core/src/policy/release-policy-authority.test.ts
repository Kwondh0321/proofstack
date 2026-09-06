import { readFileSync } from "node:fs";
import type {
  EvidenceScope,
  PolicyInstallationBinding,
  PolicyInstallationBindingDefinition,
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
  POLICY_INSTALLATION_BINDING_SCHEMA_VERSION,
  SOURCE_REVIEW_SCHEMA_VERSION,
  SOURCE_REVIEWER_QUALIFICATION_SCHEMA_VERSION,
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { digestEvaluationRecordDefinition } from "../evaluation/evaluation-record-validation.js";
import {
  type ReleasePolicyAuthorityArtifactAvailability,
  type ReleasePolicyAuthorityReason,
  type ValidateReleasePolicyAuthorityInput,
  validateReleasePolicyAuthority,
} from "./release-policy-authority.js";
import { InvalidReleasePolicyAuthorityInputError } from "./release-policy-errors.js";
import { digestPolicyInstallationBindingDefinition } from "./release-policy-record-validation.js";

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

function anySourceScope(): SourceApplicabilityScope {
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

interface AuthorityFixtureOptions {
  readonly mutateBinding?: (definition: PolicyInstallationBindingDefinition) => void;
  readonly mutatePolicy?: (definition: ReleasePolicyDefinition) => void;
  readonly mutateReview?: (definition: SourceReviewDefinition) => void;
  readonly mutateReviewer?: (definition: SourceReviewerQualificationDefinition) => void;
  readonly mutateSource?: (definition: SourceSnapshotDefinition) => void;
}

interface AuthorityFixture {
  readonly input: ValidateReleasePolicyAuthorityInput;
  readonly review: SourceReviewRecord;
  readonly reviewer: SourceReviewerQualification;
  readonly source: SourceSnapshot;
}

function authorityFixture(options: AuthorityFixtureOptions = {}): AuthorityFixture {
  const scope: EvidenceScope = {
    environmentId: "env_staging",
    projectId: "project_checkout",
    tenantId: "tenant_example",
  };

  const sourceDefinition = definition<SourceSnapshotDefinition>(sourceVectors, "source_snapshot");
  sourceDefinition.applicabilityScope = anySourceScope();
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
  reviewerDefinition.applicabilityScope = anySourceScope();
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
  reviewDefinition.approvedScope = anySourceScope();
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

  return {
    input: {
      artifacts,
      at: "2026-09-06T23:00:00.000Z",
      definition: policyDefinition,
      installationBinding: binding,
      publisherPrincipalId: "principal_policy_author",
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
    review,
    reviewer,
    source,
  };
}

function reasons(
  input: ValidateReleasePolicyAuthorityInput,
): readonly ReleasePolicyAuthorityReason[] {
  return validateReleasePolicyAuthority(input).findings.map(({ reason }) => reason);
}

describe("release policy publication authority", () => {
  it("accepts only a complete exact installation and independently reviewed source chain", () => {
    expect(validateReleasePolicyAuthority(authorityFixture().input)).toEqual({
      findings: [],
      status: "valid",
    });
  });

  it("fails closed for missing, mismatched, expired, or unauthorized installation authority", () => {
    const missing = authorityFixture().input;
    expect(reasons({ ...missing, installationBinding: null })).toContain(
      "installation_binding_unavailable",
    );

    const unauthorized = authorityFixture({
      mutateBinding: (binding) => {
        binding.allowedModes = ["advisory"];
        binding.authorizedIssuerPrincipalIds = ["principal_other_author"];
        binding.expiresAt = "2027-01-01T00:00:00.000Z";
      },
    }).input;
    expect(reasons(unauthorized)).toEqual(
      expect.arrayContaining([
        "installation_binding_interval_mismatch",
        "issuer_not_authorized",
        "policy_mode_not_authorized",
      ]),
    );

    const wrongScope = authorityFixture({
      mutateBinding: (binding) => {
        binding.scope = { ...binding.scope, environmentId: "env_other" };
      },
    }).input;
    expect(reasons(wrongScope)).toContain("installation_binding_scope_mismatch");

    const issuerMismatch = authorityFixture({
      mutatePolicy: (policy) => {
        policy.issuerPrincipalId = "principal_other_author";
      },
    }).input;
    expect(reasons(issuerMismatch)).toContain("issuer_not_authorized");

    const referenceMismatch = authorityFixture({
      mutatePolicy: (policy) => {
        policy.installationBinding = {
          ...policy.installationBinding,
          bindingVersionId: "binding_untrusted",
        };
      },
    }).input;
    expect(reasons(referenceMismatch)).toContain("installation_binding_reference_mismatch");

    const notRegistered = authorityFixture().input;
    expect(
      reasons({
        ...notRegistered,
        installationBinding: notRegistered.installationBinding
          ? {
              ...notRegistered.installationBinding,
              registeredAt: "2026-09-07T00:00:00.000Z",
            }
          : null,
      }),
    ).toContain("installation_binding_not_registered");

    expect(reasons({ ...authorityFixture().input, at: "2027-09-01T00:00:00.000Z" })).toEqual(
      expect.arrayContaining([
        "installation_binding_not_current",
        "policy_not_publishable_at_time",
      ]),
    );
  });

  it("requires every exact source, review, and reviewer qualification record", () => {
    const fixture = authorityFixture();
    const resolved = fixture.input.sources[0];
    if (!resolved) throw new Error("Expected resolved authority source");
    expect(reasons({ ...fixture.input, sources: [] })).toEqual([
      "source_review_unavailable",
      "source_snapshot_unavailable",
    ]);
    expect(
      reasons({
        ...fixture.input,
        sources: [{ ...resolved, review: null, reviewerQualification: null }],
      }),
    ).toContain("source_review_unavailable");
    expect(
      reasons({
        ...fixture.input,
        sources: [{ ...resolved, reviewerQualification: null }],
      }),
    ).toContain("reviewer_qualification_unavailable");
  });

  it("rejects disputed identity, author review, relationships, and unresolved source conflicts", () => {
    const disputed = authorityFixture({
      mutateSource: (source) => {
        source.identityVerification = {
          evidence: [source.content],
          reason: "The publisher identity cannot be reconciled.",
          status: "disputed",
        };
      },
    }).input;
    expect(reasons(disputed)).toContain("source_identity_disputed");

    const selfReviewed = authorityFixture({
      mutateReview: (review) => {
        review.declaredRelationships = ["Policy author reviewed the selected authority source."];
      },
    });
    const source = selfReviewed.input.sources[0];
    if (!source) throw new Error("Expected resolved authority source");
    expect(
      reasons({
        ...selfReviewed.input,
        sources: [
          {
            ...source,
            review: source.review
              ? { ...source.review, reviewedByPrincipalId: "principal_policy_author" }
              : null,
          },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        "source_review_not_independent",
        "source_review_relationship_disclosed",
      ]),
    );

    const incompleteConflict = authorityFixture({
      mutateSource: (source) => {
        source.conflictsWith = [
          {
            definitionSha256: "8".repeat(64),
            sourceSnapshotId: "source_unreviewed_conflict",
          },
        ];
      },
    }).input;
    expect(reasons(incompleteConflict)).toContain("source_conflict_review_incomplete");

    const unresolvedConflict = authorityFixture({
      mutateReview: (review) => {
        review.criticalConflictStatus = "unresolved";
        review.outcome = "require_approval";
        review.reviewedConflicts = [
          {
            definitionSha256: "8".repeat(64),
            sourceSnapshotId: "source_unresolved_conflict",
          },
        ];
      },
      mutateSource: (source) => {
        source.conflictsWith = [
          {
            definitionSha256: "8".repeat(64),
            sourceSnapshotId: "source_unresolved_conflict",
          },
        ];
      },
    }).input;
    expect(reasons(unresolvedConflict)).toEqual(
      expect.arrayContaining(["source_conflict_unresolved", "source_review_not_approved"]),
    );
  });

  it("rejects unverified, future, or non-independent source identity claims", () => {
    const unverified = authorityFixture({
      mutateSource: (source) => {
        source.identityVerification = {
          reason: "No independent publisher identity proof was retained.",
          status: "unverified",
        };
      },
    }).input;
    expect(reasons(unverified)).toContain("source_identity_unverified");

    const futureVerification = authorityFixture({
      mutateSource: (source) => {
        if (source.identityVerification.status !== "verified") {
          throw new Error("Expected a verified source identity");
        }
        source.identityVerification.verifiedAt = "2026-09-07T00:00:00.000Z";
      },
    }).input;
    expect(reasons(futureVerification)).toContain("source_identity_not_current");

    const authorVerified = authorityFixture({
      mutateSource: (source) => {
        if (source.identityVerification.status !== "verified") {
          throw new Error("Expected a verified source identity");
        }
        source.identityVerification.verifierPrincipalId = "principal_policy_author";
      },
    }).input;
    expect(reasons(authorVerified)).toContain("source_identity_not_independent");
  });

  it("rejects unavailable, not-yet-effective, and unusably licensed sources", () => {
    const notEffective = authorityFixture({
      mutateSource: (source) => {
        source.effectiveAt = "2026-10-01T00:00:00.000Z";
      },
    }).input;
    expect(reasons(notEffective)).toContain("source_not_effective");

    const notRecorded = authorityFixture();
    const resolution = notRecorded.input.sources[0];
    if (!resolution?.source) throw new Error("Expected resolved source record");
    expect(
      reasons({
        ...notRecorded.input,
        sources: [
          {
            ...resolution,
            source: { ...resolution.source, recordedAt: "2026-09-07T00:00:00.000Z" },
          },
        ],
      }),
    ).toContain("source_not_effective");

    const unknownLicense = authorityFixture({
      mutateSource: (source) => {
        source.license = {
          reason: "Reuse terms could not be established.",
          status: "unknown",
        };
      },
    }).input;
    expect(reasons(unknownLicense)).toContain("source_license_unusable");
  });

  it("requires source, review, and qualification intervals to cover the complete policy interval", () => {
    const sourceExpired = authorityFixture({
      mutateSource: (source) => {
        source.expiresAt = "2027-01-01T00:00:00Z";
      },
    }).input;
    expect(reasons(sourceExpired)).toContain("source_not_current");

    const reviewExpired = authorityFixture({
      mutateReview: (review) => {
        review.validUntil = "2027-01-01T00:00:00Z";
      },
    }).input;
    expect(reasons(reviewExpired)).toContain("source_review_not_current");

    const qualificationExpired = authorityFixture({
      mutateReviewer: (reviewer) => {
        reviewer.validUntil = "2027-01-01T00:00:00Z";
      },
    }).input;
    expect(reasons(qualificationExpired)).toContain("reviewer_qualification_not_current");
  });

  it("rejects stale or adverse review conclusions and insufficient reviewer authority", () => {
    const staleReview = authorityFixture({
      mutateReview: (review) => {
        review.freshnessConclusion = "expired";
        review.outcome = "require_approval";
      },
    }).input;
    expect(reasons(staleReview)).toEqual(
      expect.arrayContaining(["source_review_not_approved", "source_review_not_current"]),
    );

    const futureReview = authorityFixture();
    const futureResolution = futureReview.input.sources[0];
    if (!futureResolution?.review) throw new Error("Expected resolved source review");
    expect(
      reasons({
        ...futureReview.input,
        sources: [
          {
            ...futureResolution,
            review: {
              ...futureResolution.review,
              reviewedAt: "2026-09-07T00:00:00.000Z",
            },
          },
        ],
      }),
    ).toContain("source_review_not_current");

    const referenceMismatch = authorityFixture({
      mutateReview: (review) => {
        review.reviewerQualification = {
          definitionSha256: "7".repeat(64),
          qualificationId: "qualification_other_reviewer",
        };
      },
    }).input;
    expect(reasons(referenceMismatch)).toContain("reviewer_qualification_reference_mismatch");

    const unsupportedKind = authorityFixture({
      mutateReviewer: (reviewer) => {
        reviewer.sourceKinds = ["law_or_regulation"];
      },
    }).input;
    expect(reasons(unsupportedKind)).toContain("reviewer_qualification_source_kind_mismatch");

    const unqualified = authorityFixture({
      mutateReviewer: (reviewer) => {
        reviewer.status = "unqualified";
        reviewer.statusReasons = ["The required subject-matter credential expired."];
      },
    }).input;
    expect(reasons(unqualified)).toContain("reviewer_qualification_not_qualified");

    const authorQualified = authorityFixture().input;
    const qualificationResolution = authorQualified.sources[0];
    if (!qualificationResolution?.reviewerQualification) {
      throw new Error("Expected reviewer qualification");
    }
    expect(
      reasons({
        ...authorQualified,
        sources: [
          {
            ...qualificationResolution,
            reviewerQualification: {
              ...qualificationResolution.reviewerQualification,
              verifiedByPrincipalId: "principal_policy_author",
            },
          },
        ],
      }),
    ).toContain("reviewer_qualification_not_independent");
  });

  it("requires retained bytes for installation, source, identity, review, and qualification evidence", () => {
    const fixture = authorityFixture();
    const unavailable = fixture.input.artifacts.map((artifact) => ({
      ...artifact,
      state: "unavailable" as const,
    }));
    expect(reasons({ ...fixture.input, artifacts: unavailable })).toEqual(
      expect.arrayContaining([
        "installation_authority_evidence_unavailable",
        "reviewer_qualification_evidence_unavailable",
        "source_content_unavailable",
        "source_identity_evidence_unavailable",
        "source_review_basis_unavailable",
      ]),
    );
  });

  it("requires source and reviewer applicability to cover the complete policy target set", () => {
    const sourceMismatch = authorityFixture({
      mutateSource: (source) => {
        source.applicabilityScope = {
          ...anySourceScope(),
          environments: { mode: "include", values: ["env_other"] },
        };
      },
    }).input;
    expect(reasons(sourceMismatch)).toContain("source_scope_mismatch");

    const reviewerMismatch = authorityFixture({
      mutateReviewer: (reviewer) => {
        reviewer.applicabilityScope = {
          ...anySourceScope(),
          riskTiers: { mode: "include", values: ["low"] },
        };
      },
    }).input;
    expect(reasons(reviewerMismatch)).toContain("reviewer_qualification_scope_mismatch");
  });

  it("rejects malformed, forged, duplicate, or irrelevant resolver evidence", () => {
    const fixture = authorityFixture();
    const firstArtifact = fixture.input.artifacts[0];
    const firstSource = fixture.input.sources[0];
    if (!firstArtifact || !firstSource) throw new Error("Expected authority evidence");

    for (const invalid of [
      { ...fixture.input, artifacts: [firstArtifact, firstArtifact] },
      {
        ...fixture.input,
        installationBinding: {
          ...fixture.input.installationBinding,
          definitionSha256: "0".repeat(64),
        },
      },
      { ...fixture.input, publisherPrincipalId: "invalid ID" },
      { ...fixture.input, sources: [firstSource, firstSource] },
    ]) {
      expect(() => validateReleasePolicyAuthority(invalid as never)).toThrow(
        InvalidReleasePolicyAuthorityInputError,
      );
    }
  });
});
