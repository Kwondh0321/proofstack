import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  MAX_RELEASE_DECISION_APPROVAL_READS,
  PolicyApprovalRequirementSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  type ReleaseApproval,
  type ReleaseApprovalReference,
  ReleaseApprovalReferenceSchema,
  ReleaseApprovalRevocationSchema,
  ReleaseApprovalSchema,
  type ReleaseApprovalSubject,
  ReleaseApprovalSubjectSchema,
  type ReleaseDecisionControlObservation,
  ReleaseDecisionControlObservationSchema,
  type ReleaseDecisionCredentialObservation,
  type ReleaseDecisionIdentityObservation,
  type ReleaseDecisionIdentityReference,
  ReleaseDecisionIdentityReferenceSchema,
  ReleaseReviewerAuthorityLifecycleEventSchema,
  ReleaseReviewerAuthoritySchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  type CapturedExceptionControls,
  inspectCapturedExceptionControlObservations,
} from "./captured-exception-controls.js";
import {
  type CapturedReleaseReviewContext,
  type CapturedReleaseReviewerEligibility,
  inspectCapturedReleaseReviewerEligibility,
  validateCapturedReleaseReviewContext,
} from "./captured-release-reviewer-eligibility.js";
import { matchDistinctReviewerGroups } from "./match-reviewer-groups.js";
import {
  releaseApprovalReference,
  validateReleaseApprovalRecord,
} from "./release-authority-record-validation.js";
import {
  type ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";
import type { ReleaseReviewerCensus } from "./release-reviewer-census.js";

export interface CapturedNormalApprovalActor {
  readonly approval: ReleaseApprovalReference;
  readonly identity: ReleaseDecisionIdentityReference;
  readonly grant: ReleaseDecisionIdentityObservation;
  readonly credential: ReleaseDecisionCredentialObservation;
  readonly authorityCensus: ReleaseReviewerCensus;
}
export type CapturedNormalApprovalState =
  | "unavailable"
  | "insufficient"
  | "conditions_unresolved"
  | "conflicted"
  | "opposed"
  | "escalated"
  | "matched";
export type CapturedNormalApprovalRowState =
  | "revoked"
  | "superseded"
  | "expired"
  | "unavailable"
  | "ineligible"
  | "conflicted"
  | "conditions_unresolved"
  | "approve"
  | "oppose"
  | "escalate"
  | "abstain";
export interface CapturedNormalApprovalQuorum {
  readonly state: CapturedNormalApprovalState;
  readonly supportingApprovals: readonly ReleaseApprovalReference[];
  readonly witnesses: readonly {
    readonly approval: ReleaseApprovalReference;
    readonly principalId: string;
    readonly groupId: string;
    readonly independentHuman: boolean;
    readonly assurance: "operator_verified" | "synthetic_reference";
  }[];
  readonly observations: readonly {
    readonly approval: ReleaseApprovalReference;
    readonly state: CapturedNormalApprovalRowState;
  }[];
  readonly expiresAt: string | null;
}
export class InvalidCapturedNormalApprovalError extends Error {
  readonly code = "captured_normal_approval_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid complete captured normal approval census", options);
    this.name = "InvalidCapturedNormalApprovalError";
  }
}
function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}
function exactKeys(value: unknown, keys: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new InvalidCapturedNormalApprovalError();
}

/**
 * Server-owned captured review sources. The fixed owning composition derives the original full
 * subject and installed requirement. These public preimages do not authenticate or retain guards.
 */
export interface CapturedReleaseReviewQuorumInput {
  readonly subject: ReleaseApprovalSubject;
  readonly context: CapturedReleaseReviewContext;
  readonly census: {
    readonly state: "complete" | "unavailable" | "invalid";
    readonly records: readonly unknown[];
    readonly revocations: readonly unknown[];
  };
  readonly actors: readonly CapturedNormalApprovalActor[];
  readonly capturedAt: string;
  readonly budget: ReleaseDecisionVerificationBudget;
}

export interface CapturedReleaseReviewQuorum extends CapturedNormalApprovalQuorum {
  readonly controls: readonly {
    readonly approval: ReleaseApprovalReference;
    readonly inspection: CapturedExceptionControls;
  }[];
}

export function resolveCapturedNormalApprovalQuorum(
  input: CapturedReleaseReviewQuorumInput,
): CapturedNormalApprovalQuorum {
  const { controls: _controls, ...quorum } = resolveCapturedReleaseReviewQuorum(
    input,
    "normal_approval",
    [],
  );
  return quorum;
}

/** Internal fixed engine. Public application input cannot select the operation or validators. */
export function resolveCapturedReleaseReviewQuorum(
  input: CapturedReleaseReviewQuorumInput,
  kind: "normal_approval" | "rule_exception",
  controlInput: readonly unknown[],
): CapturedReleaseReviewQuorum {
  try {
    const subject = ReleaseApprovalSubjectSchema.parse(input.subject);
    const scope = EvidenceScopeSchema.parse(subject.scope);
    const at = PolicyEvaluationTimeSchema.parse(input.capturedAt);
    const cut = policyEvaluationTimestampOrderKey(at);
    const context = validateCapturedReleaseReviewContext(input.context);
    const requirement = PolicyApprovalRequirementSchema.parse(context.requirement);
    if (context.purpose !== kind || !["normal_approval", "rule_exception"].includes(kind))
      throw new InvalidCapturedNormalApprovalError();
    if (
      !Array.isArray(controlInput) ||
      controlInput.length > MAX_RELEASE_DECISION_APPROVAL_READS * 16 ||
      (kind === "normal_approval" && controlInput.length !== 0)
    )
      throw new InvalidCapturedNormalApprovalError();
    exactKeys(input.census, ["state", "records", "revocations"]);
    const census = structuredClone(input.census);
    if (
      !["complete", "unavailable", "invalid"].includes(census.state) ||
      !Array.isArray(census.records) ||
      !Array.isArray(census.revocations) ||
      !Array.isArray(input.actors) ||
      [census.records, census.revocations, input.actors].some(
        (rows) => rows.length > MAX_RELEASE_DECISION_APPROVAL_READS,
      )
    )
      throw new InvalidCapturedNormalApprovalError();
    const records: ReleaseApproval[] = [];
    for (const raw of census.records) {
      input.budget.observe(raw, "approval");
      const parsed = ReleaseApprovalSchema.parse(raw);
      const record = validateReleaseApprovalRecord({
        expected: { scope, reference: releaseApprovalReference(parsed) },
        record: parsed,
      });
      if (
        policyEvaluationTimestampOrderKey(record.recordedAt) > cut ||
        record.kind !== kind ||
        !same(record.subject, subject)
      )
        throw new InvalidCapturedNormalApprovalError();
      records.push(record);
    }
    records.sort((a, b) =>
      a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0,
    );
    const byId = new Map(records.map((record) => [record.approvalId, record]));
    let conflict = byId.size !== records.length;
    let unavailable = census.state !== "complete";
    const revoked = new Set<string>();
    const eventIds = new Set<string>();
    for (const raw of census.revocations) {
      input.budget.observe(raw);
      const event = ReleaseApprovalRevocationSchema.parse(raw);
      if (!same(scope, event.scope) || policyEvaluationTimestampOrderKey(event.occurredAt) > cut)
        throw new InvalidCapturedNormalApprovalError();
      const record = byId.get(event.approval.approvalId);
      if (eventIds.has(event.eventId) || revoked.has(event.approval.approvalId)) conflict = true;
      eventIds.add(event.eventId);
      revoked.add(event.approval.approvalId);
      if (!record) {
        unavailable = true;
        continue;
      }
      if (
        !same(releaseApprovalReference(record), event.approval) ||
        record.reviewer.principalId !== event.reviewer.principalId ||
        policyEvaluationTimestampOrderKey(event.occurredAt) <
          policyEvaluationTimestampOrderKey(record.recordedAt)
      )
        throw new InvalidCapturedNormalApprovalError();
    }
    const superseded = new Set<string>();
    for (const record of records) {
      if (!record.supersedes) continue;
      const previous = byId.get(record.supersedes.approvalId);
      if (superseded.has(record.supersedes.approvalId)) conflict = true;
      superseded.add(record.supersedes.approvalId);
      if (!previous) {
        unavailable = true;
        continue;
      }
      if (
        !same(releaseApprovalReference(previous), record.supersedes) ||
        previous.reviewer.principalId !== record.reviewer.principalId ||
        previous.kind !== record.kind ||
        !same(previous.subject, record.subject) ||
        policyEvaluationTimestampOrderKey(previous.recordedAt) >
          policyEvaluationTimestampOrderKey(record.recordedAt)
      )
        throw new InvalidCapturedNormalApprovalError();
    }
    const completed = new Set<string>();
    for (const record of records) {
      const visiting = new Set<string>();
      let current: ReleaseApproval | undefined = record;
      while (current && !completed.has(current.approvalId)) {
        if (visiting.has(current.approvalId)) {
          conflict = true;
          break;
        }
        visiting.add(current.approvalId);
        current = current.supersedes ? byId.get(current.supersedes.approvalId) : undefined;
      }
      for (const id of visiting) completed.add(id);
    }
    const controls: CapturedReleaseReviewQuorum["controls"][number][] = [];
    const controlByApproval = new Map<string, CapturedExceptionControls>();
    if (kind === "rule_exception") {
      const grouped = new Map<string, ReleaseDecisionControlObservation[]>();
      const catalogs = new Map<string, string>();
      for (const raw of controlInput) {
        input.budget.observe(raw);
        const source = ReleaseDecisionControlObservationSchema.parse(raw);
        const record = byId.get(source.approval.approvalId);
        if (!record) throw new InvalidCapturedNormalApprovalError();
        if (source.content.state === "not_inspected") {
          if (source.content.reason === "action_not_approval" && record.action === "approve")
            throw new InvalidCapturedNormalApprovalError();
          if (
            source.content.reason === "approval_inactive" &&
            !revoked.has(record.approvalId) &&
            !superseded.has(record.approvalId) &&
            policyEvaluationTimestampOrderKey(record.expiresAt) > cut
          )
            throw new InvalidCapturedNormalApprovalError();
        }
        const rows = grouped.get(record.approvalId) ?? [];
        rows.push(source);
        grouped.set(record.approvalId, rows);
        const hash = serializeEvaluationCanonicalJson(source.underGuards);
        const prior = catalogs.get(source.reference.artifactId);
        if (prior !== undefined && prior !== hash) unavailable = true;
        catalogs.set(source.reference.artifactId, hash);
      }
      for (const record of records) {
        // The census admitted the exact approval and whole control rows before grouping. The fixed
        // pass retains canonical validation and admits content/catalog projections on that meter.
        const inspection = inspectCapturedExceptionControlObservations({
          approval: record,
          observations: grouped.get(record.approvalId) ?? [],
          capturedAt: at,
          budget: input.budget,
        });
        if (inspection.observations.some((source) => source.state === "missing"))
          unavailable = true;
        controls.push({ approval: releaseApprovalReference(record), inspection });
        controlByApproval.set(record.approvalId, inspection);
      }
    }
    const actors = new Map<string, CapturedReleaseReviewerEligibility>();
    const preimages = new Map<string, string>();
    const retainPreimage = (key: readonly string[], value: unknown) => {
      const id = serializeEvaluationCanonicalJson(key);
      const hash = createHash("sha256")
        .update(serializeEvaluationCanonicalJson(value))
        .digest("hex");
      const previous = preimages.get(id);
      if (previous !== undefined && previous !== hash) unavailable = true;
      preimages.set(id, hash);
    };
    for (const source of structuredClone(input.actors)) {
      exactKeys(source, ["approval", "identity", "grant", "credential", "authorityCensus"]);
      const reference = ReleaseApprovalReferenceSchema.parse(source.approval);
      const identity = ReleaseDecisionIdentityReferenceSchema.parse(source.identity);
      if (identity.kind !== "oidc_binding") throw new InvalidCapturedNormalApprovalError();
      input.budget.observe({ approval: reference, identity });
      const record = byId.get(reference.approvalId);
      if (!record || !same(releaseApprovalReference(record), reference))
        throw new InvalidCapturedNormalApprovalError();
      if (actors.has(reference.approvalId)) conflict = true;
      const eligibility = inspectCapturedReleaseReviewerEligibility({
        scope,
        reference: record.authority,
        census: source.authorityCensus,
        receipt: record.reviewer,
        identity,
        grant: source.grant,
        credential: source.credential,
        context,
        recordedAt: record.recordedAt,
        capturedAt: at,
        budget: input.budget,
      });
      retainPreimage(["identity", identity.kind, identity.bindingId], source.grant);
      retainPreimage(
        ["credential", source.credential.reference.kind, source.credential.reference.credentialId],
        source.credential,
      );
      retainPreimage(
        [
          "authority_census",
          record.authority.installationId,
          record.authority.gateTargetId,
          record.authority.reviewerPrincipalId,
          record.authority.authorityId,
        ],
        {
          state: source.authorityCensus.state,
          records: source.authorityCensus.records.map(serializeEvaluationCanonicalJson).sort(),
          lifecycle: source.authorityCensus.lifecycle.map(serializeEvaluationCanonicalJson).sort(),
        },
      );
      for (const raw of source.authorityCensus.records) {
        const authority = ReleaseReviewerAuthoritySchema.parse(raw);
        retainPreimage(["reviewer_authority", authority.authorityVersionId], authority);
      }
      for (const raw of source.authorityCensus.lifecycle) {
        const event = ReleaseReviewerAuthorityLifecycleEventSchema.parse(raw);
        retainPreimage(["reviewer_event", event.eventId], event);
      }
      actors.set(reference.approvalId, eligibility);
    }
    if (actors.size !== byId.size) unavailable = true;
    const observations: {
      approval: ReleaseApprovalReference;
      state: CapturedNormalApprovalRowState;
    }[] = [];
    const active = new Map<
      string,
      {
        record: ReleaseApproval;
        reviewer: Extract<CapturedReleaseReviewerEligibility, { state: "eligible" }>;
      }
    >();
    const activePrincipals = new Set<string>();
    let opposed = false,
      escalated = false,
      conditional = false;
    for (const record of records) {
      const reference = releaseApprovalReference(record);
      let state: CapturedNormalApprovalRowState;
      const reviewer = actors.get(record.approvalId);
      if (revoked.has(record.approvalId)) state = "revoked";
      else if (superseded.has(record.approvalId)) state = "superseded";
      else if (policyEvaluationTimestampOrderKey(record.expiresAt) <= cut) state = "expired";
      else if (!reviewer || reviewer.state === "unavailable") {
        state = "unavailable";
        unavailable = true;
      } else if (reviewer.state === "ineligible") state = "ineligible";
      else {
        if (activePrincipals.has(reviewer.principalId)) conflict = true;
        activePrincipals.add(reviewer.principalId);
        if (record.declaredConflicts.length > 0) {
          state = "conflicted";
          conflict = true;
        } else if (record.action === "oppose") {
          state = "oppose";
          opposed = true;
        } else if (record.action === "escalate") {
          state = "escalate";
          escalated = true;
        } else if (record.action === "abstain") state = "abstain";
        else if (record.conditions.length > 0) {
          state = "conditions_unresolved";
          conditional = true;
        } else if (
          kind === "rule_exception" &&
          controlByApproval.get(record.approvalId)?.state !== "retained"
        ) {
          state = "unavailable";
          unavailable = true;
        } else {
          state = "approve";
          active.set(reviewer.principalId, { record, reviewer });
        }
      }
      observations.push({ approval: reference, state });
    }
    const empty = (state: CapturedNormalApprovalState): CapturedReleaseReviewQuorum => ({
      state,
      supportingApprovals: [],
      witnesses: [],
      observations,
      expiresAt: null,
      controls,
    });
    if (conflict) return empty("conflicted");
    if (unavailable) return empty("unavailable");
    if (opposed) return empty("opposed");
    if (escalated) return empty("escalated");
    if (conditional) return empty("conditions_unresolved");
    const assignment = matchDistinctReviewerGroups({
      groupIds: requirement.independenceGroupIds,
      humanGroupIds: requirement.humanReviewerGroupIds,
      quorum: requirement.quorum,
      reviewers: [...active.values()].map(({ reviewer }) => ({
        principalId: reviewer.principalId,
        groupIds: reviewer.groupIds,
        human: reviewer.independentHuman,
      })),
    });
    if (assignment.status !== "matched") return empty("insufficient");
    let expiresAt: string | null = null;
    const witnesses = assignment.matched.map((match) => {
      const source = active.get(match.principalId);
      if (!source) throw new InvalidCapturedNormalApprovalError();
      const controlExpiry = controlByApproval.get(source.record.approvalId)?.expiresAt;
      for (const limit of [
        source.record.expiresAt,
        source.reviewer.authorityExpiresAt,
        ...(controlExpiry ? [controlExpiry] : []),
      ])
        if (
          expiresAt === null ||
          policyEvaluationTimestampOrderKey(limit) < policyEvaluationTimestampOrderKey(expiresAt)
        )
          expiresAt = limit;
      return {
        approval: releaseApprovalReference(source.record),
        principalId: match.principalId,
        groupId: match.groupId,
        independentHuman: source.reviewer.independentHuman,
        assurance: source.reviewer.assurance,
      };
    });
    const supportingApprovals = witnesses
      .map(({ approval }) => approval)
      .sort((a, b) => (a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0));
    return { state: "matched", witnesses, supportingApprovals, observations, expiresAt, controls };
  } catch (cause) {
    if (
      cause instanceof InvalidCapturedNormalApprovalError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidCapturedNormalApprovalError({ cause });
  }
}
