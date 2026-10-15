import {
  EvidenceScopeSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  ReleaseReviewerAuthorityLifecycleEventSchema,
  ReleaseReviewerAuthorityReferenceSchema,
  ReleaseReviewerAuthoritySchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseReviewerAuthority,
  type ReleaseReviewerAuthorityLifecycleEvent,
  type ReleaseReviewerAuthorityReference,
} from "@proofstack/contracts";
import {
  releaseReviewerAuthorityReference,
  validateReleaseReviewerAuthorityRecord,
} from "./release-authority-record-validation.js";
import {
  type ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

export interface ReleaseReviewerCensus {
  readonly state: "complete" | "unavailable" | "invalid";
  readonly records: readonly unknown[];
  readonly lifecycle: readonly unknown[];
}
export type CapturedReleaseReviewerState =
  | "current"
  | "unavailable"
  | "not_effective"
  | "expired"
  | "revoked"
  | "superseded"
  | "conflicting";
export interface CapturedReleaseReviewerCensus {
  readonly state: CapturedReleaseReviewerState;
  readonly original: ReleaseReviewerAuthority | null;
  readonly active: readonly ReleaseReviewerAuthority[];
  readonly records: readonly ReleaseReviewerAuthority[];
  readonly lifecycle: readonly ReleaseReviewerAuthorityLifecycleEvent[];
}
export class InvalidReleaseReviewerCensusError extends Error {
  readonly code = "release_reviewer_census_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid complete installation target reviewer authority census", options);
    this.name = "InvalidReleaseReviewerCensusError";
  }
}
function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}

/**
 * Pure captured-data validation, never authentication or a retained publication guard.
 * The owning port must enumerate the complete installation/gate/reviewer target, verify its immutable
 * logical-root binding and charge every read. A caller-supplied version list is not that port.
 */
export function resolveCapturedReleaseReviewerCensus(input: {
  readonly scope: EvidenceScope;
  readonly reference: ReleaseReviewerAuthorityReference;
  readonly capturedAt: string;
  readonly census: ReleaseReviewerCensus;
  readonly budget: ReleaseDecisionVerificationBudget;
}): CapturedReleaseReviewerCensus {
  try {
    const scope = EvidenceScopeSchema.parse(input.scope);
    const reference = ReleaseReviewerAuthorityReferenceSchema.parse(input.reference);
    const cut = policyEvaluationTimestampOrderKey(
      PolicyEvaluationTimeSchema.parse(input.capturedAt),
    );
    const census = input.census;
    if (
      !census ||
      typeof census !== "object" ||
      Array.isArray(census) ||
      Object.keys(census).length !== 3 ||
      !["state", "records", "lifecycle"].every((key) => Object.hasOwn(census, key)) ||
      !["complete", "unavailable", "invalid"].includes(census.state) ||
      !Array.isArray(census.records) ||
      !Array.isArray(census.lifecycle)
    )
      throw new InvalidReleaseReviewerCensusError();
    const records: ReleaseReviewerAuthority[] = [];
    const events: ReleaseReviewerAuthorityLifecycleEvent[] = [];
    for (const raw of census.records) {
      input.budget.observe(raw);
      const parsed = ReleaseReviewerAuthoritySchema.parse(raw);
      const record = validateReleaseReviewerAuthorityRecord({
        expected: { scope, reference: releaseReviewerAuthorityReference(parsed) },
        record: parsed,
      });
      if (
        record.authorityId !== reference.authorityId ||
        record.installationId !== reference.installationId ||
        record.gateTargetId !== reference.gateTargetId ||
        record.reviewerPrincipalId !== reference.reviewerPrincipalId ||
        policyEvaluationTimestampOrderKey(record.publishedAt) > cut
      )
        throw new InvalidReleaseReviewerCensusError();
      records.push(record);
    }
    for (const raw of census.lifecycle) {
      input.budget.observe(raw);
      const event = ReleaseReviewerAuthorityLifecycleEventSchema.parse(raw);
      if (
        !same(scope, event.scope) ||
        event.authority.authorityId !== reference.authorityId ||
        event.authority.installationId !== reference.installationId ||
        event.authority.gateTargetId !== reference.gateTargetId ||
        event.authority.reviewerPrincipalId !== reference.reviewerPrincipalId ||
        policyEvaluationTimestampOrderKey(event.occurredAt) > cut
      )
        throw new InvalidReleaseReviewerCensusError();
      events.push(event);
    }
    records.sort((left, right) =>
      left.authorityVersionId < right.authorityVersionId
        ? -1
        : left.authorityVersionId > right.authorityVersionId
          ? 1
          : 0,
    );
    events.sort((left, right) =>
      left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0,
    );
    const versions = new Map(records.map((record) => [record.authorityVersionId, record]));
    const original = versions.get(reference.authorityVersionId) ?? null;
    const result = (
      state: CapturedReleaseReviewerState,
      active: ReleaseReviewerAuthority[] = [],
    ): CapturedReleaseReviewerCensus => ({
      state,
      original,
      active,
      records,
      lifecycle: events,
    });
    if (original && !same(releaseReviewerAuthorityReference(original), reference))
      throw new InvalidReleaseReviewerCensusError();
    if (
      versions.size !== records.length ||
      new Set(events.map(({ eventId }) => eventId)).size !== events.length
    )
      return result("conflicting");
    const terminals = new Map<string, ReleaseReviewerAuthorityLifecycleEvent>();
    let incomplete = census.state !== "complete" || original === null;
    for (const event of events) {
      const target = versions.get(event.authority.authorityVersionId);
      if (terminals.has(event.authority.authorityVersionId)) return result("conflicting");
      terminals.set(event.authority.authorityVersionId, event);
      if (!target) {
        incomplete = true;
        continue;
      }
      if (
        !same(releaseReviewerAuthorityReference(target), event.authority) ||
        policyEvaluationTimestampOrderKey(event.occurredAt) <
          policyEvaluationTimestampOrderKey(target.publishedAt)
      )
        throw new InvalidReleaseReviewerCensusError();
      if (event.kind === "superseded") {
        const successor = versions.get(event.successor.authorityVersionId);
        if (!successor) {
          incomplete = true;
          continue;
        }
        if (
          !same(releaseReviewerAuthorityReference(successor), event.successor) ||
          !same(successor.predecessor, event.authority) ||
          policyEvaluationTimestampOrderKey(successor.publishedAt) >
            policyEvaluationTimestampOrderKey(event.occurredAt)
        )
          throw new InvalidReleaseReviewerCensusError();
      }
    }
    const completed = new Set<string>();
    for (const record of records) {
      const visited = new Set<string>();
      let current = record;
      while (!completed.has(current.authorityVersionId)) {
        if (visited.has(current.authorityVersionId)) return result("conflicting");
        visited.add(current.authorityVersionId);
        if (!current.predecessor) break;
        const parent = versions.get(current.predecessor.authorityVersionId);
        if (!parent) {
          incomplete = true;
          break;
        }
        if (
          !same(releaseReviewerAuthorityReference(parent), current.predecessor) ||
          policyEvaluationTimestampOrderKey(parent.publishedAt) >
            policyEvaluationTimestampOrderKey(current.publishedAt)
        )
          throw new InvalidReleaseReviewerCensusError();
        current = parent;
      }
      for (const id of visited) completed.add(id);
    }
    if (incomplete || !original) return result("unavailable");
    const active = records.filter(
      (record) =>
        !terminals.has(record.authorityVersionId) &&
        policyEvaluationTimestampOrderKey(record.effectiveAt) <= cut &&
        cut < policyEvaluationTimestampOrderKey(record.expiresAt),
    );
    if (active.length > 1) return result("conflicting", active);
    const terminal = terminals.get(original.authorityVersionId);
    if (terminal) return result(terminal.kind, active);
    if (cut < policyEvaluationTimestampOrderKey(original.effectiveAt))
      return result("not_effective", active);
    if (cut >= policyEvaluationTimestampOrderKey(original.expiresAt))
      return result("expired", active);
    return result("current", active);
  } catch (cause) {
    if (
      cause instanceof InvalidReleaseReviewerCensusError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidReleaseReviewerCensusError({ cause });
  }
}
