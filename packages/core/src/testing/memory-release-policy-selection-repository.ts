import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  ReleaseDecisionSelectionRootReferenceSchema,
  ReleasePolicySelectionLifecycleEventSchema,
  ReleasePolicySelectionSchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleasePolicySelection,
  type ReleasePolicySelectionReference,
  type ReleasePolicySelectionLifecycleEvent,
} from "@proofstack/contracts";
import {
  releasePolicySelectionReference,
  validateReleasePolicySelectionRecord,
} from "../release/release-authority-record-validation.js";
import {
  ReleasePolicySelectionRepositoryError,
  type ReleasePolicySelectionRepository,
  type ReleasePolicySelectionTarget,
} from "../release/release-policy-selection-repository.js";
import {
  ReleaseDecisionVerificationBudgetError,
  type ReleaseDecisionVerificationBudget,
} from "../release/release-decision-verification-budget.js";

interface State {
  readonly versions: Map<string, ReleasePolicySelection>;
  readonly roots: Map<string, ReleasePolicySelection>;
  readonly targets: Map<string, ReleasePolicySelection>;
  readonly events: Map<string, ReleasePolicySelectionLifecycleEvent>;
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
const targetKey = (t: ReleasePolicySelectionTarget) =>
  serializeEvaluationCanonicalJson([t.installationId, t.gateTargetId]);
const fail = (reason: ReleasePolicySelectionRepositoryError["reason"]): never => {
  throw new ReleasePolicySelectionRepositoryError(reason);
};
function validated(raw: unknown): ReleasePolicySelection {
  const record = ReleasePolicySelectionSchema.parse(raw);
  return validateReleasePolicySelectionRecord({
    expected: { scope: record.scope, reference: releasePolicySelectionReference(record) },
    record,
  });
}
function exact(
  s: State,
  scope: EvidenceScope,
  ref: ReleasePolicySelectionReference,
  budget?: ReleaseDecisionVerificationBudget,
): ReleasePolicySelection {
  const row = s.versions.get(ref.selectionVersionId);
  budget?.observe(row ?? { scope, reference: ref, state: "missing" });
  if (!row || !same(row.scope, scope) || !same(releasePolicySelectionReference(row), ref))
    return fail("lineage_invalid");
  return validated(row);
}
function checkedEvent(s: State, raw: unknown, budget?: ReleaseDecisionVerificationBudget) {
  const event = ReleasePolicySelectionLifecycleEventSchema.parse(raw);
  const row = exact(s, event.scope, event.selection, budget);
  const receipts = [row.publishedAt];
  if (event.kind === "superseded") {
    const successor = exact(s, event.scope, event.successor, budget);
    if (!same(successor.predecessor, event.selection)) return fail("lineage_invalid");
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
function semantics(record: ReleasePolicySelection) {
  const { publishedAt: _at, publishedByPrincipalId: _by, ...rest } = record;
  return rest;
}
function eventSemantics(event: ReleasePolicySelectionLifecycleEvent) {
  const { occurredAt: _at, actorPrincipalId: _by, ...rest } = event;
  return rest;
}

/** Copy-on-write reference, synchronous mutations before each promise resolves. No private auth,
 * durable database transaction, outbox publication or current decision authority is implemented here.
 */
export class MemoryReleasePolicySelectionRepository implements ReleasePolicySelectionRepository {
  private readonly tenants = new Map<string, State>();

  /** Independent tentative reference state; publication still needs an owning atomic commit. */
  fork(): MemoryReleasePolicySelectionRepository {
    const next = new MemoryReleasePolicySelectionRepository();
    for (const [tenant, state] of this.tenants) next.tenants.set(tenant, structuredClone(state));
    return next;
  }

  async findReleasePolicySelection(scope: EvidenceScope, versionId: string) {
    EvidenceScopeSchema.parse(scope);
    OpaqueIdSchema.parse(versionId);
    const row = this.tenants.get(scope.tenantId)?.versions.get(versionId);
    if (!row || !same(row.scope, scope)) return null;
    if (row.selectionVersionId !== versionId) return fail("storage_invalid");
    return validated(row);
  }
  async findReleasePolicySelectionLifecycleEvent(scope: EvidenceScope, eventId: string) {
    EvidenceScopeSchema.parse(scope);
    OpaqueIdSchema.parse(eventId);
    const state = this.tenants.get(scope.tenantId);
    const row = state?.events.get(eventId);
    if (!row || !same(row.scope, scope)) return null;
    if (
      !state ||
      row.eventId !== eventId ||
      state.terminals.get(row.selection.selectionVersionId) !== eventId
    )
      return fail("storage_invalid");
    return checkedEvent(state, row);
  }
  async publishReleasePolicySelection(input: ReleasePolicySelection) {
    const row = validated(input),
      scope = row.scope;
    const state = this.tenants.get(scope.tenantId) ?? empty();
    const prior = state.versions.get(row.selectionVersionId);
    if (prior) {
      if (!same(semantics(prior), semantics(row))) return fail("version_conflict");
      return { created: false, selection: validated(prior) };
    }
    const target = state.targets.get(targetKey(row));
    const root = state.roots.get(row.selectionId);
    if (
      (target && (!same(target.scope, scope) || target.selectionId !== row.selectionId)) ||
      (root && (!same(root.scope, scope) || targetKey(root) !== targetKey(row)))
    )
      return fail("target_conflict");
    if (!!target !== !!root || (root && target?.selectionVersionId !== root.selectionVersionId))
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
    next.versions.set(row.selectionVersionId, row);
    if (!root) {
      next.roots.set(row.selectionId, row);
      next.targets.set(targetKey(row), row);
    }
    this.tenants.set(scope.tenantId, next);
    return { created: true, selection: structuredClone(row) };
  }
  async publishReleasePolicySelectionLifecycleEvent(input: ReleasePolicySelectionLifecycleEvent) {
    const event = ReleasePolicySelectionLifecycleEventSchema.parse(input);
    const state = this.tenants.get(event.scope.tenantId) ?? empty();
    const prior = state.events.get(event.eventId);
    if (prior) {
      if (!same(eventSemantics(prior), eventSemantics(event))) return fail("event_conflict");
      return { created: false, event: ReleasePolicySelectionLifecycleEventSchema.parse(prior) };
    }
    checkedEvent(state, event);
    if (state.terminals.has(event.selection.selectionVersionId)) return fail("terminal_conflict");
    const next = copy(state);
    next.events.set(event.eventId, event);
    next.terminals.set(event.selection.selectionVersionId, event.eventId);
    this.tenants.set(event.scope.tenantId, next);
    return { created: true, event: structuredClone(event) };
  }
  async readReleasePolicySelectionTarget(
    scope: EvidenceScope,
    target: ReleasePolicySelectionTarget,
    budget: ReleaseDecisionVerificationBudget,
  ) {
    try {
      EvidenceScopeSchema.parse(scope);
      const fixed = ReleaseDecisionSelectionRootReferenceSchema.parse(target);
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
      const logicalRoot = state?.roots.get(root.selectionId);
      const rootVersion = state?.versions.get(root.selectionVersionId);
      budget.observe(logicalRoot ?? { state: "missing", selectionId: root.selectionId });
      budget.observe(
        rootVersion ?? { state: "missing", selectionVersionId: root.selectionVersionId },
      );
      if (
        !state ||
        targetKey(root) !== targetKey(fixed) ||
        !same(logicalRoot, root) ||
        !same(rootVersion, root) ||
        root.predecessor
      )
        return fail("storage_invalid");
      const records: ReleasePolicySelection[] = [];
      const lifecycle: ReleasePolicySelectionLifecycleEvent[] = [];
      const seenVersions = new Set<string>();
      for (const [versionId, raw] of state.versions) {
        if (raw.selectionId !== root.selectionId) continue;
        budget.observe(raw);
        const row = validated(raw);
        if (
          versionId !== row.selectionVersionId ||
          seenVersions.has(row.selectionVersionId) ||
          !same(row.scope, scope) ||
          targetKey(row) !== targetKey(root)
        )
          return fail("storage_invalid");
        seenVersions.add(row.selectionVersionId);
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
        const terminalId = state.terminals.get(row.selectionVersionId);
        if (terminalId !== undefined) {
          const terminal = state.events.get(terminalId);
          budget.observe(terminal ?? { state: "missing", eventId: terminalId });
          if (
            !terminal ||
            terminal.eventId !== terminalId ||
            !same(terminal.scope, scope) ||
            !same(terminal.selection, releasePolicySelectionReference(row))
          )
            return fail("storage_invalid");
        }
        records.push(row);
      }
      for (const [eventId, raw] of state.events) {
        if (raw.selection.selectionId !== root.selectionId) continue;
        budget.observe(raw);
        if (!same(raw.scope, scope)) return fail("storage_invalid");
        const event = checkedEvent(state, raw, budget);
        if (
          eventId !== event.eventId ||
          !same(event.scope, scope) ||
          state.terminals.get(event.selection.selectionVersionId) !== event.eventId
        )
          return fail("storage_invalid");
        lifecycle.push(event);
      }
      records.sort((a, b) =>
        a.selectionVersionId < b.selectionVersionId
          ? -1
          : a.selectionVersionId > b.selectionVersionId
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
