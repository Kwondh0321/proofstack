import { ReleaseDecisionIdentityObservationSchema } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { capturedReleaseReviewerFixture as fixture } from "../testing/release-reviewer-fixtures.js";
import {
  inspectCapturedReleaseReviewerEligibility,
  InvalidCapturedReleaseReviewerError,
} from "./captured-release-reviewer-eligibility.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

describe("current captured reviewer eligibility, never actual authentication or publication", () => {
  it("retains exact eligible groups and synthetic provenance instead of certifying expertise", () => {
    const value = fixture();
    const before = structuredClone({ census: value.census, context: value.context });
    const result = inspectCapturedReleaseReviewerEligibility(value);
    expect(result).toEqual({
      state: "eligible",
      principalId: value.receipt.principalId,
      groupIds: ["group_release_review"],
      independentHuman: true,
      assurance: "synthetic_reference",
      authorityExpiresAt: value.authority.expiresAt,
    });
    expect(value.budget.snapshot().records).toBe(3);
    expect({ census: value.census, context: value.context }).toEqual(before);
    if (result.state !== "eligible") throw new Error("Missing eligible fixture");
    (result.groupIds as string[]).push("group_other");
    expect(value.authority.independenceGroupIds).not.toContain("group_other");
  });
  it("allows a candidate author only in an optional ordinary seat, never an independent human seat", () => {
    const value = fixture();
    value.context = { ...value.context, candidateAuthorPrincipalId: value.receipt.principalId };
    expect(inspectCapturedReleaseReviewerEligibility(value)).toMatchObject({
      state: "eligible",
      independentHuman: false,
    });
    value.context = {
      ...value.context,
      requirement: { ...value.context.requirement, excludeCandidateAuthor: true },
    };
    expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
      state: "ineligible",
      reason: "subject_author",
    });
  });
  it("always excludes the original policy author", () => {
    const value = fixture();
    value.context = { ...value.context, policyAuthorPrincipalId: value.receipt.principalId };
    expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
      state: "ineligible",
      reason: "subject_author",
    });
  });
  it("requires complete evaluator provenance for exceptions and excludes its original evaluator and candidate author", () => {
    const value = fixture();
    value.context = { ...value.context, purpose: "rule_exception" };
    expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
      state: "unavailable",
      reason: "evaluator_provenance_unavailable",
    });
    value.context = { ...value.context, evaluatorPrincipalIds: [value.receipt.principalId] };
    expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
      state: "ineligible",
      reason: "subject_evaluator",
    });
    value.context = { ...value.context, evaluatorPrincipalIds: ["worker_other"] };
    expect(inspectCapturedReleaseReviewerEligibility(value)).toMatchObject({
      state: "eligible",
      independentHuman: true,
    });
    value.context = { ...value.context, candidateAuthorPrincipalId: value.receipt.principalId };
    expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
      state: "ineligible",
      reason: "subject_author",
    });
  });
  it.each(["unverifiable", "rejected"] as const)(
    "rejects %s current authority while retaining its original declaration",
    (status) => {
      const value = fixture({
        status,
        statusReasons: ["The owning operator cannot verify current expertise."],
      });
      expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
        state: "ineligible",
        reason: "authority_unverified",
      });
    },
  );
  it.each(["role", "group"] as const)(
    "does not replace missing eligible %s membership with a generic role",
    (kind) => {
      const value = fixture();
      value.context = {
        ...value.context,
        requirement: {
          ...value.context.requirement,
          ...(kind === "role"
            ? { reviewerRoleIds: ["role_other"] }
            : { independenceGroupIds: ["group_other"], humanReviewerGroupIds: [] }),
        },
      };
      expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
        state: "ineligible",
        reason: kind === "role" ? "role_missing" : "group_missing",
      });
    },
  );
  it.each(["missing", "unavailable"] as const)(
    "retains %s identity and authority observations as unavailable",
    (state) => {
      const value = fixture();
      value.grant = ReleaseDecisionIdentityObservationSchema.parse({
        state,
        reference: value.identity,
      });
      expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
        state: "unavailable",
        reason: "identity_unavailable",
      });
      const absent = fixture();
      absent.census.records = [];
      expect(inspectCapturedReleaseReviewerEligibility(absent)).toEqual({
        state: "unavailable",
        reason: "authority_unavailable",
      });
    },
  );
  it("does not use a current grant after its explicit original session revocation", () => {
    const value = fixture();
    if (value.credential.state !== "observed") throw new Error("Missing credential fixture");
    value.credential.record.revokedAt = "2026-10-15T10:20:00.000001Z";
    value.credential.record.revocationReason = "administrative";
    expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
      state: "ineligible",
      reason: "identity_ineligible",
    });
  });
  it("preserves a review beyond natural old-login expiry without extending its own authority interval", () => {
    const value = fixture();
    value.capturedAt = "2026-10-15T11:30:00.000001Z";
    expect(inspectCapturedReleaseReviewerEligibility(value)).toMatchObject({ state: "eligible" });
    value.capturedAt = value.authority.expiresAt;
    expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
      state: "ineligible",
      reason: "authority_inactive",
    });
  });
  it.each(["future_publication", "future_effective", "expired_at_review"] as const)(
    "rejects authority %s even if its later captured label is current",
    (kind) => {
      const value = fixture(
        kind === "future_effective" ? { effectiveAt: "2026-10-15T10:10:00.000001Z" } : {},
      );
      if (kind === "future_publication")
        value.authority.publishedAt = "2026-10-15T10:10:00.000001Z";
      if (kind === "expired_at_review") {
        value.recordedAt = value.authority.expiresAt;
        value.capturedAt = "2026-10-16T00:01:00.000001Z";
      }
      expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
        state: "ineligible",
        reason: "authority_inactive",
      });
    },
  );
  it.each(["before_native_creation", "at_absolute_expiry"] as const)(
    "rejects original review %s rather than rounding through its authentication receipt",
    (kind) => {
      const value = fixture();
      value.recordedAt =
        kind === "before_native_creation"
          ? value.receipt.authenticatedAt
          : "2026-10-15T11:00:00.000001Z";
      value.capturedAt = "2026-10-15T11:01:00.000001Z";
      expect(inspectCapturedReleaseReviewerEligibility(value)).toEqual({
        state: "ineligible",
        reason: "identity_ineligible",
      });
    },
  );
  it.each([
    "future_review",
    "before_authentication",
    "wrong_reviewer",
    "unknown_context",
    "duplicate_evaluator",
    "unknown_purpose",
  ] as const)("rejects substituted %s inputs with a bounded error", (kind) => {
    const value = fixture();
    if (kind === "future_review") value.recordedAt = "2026-10-15T10:30:00.000002Z";
    if (kind === "before_authentication") value.recordedAt = "2026-10-15T09:59:59.999999Z";
    if (kind === "wrong_reviewer") value.reference.reviewerPrincipalId = "user_other";
    if (kind === "unknown_context") Reflect.set(value.context, "verified", true);
    if (kind === "duplicate_evaluator")
      value.context = { ...value.context, evaluatorPrincipalIds: ["worker_one", "worker_one"] };
    if (kind === "unknown_purpose") Reflect.set(value.context, "purpose", "__proto__");
    expect(() => inspectCapturedReleaseReviewerEligibility(value)).toThrow(
      InvalidCapturedReleaseReviewerError,
    );
  });
  it("shares aggregate admission with the original graph and propagates a caught failed observation", () => {
    const value = fixture();
    value.budget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 3,
      maxAcquisitionRecordBytes: 1_000_000,
      maxApprovalRecords: 0,
    });
    value.budget.observe({ priorOriginalGraphRow: true });
    expect(() => inspectCapturedReleaseReviewerEligibility(value)).toThrow(
      ReleaseDecisionVerificationBudgetError,
    );
    expect(() => value.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
});
