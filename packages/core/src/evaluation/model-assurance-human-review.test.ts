import { readFileSync } from "node:fs";
import type {
  HumanReviewerIndependence,
  HumanReviewProtocol,
  HumanReviewRecord,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateHumanReviewQuorum,
  InvalidHumanReviewQuorumInputError,
} from "./model-assurance-human-review.js";

interface StoredVector {
  readonly input: { definition: Record<string, unknown>; scope: Record<string, string> };
  readonly sha256: string;
}

interface VectorDocument {
  readonly vectors: readonly StoredVector[];
}

function vector(file: string): StoredVector {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${file}`, import.meta.url), "utf8"),
  ) as VectorDocument;
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected vector ${file}`);
  return value;
}

function records(): {
  declarations: HumanReviewerIndependence[];
  protocol: HumanReviewProtocol;
  reviews: HumanReviewRecord[];
} {
  const protocolVector = vector("evaluation-human-review-protocol-definition-v1.json");
  const protocol = {
    ...structuredClone(protocolVector.input.definition),
    definitionSha256: protocolVector.sha256,
    publishedAt: "2026-09-02T02:00:00.000Z",
    publishedByPrincipalId: "usr_protocol_publisher",
    schemaVersion: "0.1",
    scope: structuredClone(protocolVector.input.scope),
  } as unknown as HumanReviewProtocol;
  const independenceVector = vector("evaluation-human-reviewer-independence-definition-v1.json");
  const firstDeclaration = {
    ...structuredClone(independenceVector.input.definition),
    definitionSha256: independenceVector.sha256,
    recordedAt: "2026-09-02T02:30:01.000Z",
    schemaVersion: "0.1",
    scope: structuredClone(independenceVector.input.scope),
  } as unknown as HumanReviewerIndependence;
  firstDeclaration.declarationId = "hri_domain_reviewer";
  firstDeclaration.independenceGroupIds = ["hig_domain_lab"];
  firstDeclaration.reviewerPrincipalId = "usr_domain_reviewer";
  firstDeclaration.definitionSha256 = "1".repeat(64);
  const secondDeclaration = structuredClone(firstDeclaration);
  secondDeclaration.declarationId = "hri_safety_reviewer";
  secondDeclaration.independenceGroupIds = ["hig_safety_lab"];
  secondDeclaration.reviewerPrincipalId = "usr_safety_reviewer";
  secondDeclaration.definitionSha256 = "2".repeat(64);

  const reviewVector = vector("evaluation-human-review-record-definition-v1.json");
  const firstReview = {
    ...structuredClone(reviewVector.input.definition),
    definitionSha256: "3".repeat(64),
    recordedAt: "2026-09-02T03:20:01.000Z",
    schemaVersion: "0.1",
    scope: structuredClone(reviewVector.input.scope),
  } as unknown as HumanReviewRecord;
  firstReview.reviewId = "hrr_domain_reviewer";
  firstReview.protocol = {
    definitionSha256: protocol.definitionSha256,
    protocolId: protocol.protocolId,
    protocolVersionId: protocol.protocolVersionId,
  };
  firstReview.independenceDeclaration = {
    declarationId: firstDeclaration.declarationId,
    definitionSha256: firstDeclaration.definitionSha256,
  };
  firstReview.reviewer.principalId = firstDeclaration.reviewerPrincipalId;
  firstReview.reviewerRoleId = "role_domain_reviewer";
  firstReview.reviewedArtifacts = structuredClone(protocol.claim.evidenceBundle);

  const secondReview = structuredClone(firstReview);
  secondReview.definitionSha256 = "4".repeat(64);
  secondReview.reviewId = "hrr_safety_reviewer";
  secondReview.independenceDeclaration = {
    declarationId: secondDeclaration.declarationId,
    definitionSha256: secondDeclaration.definitionSha256,
  };
  secondReview.reviewer.principalId = secondDeclaration.reviewerPrincipalId;
  secondReview.reviewer.sessionId = "ses_human_review_0002";
  secondReview.reviewer.requestId = "req_human_review_0002";
  secondReview.reviewerRoleId = "role_safety_reviewer";
  return {
    declarations: [firstDeclaration, secondDeclaration],
    protocol,
    reviews: [firstReview, secondReview],
  };
}

const evaluatedAt = "2026-09-02T03:30:00.000Z";

describe("accountable human review quorum", () => {
  it("satisfies quorum only with exact evidence, required roles, and distinct verified groups", () => {
    const { declarations, protocol, reviews } = records();
    expect(evaluateHumanReviewQuorum(protocol, reviews, declarations, evaluatedAt)).toEqual({
      independenceGroupIds: ["hig_domain_lab", "hig_safety_lab"],
      status: "satisfied",
      supportingReviewIds: ["hrr_domain_reviewer", "hrr_safety_reviewer"],
    });
  });

  it("fails on quorum, role, and independence-group shortfall", () => {
    const { declarations, protocol, reviews } = records();
    expect(
      evaluateHumanReviewQuorum(protocol, reviews.slice(0, 1), declarations, evaluatedAt),
    ).toEqual({
      reasons: ["independence_group_shortfall", "quorum_shortfall", "role_requirement_shortfall"],
      status: "unsatisfied",
    });
  });

  it("preserves opposing, change-request, and escalation actions as blocking evidence", () => {
    const { declarations, protocol, reviews } = records();
    const opposing = structuredClone(reviews);
    const first = opposing[0];
    const second = opposing[1];
    if (!first || !second) throw new Error("Expected reviews");
    first.action = "oppose";
    second.action = "require_escalation";
    expect(evaluateHumanReviewQuorum(protocol, opposing, declarations, evaluatedAt)).toEqual({
      reasons: [
        "opposing_review",
        "quorum_shortfall",
        "role_requirement_shortfall",
        "unresolved_escalation",
      ],
      status: "unsatisfied",
    });
  });

  it("rejects evidence, protocol, expiry, and time-budget mismatches", () => {
    const { declarations, protocol, reviews } = records();
    const invalid = structuredClone(reviews);
    const first = invalid[0];
    if (!first) throw new Error("Expected review");
    first.reviewedArtifacts = first.reviewedArtifacts.slice(1);
    first.protocol.definitionSha256 = "5".repeat(64);
    first.completedAt = "2026-09-02T05:00:02.000Z";
    expect(
      evaluateHumanReviewQuorum(protocol, invalid, declarations, "2026-09-04T03:30:00.000Z"),
    ).toEqual({
      reasons: ["evidence_mismatch", "protocol_mismatch", "review_expired", "review_time_exceeded"],
      status: "unsatisfied",
    });
  });

  it("rejects unverified, stale, conflicted, or mismatched reviewer independence", () => {
    const { declarations, protocol, reviews } = records();
    const invalidDeclarations = structuredClone(declarations);
    const first = invalidDeclarations[0];
    const second = invalidDeclarations[1];
    if (!first || !second) throw new Error("Expected declarations");
    first.status = "unverifiable";
    first.statusReasons = ["Affiliation could not be verified"];
    second.validUntil = evaluatedAt;
    second.relationships = ["criterion author"];
    expect(evaluateHumanReviewQuorum(protocol, reviews, invalidDeclarations, evaluatedAt)).toEqual({
      reasons: ["conflicted_reviewer", "independence_not_current", "independence_not_verified"],
      status: "unsatisfied",
    });
  });

  it("accepts a valid same-reviewer supersession while retaining the original record", () => {
    const { declarations, protocol, reviews } = records();
    const original = reviews[0];
    if (!original) throw new Error("Expected original review");
    const correction = structuredClone(original);
    correction.definitionSha256 = "6".repeat(64);
    correction.reviewId = "hrr_domain_reviewer_correction";
    correction.supersedes = {
      definitionSha256: original.definitionSha256,
      reviewId: original.reviewId,
    };
    const result = evaluateHumanReviewQuorum(
      protocol,
      [...reviews, correction],
      declarations,
      evaluatedAt,
    );
    expect(result).toEqual({
      independenceGroupIds: ["hig_domain_lab", "hig_safety_lab"],
      status: "satisfied",
      supportingReviewIds: ["hrr_domain_reviewer_correction", "hrr_safety_reviewer"],
    });
  });

  it("rejects duplicate reviewers, dangling supersession, and malformed inputs", () => {
    const { declarations, protocol, reviews } = records();
    const duplicate = structuredClone(reviews);
    const second = duplicate[1];
    if (!second) throw new Error("Expected second review");
    second.reviewer.principalId = duplicate[0]?.reviewer.principalId ?? "usr_missing";
    expect(evaluateHumanReviewQuorum(protocol, duplicate, declarations, evaluatedAt)).toEqual({
      reasons: [
        "duplicate_reviewer",
        "independence_group_shortfall",
        "independence_not_verified",
      ],
      status: "unsatisfied",
    });

    const dangling = structuredClone(reviews);
    const first = dangling[0];
    if (!first) throw new Error("Expected first review");
    first.supersedes = { definitionSha256: "7".repeat(64), reviewId: "hrr_missing" };
    expect(evaluateHumanReviewQuorum(protocol, dangling, declarations, evaluatedAt)).toEqual({
      reasons: ["invalid_supersession"],
      status: "unsatisfied",
    });

    expect(() => evaluateHumanReviewQuorum({}, reviews, declarations, evaluatedAt)).toThrow(
      InvalidHumanReviewQuorumInputError,
    );
    expect(() => evaluateHumanReviewQuorum(protocol, [{}], declarations, evaluatedAt)).toThrow(
      InvalidHumanReviewQuorumInputError,
    );
    expect(() => evaluateHumanReviewQuorum(protocol, reviews, [{}], evaluatedAt)).toThrow(
      InvalidHumanReviewQuorumInputError,
    );
    expect(() => evaluateHumanReviewQuorum(protocol, reviews, declarations, "later")).toThrow(
      InvalidHumanReviewQuorumInputError,
    );
  });
});
