import { describe, expect, it } from "vitest";
import {
  anyPolicySourceScope,
  policyAuthorityFixture as authorityFixture,
  type PolicyAuthorityFixtureOptions,
} from "../testing/release-policy-fixtures.js";
import {
  type ReleasePolicyAuthorityReason,
  type ValidateReleasePolicyAuthorityInput,
  validateReleasePolicyAuthority,
} from "./release-policy-authority.js";
import { InvalidReleasePolicyAuthorityInputError } from "./release-policy-errors.js";

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

  it.each([
    { expiry: undefined, name: "no declared expiry", valid: true },
    { expiry: "2027-03-06T23:59:59.999999Z", name: "one microsecond too early", valid: false },
    { expiry: "2027-03-07T00:00:00Z", name: "the exact policy expiry", valid: true },
    { expiry: "2027-03-07T00:00:00.000001Z", name: "one microsecond later", valid: true },
  ])("respects a source with $name without inventing an expiry", ({ expiry, valid }) => {
    const fixture = authorityFixture({
      mutateSource(source) {
        if (expiry === undefined) delete source.expiresAt;
        else source.expiresAt = expiry;
      },
    });
    const result = validateReleasePolicyAuthority(fixture.input);
    expect(result.status).toBe(valid ? "valid" : "invalid");
    expect(result.findings.map(({ reason }) => reason)).toEqual(
      valid ? [] : ["source_not_current"],
    );
    expect(fixture.source.expiresAt).toBe(expiry);
  });

  it("keeps finite authority and freshness requirements when the source declares no expiry", () => {
    const mutateSource: NonNullable<PolicyAuthorityFixtureOptions["mutateSource"]> = (source) => {
      delete source.expiresAt;
    };
    const reviewExpired = authorityFixture({
      mutateSource,
      mutateReview(review) {
        review.validUntil = "2027-01-01T00:00:00Z";
      },
    });
    expect(reasons(reviewExpired.input)).toContain("source_review_not_current");
    const reviewUnknown = authorityFixture({
      mutateSource,
      mutateReview(review) {
        review.freshnessConclusion = "unknown";
        review.outcome = "unverifiable";
      },
    });
    expect(reasons(reviewUnknown.input)).toEqual(
      expect.arrayContaining(["source_review_not_current", "source_review_not_approved"]),
    );
    const qualificationExpired = authorityFixture({
      mutateSource,
      mutateReviewer(reviewer) {
        reviewer.validUntil = "2027-01-01T00:00:00Z";
      },
    });
    expect(reasons(qualificationExpired.input)).toContain("reviewer_qualification_not_current");
    const bindingExpired = authorityFixture({
      mutateSource,
      mutateBinding(binding) {
        binding.expiresAt = "2027-01-01T00:00:00.000Z";
      },
    });
    expect(reasons(bindingExpired.input)).toContain("installation_binding_interval_mismatch");
    const unavailable = authorityFixture({ mutateSource });
    expect(reasons({ ...unavailable.input, artifacts: [] })).toContain(
      "source_content_unavailable",
    );
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
          ...anyPolicySourceScope(),
          environments: { mode: "include", values: ["env_other"] },
        };
      },
    }).input;
    expect(reasons(sourceMismatch)).toContain("source_scope_mismatch");

    const reviewerMismatch = authorityFixture({
      mutateReviewer: (reviewer) => {
        reviewer.applicabilityScope = {
          ...anyPolicySourceScope(),
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
