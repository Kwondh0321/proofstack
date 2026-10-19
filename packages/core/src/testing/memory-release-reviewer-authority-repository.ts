import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  ReleaseDecisionReviewerRootReferenceSchema,
  ReleaseReviewerAuthorityLifecycleEventSchema,
  ReleaseReviewerAuthoritySchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseReviewerAuthority,
  type ReleaseReviewerAuthorityReference,
  type ReleaseReviewerAuthorityLifecycleEvent,
} from "@proofstack/contracts";
import {
  releaseReviewerAuthorityReference,
  validateReleaseReviewerAuthorityRecord,
} from "../release/release-authority-record-validation.js";
import {
  ReleaseReviewerAuthorityRepositoryError,
  type ReleaseReviewerAuthorityRepository,
  type ReleaseReviewerAuthorityTarget,
} from "../release/release-reviewer-authority-repository.js";
import {
  ReleaseDecisionVerificationBudgetError,
  type ReleaseDecisionVerificationBudget,
} from "../release/release-decision-verification-budget.js";

interface State {
  readonly versions: Map<string, ReleaseReviewerAuthority>;
  readonly roots: Map<string, ReleaseReviewerAuthority>;
  readonly targets: Map<string, ReleaseReviewerAuthority>;
  readonly events: Map<string, ReleaseReviewerAuthorityLifecycleEvent>;
  readonly terminals: Map<string, string>;
}
const empty = (): State => ({
  versions: new Map(),
  roots: new Map(),
  targets: new Map(),
  events: new Map(),
  terminals: new Map(),
});
const copy = (s: State): State => ({
  versions: new Map(s.versions),
  roots: new Map(s.roots),
  targets: new Map(s.targets),
  events: new Map(s.events),
  terminals: new Map(s.terminals),
});
const same = (a: unknown, b: unknown) =>
  a === undefined || b === undefined
    ? a === b
    : serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
const targetKey = (t: ReleaseReviewerAuthorityTarget) =>
  serializeEvaluationCanonicalJson([t.installationId, t.gateTargetId, t.reviewerPrincipalId]);
const fail = (reason: ReleaseReviewerAuthorityRepositoryError["reason"]): never => {
  throw new ReleaseReviewerAuthorityRepositoryError(reason);
};
function validated(raw: unknown): ReleaseReviewerAuthority {
  const record = ReleaseReviewerAuthoritySchema.parse(raw);
  return validateReleaseReviewerAuthorityRecord({
    expected: { scope: record.scope, reference: releaseReviewerAuthorityReference(record) },
    record,
  });
}
function exact(
  s: State,
  scope: EvidenceScope,
  ref: ReleaseReviewerAuthorityReference,
  budget?: ReleaseDecisionVerificationBudget,
): ReleaseReviewerAuthority {
  const row = s.versions.get(ref.authorityVersionId);
  budget?.observe(row ?? { scope, reference: ref, state: "missing" });
  if (!row || !same(row.scope, scope) || !same(releaseReviewerAuthorityReference(row), ref))
    return fail("lineage_invalid");
  return validated(row);
}
function checkedEvent(s: State, raw: unknown, budget?: ReleaseDecisionVerificationBudget) {
  const event = ReleaseReviewerAuthorityLifecycleEventSchema.parse(raw);
  const row = exact(s, event.scope, event.authority, budget);
  const receipts = [row.publishedAt];
  if (event.kind === "superseded") {
    const successor = exact(s, event.scope, event.successor, budget);
    if (!same(successor.predecessor, event.authority)) return fail("lineage_invalid");
    receipts.push(successor.publishedAt);
  }
  if (
    receipts.some(
      (at) =>
        policyEvaluationTimestampOrderKey(event.occurredAt) < policyEvaluationTimestampOrderKey(at),
    )
  )
    return fail("receipt_invalid");
  return event;
}
function semantics(record: ReleaseReviewerAuthority) {
  const { publishedAt: _at, publishedByPrincipalId: _by, ...rest } = record;
  return rest;
}
function eventSemantics(event: ReleaseReviewerAuthorityLifecycleEvent) {
  const { occurredAt: _at, actorPrincipalId: _by, ...rest } = event;
  return rest;
}

/** Copy-on-write reference, synchronous mutations before each promise resolves. No private auth,
 * durable database transaction, outbox publication or current decision authority is implemented here.
 */
export class MemoryReleaseReviewerAuthorityRepository
  implements ReleaseReviewerAuthorityRepository
{
  private readonly tenants = new Map<string, State>();

  /** Independent tentative state; only its owning composition may atomically publish a fork. */
  fork(): MemoryReleaseReviewerAuthorityRepository {
    const next = new MemoryReleaseReviewerAuthorityRepository();
    for (const [tenant, state] of this.tenants) next.tenants.set(tenant, structuredClone(state));
    return next;
  }

  async findReleaseReviewerAuthority(scope: EvidenceScope, versionId: string) {
    EvidenceScopeSchema.parse(scope);
    OpaqueIdSchema.parse(versionId);
    const row = this.tenants.get(scope.tenantId)?.versions.get(versionId);
    if (!row || !same(row.scope, scope)) return null;
    if (row.authorityVersionId !== versionId) return fail("storage_invalid");
    return validated(row);
  }
  async findReleaseReviewerAuthorityLifecycleEvent(scope: EvidenceScope, eventId: string) {
    EvidenceScopeSchema.parse(scope);
    OpaqueIdSchema.parse(eventId);
    const state = this.tenants.get(scope.tenantId);
    const row = state?.events.get(eventId);
    if (!row || !same(row.scope, scope)) return null;
    if (
      !state ||
      row.eventId !== eventId ||
      state.terminals.get(row.authority.authorityVersionId) !== eventId
    )
      return fail("storage_invalid");
    return checkedEvent(state, row);
  }
  async publishReleaseReviewerAuthority(input: ReleaseReviewerAuthority) {
    const row = validated(input),
      scope = row.scope;
    const state = this.tenants.get(scope.tenantId) ?? empty();
    const prior = state.versions.get(row.authorityVersionId);
    if (prior) {
      if (!same(semantics(prior), semantics(row))) return fail("version_conflict");
      return { created: false, authority: validated(prior) };
    }
    const target = state.targets.get(targetKey(row));
    const root = state.roots.get(row.authorityId);
    if (
      (target && (!same(target.scope, scope) || target.authorityId !== row.authorityId)) ||
      (root && (!same(root.scope, scope) || targetKey(root) !== targetKey(row)))
    )
      return fail("target_conflict");
    if (!!target !== !!root || (root && target?.authorityVersionId !== root.authorityVersionId))
      return fail("storage_invalid");
    if (
      root &&
      policyEvaluationTimestampOrderKey(row.publishedAt) <
        policyEvaluationTimestampOrderKey(root.publishedAt)
    )
      return fail("receipt_invalid");
    if (row.predecessor) {
      const parent = exact(state, scope, row.predecessor);
      if (
        policyEvaluationTimestampOrderKey(parent.publishedAt) >
        policyEvaluationTimestampOrderKey(row.publishedAt)
      )
        return fail("receipt_invalid");
    }
    const next = copy(state);
    next.versions.set(row.authorityVersionId, row);
    if (!root) {
      next.roots.set(row.authorityId, row);
      next.targets.set(targetKey(row), row);
    }
    this.tenants.set(scope.tenantId, next);
    return { created: true, authority: structuredClone(row) };
  }
  async publishReleaseReviewerAuthorityLifecycleEvent(
    input: ReleaseReviewerAuthorityLifecycleEvent,
  ) {
    const event = ReleaseReviewerAuthorityLifecycleEventSchema.parse(input);
    const state = this.tenants.get(event.scope.tenantId) ?? empty();
    const prior = state.events.get(event.eventId);
    if (prior) {
      if (!same(eventSemantics(prior), eventSemantics(event))) return fail("event_conflict");
      return { created: false, event: ReleaseReviewerAuthorityLifecycleEventSchema.parse(prior) };
    }
    checkedEvent(state, event);
    if (state.terminals.has(event.authority.authorityVersionId)) return fail("terminal_conflict");
    const next = copy(state);
    next.events.set(event.eventId, event);
    next.terminals.set(event.authority.authorityVersionId, event.eventId);
    this.tenants.set(event.scope.tenantId, next);
    return { created: true, event: structuredClone(event) };
  }
  async readReleaseReviewerAuthorityTarget(
    scope: EvidenceScope,
    target: ReleaseReviewerAuthorityTarget,
    budget: ReleaseDecisionVerificationBudget,
  ) {
    try {
      EvidenceScopeSchema.parse(scope);
      const fixed = ReleaseDecisionReviewerRootReferenceSchema.parse(target);
      const state = this.tenants.get(scope.tenantId);
      const rawRoot = state?.targets.get(targetKey(fixed));
      if (!rawRoot || !same(rawRoot.scope, scope)) {
        budget.observe({ scope, target: fixed, root: null });
        for (const row of state?.versions.values() ?? []) {
          if (same(row.scope, scope) && targetKey(row) === targetKey(fixed)) {
            budget.observe(row);
            return fail("storage_invalid");
          }
        }
        return { root: null, records: [], lifecycle: [] };
      }
      budget.observe(rawRoot);
      const root = validated(rawRoot);
      const logicalRoot = state?.roots.get(root.authorityId);
      const rootVersion = state?.versions.get(root.authorityVersionId);
      budget.observe(logicalRoot ?? { state: "missing", authorityId: root.authorityId });
      budget.observe(
        rootVersion ?? { state: "missing", authorityVersionId: root.authorityVersionId },
      );
      if (
        !state ||
        targetKey(root) !== targetKey(fixed) ||
        !same(logicalRoot, root) ||
        !same(rootVersion, root) ||
        root.predecessor
      )
        return fail("storage_invalid");
      const records: ReleaseReviewerAuthority[] = [];
      const lifecycle: ReleaseReviewerAuthorityLifecycleEvent[] = [];
      const seenVersions = new Set<string>();
      for (const [versionId, raw] of state.versions) {
        if (raw.authorityId !== root.authorityId) continue;
        budget.observe(raw);
        const row = validated(raw);
        if (
          versionId !== row.authorityVersionId ||
          seenVersions.has(row.authorityVersionId) ||
          !same(row.scope, scope) ||
          targetKey(row) !== targetKey(root)
        )
          return fail("storage_invalid");
        seenVersions.add(row.authorityVersionId);
        if (
          policyEvaluationTimestampOrderKey(row.publishedAt) <
          policyEvaluationTimestampOrderKey(root.publishedAt)
        )
          return fail("storage_invalid");
        if (row.predecessor) {
          const parent = exact(state, scope, row.predecessor, budget);
          if (
            policyEvaluationTimestampOrderKey(parent.publishedAt) >
            policyEvaluationTimestampOrderKey(row.publishedAt)
          )
            return fail("receipt_invalid");
        }
        const terminalId = state.terminals.get(row.authorityVersionId);
        if (terminalId !== undefined) {
          const terminal = state.events.get(terminalId);
          budget.observe(terminal ?? { state: "missing", eventId: terminalId });
          if (
            !terminal ||
            terminal.eventId !== terminalId ||
            !same(terminal.scope, scope) ||
            !same(terminal.authority, releaseReviewerAuthorityReference(row))
          )
            return fail("storage_invalid");
        }
        records.push(row);
      }
      for (const [eventId, raw] of state.events) {
        if (raw.authority.authorityId !== root.authorityId) continue;
        budget.observe(raw);
        if (!same(raw.scope, scope)) return fail("storage_invalid");
        const event = checkedEvent(state, raw, budget);
        if (
          eventId !== event.eventId ||
          !same(event.scope, scope) ||
          state.terminals.get(event.authority.authorityVersionId) !== event.eventId
        )
          return fail("storage_invalid");
        lifecycle.push(event);
      }
      records.sort((a, b) =>
        a.authorityVersionId < b.authorityVersionId
          ? -1
          : a.authorityVersionId > b.authorityVersionId
            ? 1
            : 0,
      );
      lifecycle.sort((a, b) => {
        const left = policyEvaluationTimestampOrderKey(a.occurredAt),
          right = policyEvaluationTimestampOrderKey(b.occurredAt);
        return left < right
          ? -1
          : left > right
            ? 1
            : a.eventId < b.eventId
              ? -1
              : a.eventId > b.eventId
                ? 1
                : 0;
      });
      return { root, records, lifecycle };
    } catch (cause) {
      if (cause instanceof ReleaseDecisionVerificationBudgetError) throw cause;
      return budget.rejectSourceRead(cause);
    }
  }
}
