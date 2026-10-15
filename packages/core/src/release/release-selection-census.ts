import {
  EvidenceScopeSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  ReleasePolicySelectionLifecycleEventSchema,
  ReleasePolicySelectionReferenceSchema,
  ReleasePolicySelectionSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleasePolicySelection,
  type ReleasePolicySelectionLifecycleEvent,
  type ReleasePolicySelectionReference,
} from "@proofstack/contracts";
import {
  releasePolicySelectionReference,
  validateReleasePolicySelectionRecord,
} from "./release-authority-record-validation.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

export interface ReleaseSelectionCensus {
  readonly state: "complete" | "unavailable" | "invalid";
  readonly records: readonly unknown[];
  readonly lifecycle: readonly unknown[];
}
export type CapturedReleaseSelectionState =
  | "current"
  | "unavailable"
  | "not_effective"
  | "expired"
  | "withdrawn"
  | "superseded"
  | "conflicting";
export interface CapturedReleaseSelectionCensus {
  readonly state: CapturedReleaseSelectionState;
  readonly original: ReleasePolicySelection | null;
  readonly active: readonly ReleasePolicySelection[];
  readonly records: readonly ReleasePolicySelection[];
  readonly lifecycle: readonly ReleasePolicySelectionLifecycleEvent[];
}
export class InvalidReleaseSelectionCensusError extends Error {
  readonly code = "release_selection_census_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid complete installation target selection census", options);
    this.name = "InvalidReleaseSelectionCensusError";
  }
}
function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}

/**
 * Pure captured-data validation, never authentication or a retained publication guard.
 * The owning port must enumerate the complete installation/gate target, verify its immutable
 * logical-root binding and charge every read. A caller-supplied version list is not that port.
 */
export function resolveCapturedReleaseSelectionCensus(input: {
  readonly scope: EvidenceScope;
  readonly reference: ReleasePolicySelectionReference;
  readonly capturedAt: string;
  readonly census: ReleaseSelectionCensus;
  readonly budget: ReleaseDecisionVerificationBudget;
}): CapturedReleaseSelectionCensus {
  try {
    const scope = EvidenceScopeSchema.parse(input.scope);
    const reference = ReleasePolicySelectionReferenceSchema.parse(input.reference);
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
      throw new InvalidReleaseSelectionCensusError();
    const records: ReleasePolicySelection[] = [];
    const events: ReleasePolicySelectionLifecycleEvent[] = [];
    for (const raw of census.records) {
      input.budget.observe(raw);
      const parsed = ReleasePolicySelectionSchema.parse(raw);
      const record = validateReleasePolicySelectionRecord({
        expected: { scope, reference: releasePolicySelectionReference(parsed) },
        record: parsed,
      });
      if (
        record.selectionId !== reference.selectionId ||
        record.installationId !== reference.installationId ||
        record.gateTargetId !== reference.gateTargetId ||
        policyEvaluationTimestampOrderKey(record.publishedAt) > cut
      )
        throw new InvalidReleaseSelectionCensusError();
      records.push(record);
    }
    for (const raw of census.lifecycle) {
      input.budget.observe(raw);
      const event = ReleasePolicySelectionLifecycleEventSchema.parse(raw);
      if (
        !same(scope, event.scope) ||
        event.selection.selectionId !== reference.selectionId ||
        event.selection.installationId !== reference.installationId ||
        event.selection.gateTargetId !== reference.gateTargetId ||
        policyEvaluationTimestampOrderKey(event.occurredAt) > cut
      )
        throw new InvalidReleaseSelectionCensusError();
      events.push(event);
    }
    records.sort((left, right) =>
      left.selectionVersionId < right.selectionVersionId
        ? -1
        : left.selectionVersionId > right.selectionVersionId
          ? 1
          : 0,
    );
    events.sort((left, right) =>
      left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0,
    );
    const versions = new Map(records.map((record) => [record.selectionVersionId, record]));
    const original = versions.get(reference.selectionVersionId) ?? null;
    const result = (
      state: CapturedReleaseSelectionState,
      active: ReleasePolicySelection[] = [],
    ): CapturedReleaseSelectionCensus => ({
      state,
      original,
      active,
      records,
      lifecycle: events,
    });
    if (original && !same(releasePolicySelectionReference(original), reference))
      throw new InvalidReleaseSelectionCensusError();
    if (
      versions.size !== records.length ||
      new Set(events.map(({ eventId }) => eventId)).size !== events.length
    )
      return result("conflicting");
    const terminals = new Map<string, ReleasePolicySelectionLifecycleEvent>();
    let incomplete = census.state !== "complete" || original === null;
    for (const event of events) {
      const target = versions.get(event.selection.selectionVersionId);
      if (terminals.has(event.selection.selectionVersionId)) return result("conflicting");
      terminals.set(event.selection.selectionVersionId, event);
      if (!target) {
        incomplete = true;
        continue;
      }
      if (
        !same(releasePolicySelectionReference(target), event.selection) ||
        policyEvaluationTimestampOrderKey(event.occurredAt) <
          policyEvaluationTimestampOrderKey(target.publishedAt)
      )
        throw new InvalidReleaseSelectionCensusError();
      if (event.kind === "superseded") {
        const successor = versions.get(event.successor.selectionVersionId);
        if (!successor) {
          incomplete = true;
          continue;
        }
        if (
          !same(releasePolicySelectionReference(successor), event.successor) ||
          !same(successor.predecessor, event.selection) ||
          policyEvaluationTimestampOrderKey(successor.publishedAt) >
            policyEvaluationTimestampOrderKey(event.occurredAt)
        )
          throw new InvalidReleaseSelectionCensusError();
      }
    }
    const completed = new Set<string>();
    for (const record of records) {
      const visited = new Set<string>();
      let current = record;
      while (!completed.has(current.selectionVersionId)) {
        if (visited.has(current.selectionVersionId)) return result("conflicting");
        visited.add(current.selectionVersionId);
        if (!current.predecessor) break;
        const parent = versions.get(current.predecessor.selectionVersionId);
        if (!parent) {
          incomplete = true;
          break;
        }
        if (
          !same(releasePolicySelectionReference(parent), current.predecessor) ||
          policyEvaluationTimestampOrderKey(parent.publishedAt) >
            policyEvaluationTimestampOrderKey(current.publishedAt)
        )
          throw new InvalidReleaseSelectionCensusError();
        current = parent;
      }
      for (const id of visited) completed.add(id);
    }
    if (incomplete || !original) return result("unavailable");
    const active = records.filter(
      (record) =>
        !terminals.has(record.selectionVersionId) &&
        policyEvaluationTimestampOrderKey(record.effectiveAt) <= cut &&
        cut < policyEvaluationTimestampOrderKey(record.expiresAt),
    );
    if (active.length > 1) return result("conflicting", active);
    const terminal = terminals.get(original.selectionVersionId);
    if (terminal) return result(terminal.kind, active);
    if (cut < policyEvaluationTimestampOrderKey(original.effectiveAt))
      return result("not_effective", active);
    if (cut >= policyEvaluationTimestampOrderKey(original.expiresAt))
      return result("expired", active);
    return result("current", active);
  } catch (cause) {
    if (
      cause instanceof InvalidReleaseSelectionCensusError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidReleaseSelectionCensusError({ cause });
  }
}
