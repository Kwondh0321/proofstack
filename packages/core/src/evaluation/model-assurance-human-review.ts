import {
  type HumanReviewerIndependence,
  HumanReviewerIndependenceSchema,
  type HumanReviewProtocol,
  HumanReviewProtocolSchema,
  type HumanReviewRecord,
  HumanReviewRecordSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";

export type HumanReviewQuorumReason =
  | "conflicted_reviewer"
  | "duplicate_reviewer"
  | "evidence_mismatch"
  | "independence_group_shortfall"
  | "independence_not_current"
  | "independence_not_verified"
  | "invalid_supersession"
  | "opposing_review"
  | "protocol_mismatch"
  | "protocol_not_current"
  | "quorum_shortfall"
  | "review_expired"
  | "review_not_complete"
  | "review_time_exceeded"
  | "role_requirement_shortfall"
  | "scope_mismatch"
  | "unresolved_escalation";

export type HumanReviewQuorum =
  | {
      readonly independenceGroupIds: readonly string[];
      readonly status: "satisfied";
      readonly supportingReviewIds: readonly string[];
    }
  | {
      readonly reasons: readonly HumanReviewQuorumReason[];
      readonly status: "unsatisfied";
    };

export class InvalidHumanReviewQuorumInputError extends Error {
  readonly code = "invalid_human_review_quorum_input";

  constructor(
    readonly input: "at" | "independence" | "protocol" | "review",
    options?: ErrorOptions,
  ) {
    super(`The human-review quorum ${input} does not satisfy its bounded contract`, options);
    this.name = "InvalidHumanReviewQuorumInputError";
  }
}

function sameScope(
  left: {
    readonly scope: {
      readonly environmentId: string;
      readonly projectId: string;
      readonly tenantId: string;
    };
  },
  right: {
    readonly scope: {
      readonly environmentId: string;
      readonly projectId: string;
      readonly tenantId: string;
    };
  },
): boolean {
  return (
    left.scope.tenantId === right.scope.tenantId &&
    left.scope.projectId === right.scope.projectId &&
    left.scope.environmentId === right.scope.environmentId
  );
}

function exactArtifactKey(reference: {
  readonly artifactId: string;
  readonly sha256: string;
}): string {
  return `${reference.artifactId}:${reference.sha256}`;
}

function parseAt(input: unknown): string {
  const parsed = UtcMillisecondTimestampSchema.safeParse(input);
  if (!parsed.success) throw new InvalidHumanReviewQuorumInputError("at", { cause: parsed.error });
  return parsed.data;
}

function parseProtocol(input: unknown): HumanReviewProtocol {
  const parsed = HumanReviewProtocolSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidHumanReviewQuorumInputError("protocol", { cause: parsed.error });
  }
  return parsed.data;
}

function parseReviews(inputs: readonly unknown[]): HumanReviewRecord[] {
  return inputs.map((input) => {
    const parsed = HumanReviewRecordSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidHumanReviewQuorumInputError("review", { cause: parsed.error });
    }
    return parsed.data;
  });
}

function parseDeclarations(inputs: readonly unknown[]): HumanReviewerIndependence[] {
  return inputs.map((input) => {
    const parsed = HumanReviewerIndependenceSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidHumanReviewQuorumInputError("independence", { cause: parsed.error });
    }
    return parsed.data;
  });
}

function referenceMatchesProtocol(
  review: HumanReviewRecord,
  protocol: HumanReviewProtocol,
): boolean {
  return (
    review.protocol.protocolId === protocol.protocolId &&
    review.protocol.protocolVersionId === protocol.protocolVersionId &&
    review.protocol.definitionSha256 === protocol.definitionSha256
  );
}

function activeReviews(
  reviews: readonly HumanReviewRecord[],
  reasons: Set<HumanReviewQuorumReason>,
): HumanReviewRecord[] {
  const byId = new Map(reviews.map((review) => [review.reviewId, review]));
  if (byId.size !== reviews.length) reasons.add("invalid_supersession");
  const superseded = new Set<string>();
  for (const review of reviews) {
    if (!review.supersedes) continue;
    const predecessor = byId.get(review.supersedes.reviewId);
    if (
      !predecessor ||
      predecessor.definitionSha256 !== review.supersedes.definitionSha256 ||
      predecessor.reviewer.principalId !== review.reviewer.principalId ||
      predecessor.protocol.definitionSha256 !== review.protocol.definitionSha256
    ) {
      reasons.add("invalid_supersession");
      continue;
    }
    superseded.add(predecessor.reviewId);
  }
  return reviews.filter(({ reviewId }) => !superseded.has(reviewId));
}

/** Reconstructs accountable human-review quorum from exact records and current validity. */
export function evaluateHumanReviewQuorum(
  protocolInput: unknown,
  reviewInputs: readonly unknown[],
  independenceInputs: readonly unknown[],
  atInput: unknown,
): HumanReviewQuorum {
  const protocol = parseProtocol(protocolInput);
  const reviews = parseReviews(reviewInputs);
  const declarations = parseDeclarations(independenceInputs);
  const at = parseAt(atInput);
  const instant = Date.parse(at);
  const reasons = new Set<HumanReviewQuorumReason>();
  if (!(Date.parse(protocol.validFrom) <= instant && instant < Date.parse(protocol.validUntil))) {
    reasons.add("protocol_not_current");
  }

  const declarationById = new Map(declarations.map((value) => [value.declarationId, value]));
  if (declarationById.size !== declarations.length) {
    throw new InvalidHumanReviewQuorumInputError("independence");
  }
  const active = activeReviews(reviews, reasons);
  const principals = active.map(({ reviewer }) => reviewer.principalId);
  if (new Set(principals).size !== principals.length) reasons.add("duplicate_reviewer");

  const requiredEvidence = new Set(protocol.claim.evidenceBundle.map(exactArtifactKey));
  const validSupportingReviews: HumanReviewRecord[] = [];
  const groupIds = new Set<string>();
  for (const review of active) {
    if (!sameScope(review, protocol)) reasons.add("scope_mismatch");
    if (!referenceMatchesProtocol(review, protocol)) reasons.add("protocol_mismatch");
    if (Date.parse(review.completedAt) > instant) reasons.add("review_not_complete");
    if (instant >= Date.parse(review.expiresAt)) reasons.add("review_expired");
    if (
      Date.parse(review.completedAt) - Date.parse(review.startedAt) >
      protocol.timePolicy.maximumReviewMilliseconds
    ) {
      reasons.add("review_time_exceeded");
    }
    const reviewed = new Set(review.reviewedArtifacts.map(exactArtifactKey));
    if ([...requiredEvidence].some((reference) => !reviewed.has(reference))) {
      reasons.add("evidence_mismatch");
    }
    const declaration = declarationById.get(review.independenceDeclaration.declarationId);
    if (
      !declaration ||
      declaration.definitionSha256 !== review.independenceDeclaration.definitionSha256 ||
      declaration.reviewerPrincipalId !== review.reviewer.principalId
    ) {
      reasons.add("independence_not_verified");
    } else {
      if (!sameScope(declaration, protocol)) reasons.add("scope_mismatch");
      if (declaration.status !== "verified") reasons.add("independence_not_verified");
      if (
        !(
          Date.parse(declaration.validFrom) <= instant &&
          instant < Date.parse(declaration.validUntil)
        )
      ) {
        reasons.add("independence_not_current");
      }
      const relationships = new Set([...review.relationships, ...declaration.relationships]);
      if (
        review.conflicts.length > 0 ||
        declaration.conflicts.length > 0 ||
        protocol.conflictPolicy.forbiddenRelationships.some((value) => relationships.has(value))
      ) {
        reasons.add("conflicted_reviewer");
      }
      for (const groupId of declaration.independenceGroupIds) groupIds.add(groupId);
    }
    if (review.action === "oppose" || review.action === "request_changes") {
      reasons.add("opposing_review");
    }
    if (review.action === "require_escalation") reasons.add("unresolved_escalation");
    if (review.action === "support") validSupportingReviews.push(review);
  }

  if (validSupportingReviews.length < protocol.quorum.minimumCompletedReviews) {
    reasons.add("quorum_shortfall");
  }
  for (const role of protocol.reviewerRoles) {
    if (
      validSupportingReviews.filter(({ reviewerRoleId }) => reviewerRoleId === role.roleId).length <
      role.minimumReviewers
    ) {
      reasons.add("role_requirement_shortfall");
    }
  }
  if (groupIds.size < protocol.independenceRequirements.minimumIndependentGroups) {
    reasons.add("independence_group_shortfall");
  }
  return reasons.size > 0
    ? { reasons: [...reasons].sort(), status: "unsatisfied" }
    : {
        independenceGroupIds: [...groupIds].sort(),
        status: "satisfied",
        supportingReviewIds: validSupportingReviews.map(({ reviewId }) => reviewId).sort(),
      };
}
