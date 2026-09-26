import { describe, expect, it } from "vitest";
import {
  type PolicyAuthorityFixtureOptions,
  policyAuthorityFixture,
} from "../testing/release-policy-fixtures.js";
import {
  validateReleasePolicyAuthority,
  validateReleasePolicyEvaluationAuthority,
} from "./release-policy-authority.js";
import { InvalidReleasePolicyAuthorityInputError } from "./release-policy-errors.js";

describe("retained policy evaluation authority", () => {
  it("distinguishes publishable future policy from effective evaluation authority", () => {
    const { input } = policyAuthorityFixture();
    expect(validateReleasePolicyAuthority(input)).toEqual({ findings: [], status: "valid" });
    expect(validateReleasePolicyEvaluationAuthority(input)).toEqual({
      findings: [{ reason: "policy_not_effective_at_evaluation" }],
      status: "invalid",
    });
  });

  it.each([
    ["2026-09-06T23:59:59.999999999999999999999999999999Z", "policy_not_effective_at_evaluation"],
    ["2026-09-07T00:00:00Z", undefined],
    ["2026-09-07T00:00:00.000000000000000000000000000001Z", undefined],
    ["2027-03-06T23:59:59.999999999999999999999999999999Z", undefined],
    ["2027-03-07T00:00:00Z", "policy_expired_at_evaluation"],
    ["2027-03-07T00:00:00.000000000000000000000000000001Z", "policy_expired_at_evaluation"],
  ])("uses the exact half-open policy interval at %s", (at, reason) => {
    const { input } = policyAuthorityFixture();
    expect(validateReleasePolicyEvaluationAuthority({ ...input, at })).toEqual({
      findings: reason ? [{ reason }] : [],
      status: reason ? "invalid" : "valid",
    });
  });

  it.each([
    "2026-10-01T09:00:00+09:00",
    "2026-10-01T00:00:00.0000000000000000000000000000001Z",
    "2026-02-30T00:00:00Z",
    "not-a-time",
  ])("rejects invalid or non-UTC evaluation time %s", (at) => {
    expect(() =>
      validateReleasePolicyEvaluationAuthority({ ...policyAuthorityFixture().input, at }),
    ).toThrow(InvalidReleasePolicyAuthorityInputError);
  });

  it("does not widen publication timestamps or mutate full retained records", () => {
    const input = { ...policyAuthorityFixture().input, at: "2026-10-01T00:00:00.0000001Z" };
    const before = structuredClone(input);
    expect(validateReleasePolicyEvaluationAuthority(input).status).toBe("valid");
    expect(input).toEqual(before);
    expect(() => validateReleasePolicyAuthority(input)).toThrow(
      InvalidReleasePolicyAuthorityInputError,
    );
  });

  const truncationCases: [string, PolicyAuthorityFixtureOptions][] = [
    [
      "source_not_effective",
      {
        mutateSource: (s) => {
          s.effectiveAt = "2026-09-07T09:00:00.0000001+09:00";
        },
      },
    ],
    [
      "source_not_current",
      {
        mutateSource: (s) => {
          s.expiresAt = "2027-03-06T23:59:59.9999999Z";
        },
      },
    ],
    [
      "source_review_not_current",
      {
        mutateReview: (r) => {
          r.validUntil = "2027-03-06T23:59:59.9999999Z";
        },
      },
    ],
    [
      "reviewer_qualification_not_current",
      {
        mutateReviewer: (q) => {
          q.validUntil = "2027-03-06T23:59:59.9999999Z";
        },
      },
    ],
    [
      "source_identity_not_current",
      {
        mutateSource: (s) => {
          if (s.identityVerification.status !== "verified")
            throw new Error("Expected verified identity");
          s.identityVerification.verifiedAt = "2026-10-01T00:00:00.0000001Z";
        },
      },
    ],
  ];
  it.each(truncationCases)("never rounds away %s", (reason, options) => {
    const { input } = policyAuthorityFixture(options);
    const result = validateReleasePolicyEvaluationAuthority({
      ...input,
      at: "2026-10-01T00:00:00Z",
    });
    expect(result.status).toBe("invalid");
    expect(result.findings.map((finding) => finding.reason)).toContain(reason);
  });

  it("also preserves exact source interval comparisons for publication", () => {
    const { input } = policyAuthorityFixture(truncationCases[1]?.[1]);
    expect(validateReleasePolicyAuthority(input).findings).toContainEqual({
      reason: "source_not_current",
      sourceSnapshotId: "source_release_standard",
      sourceReviewId: "review_release_standard",
    });
  });

  it("rejects corrupted retained records rather than treating them as missing", () => {
    const input = structuredClone(policyAuthorityFixture().input);
    const source = input.sources[0]?.source;
    if (!source) throw new Error("Expected source");
    source.definitionSha256 = "0".repeat(64);
    expect(() => validateReleasePolicyEvaluationAuthority(input)).toThrow(
      InvalidReleasePolicyAuthorityInputError,
    );
  });
});
