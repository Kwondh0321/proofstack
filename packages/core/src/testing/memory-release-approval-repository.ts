import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  ReleaseApprovalSchema,
  ReleaseApprovalRevocationSchema,
  ReleaseApprovalSubjectSchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApproval,
  type ReleaseApprovalReference,
  type ReleaseApprovalRevocation,
  type ReleaseApprovalSubject,
} from "@proofstack/contracts";
import {
  releaseApprovalReference,
  validateReleaseApprovalRecord,
} from "../release/release-authority-record-validation.js";
import {
  releaseApprovalRetryIntent,
  ReleaseApprovalRepositoryError,
  type ReleaseApprovalRepository,
} from "../release/release-approval-repository.js";
import {
  ReleaseDecisionVerificationBudgetError,
  type ReleaseDecisionVerificationBudget,
} from "../release/release-decision-verification-budget.js";

interface State {
  readonly approvals: Map<string, ReleaseApproval>;
  readonly subjects: Map<string, ReadonlySet<string>>;
  readonly successors: Map<string, string>;
  readonly revocations: Map<string, ReleaseApprovalRevocation>;
  readonly revoked: Map<string, string>;
}
const empty = (): State => ({
  approvals: new Map(),
  subjects: new Map(),
  successors: new Map(),
  revocations: new Map(),
  revoked: new Map(),
});
const copy = (s: State): State => ({
  approvals: new Map(s.approvals),
  subjects: new Map(s.subjects),
  successors: new Map(s.successors),
  revocations: new Map(s.revocations),
  revoked: new Map(s.revoked),
});
const same = (a: unknown, b: unknown) =>
  a === undefined || b === undefined
    ? a === b
    : serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
const subjectKey = (kind: ReleaseApproval["kind"], subject: ReleaseApprovalSubject) =>
  serializeEvaluationCanonicalJson([kind, subject]);
const fail = (reason: ReleaseApprovalRepositoryError["reason"]): never => {
  throw new ReleaseApprovalRepositoryError(reason);
};
function valid(raw: unknown): ReleaseApproval {
  const record = ReleaseApprovalSchema.parse(raw);
  return validateReleaseApprovalRecord({
    expected: { scope: record.subject.scope, reference: releaseApprovalReference(record) },
    record,
  });
}
function exact(
  s: State,
  scope: EvidenceScope,
  reference: ReleaseApprovalReference,
  budget?: ReleaseDecisionVerificationBudget,
): ReleaseApproval {
  const raw = s.approvals.get(reference.approvalId);
  budget?.observe(raw ?? { scope, reference, state: "missing" }, "approval");
  if (!raw || !same(raw.subject.scope, scope) || !same(releaseApprovalReference(raw), reference))
    return fail("lineage_invalid");
  return valid(raw);
}
function lineage(s: State, record: ReleaseApproval, budget?: ReleaseDecisionVerificationBudget) {
  if (!record.supersedes) return;
  const parent = exact(s, record.subject.scope, record.supersedes, budget);
  if (
    parent.reviewer.principalId !== record.reviewer.principalId ||
    parent.kind !== record.kind ||
    !same(parent.subject, record.subject)
  )
    return fail("lineage_invalid");
  if (
    policyEvaluationTimestampOrderKey(parent.recordedAt) >
    policyEvaluationTimestampOrderKey(record.recordedAt)
  )
    return fail("receipt_invalid");
}
function revocation(s: State, raw: unknown, budget?: ReleaseDecisionVerificationBudget) {
  const event = ReleaseApprovalRevocationSchema.parse(raw);
  const original = exact(s, event.scope, event.approval, budget);
  if (event.reviewer.principalId !== original.reviewer.principalId) return fail("lineage_invalid");
  if (
    policyEvaluationTimestampOrderKey(event.occurredAt) <
    policyEvaluationTimestampOrderKey(original.recordedAt)
  )
    return fail("receipt_invalid");
  return event;
}
function revocationIntent(event: ReleaseApprovalRevocation) {
  const { occurredAt: _at, reviewer, ...intent } = event;
  return { ...intent, reviewerPrincipalId: reviewer.principalId };
}

/** Single-process copy-on-write reference. The service/native owner must authenticate current
 * OIDC actions before calling this trusted port; stored receipts alone never supply that proof.
 */
export class MemoryReleaseApprovalRepository implements ReleaseApprovalRepository {
  private readonly tenants = new Map<string, State>();
  async findReleaseApproval(scope: EvidenceScope, approvalId: string) {
    EvidenceScopeSchema.parse(scope);
    OpaqueIdSchema.parse(approvalId);
    const state = this.tenants.get(scope.tenantId),
      raw = state?.approvals.get(approvalId);
    if (!raw || !same(raw.subject.scope, scope)) return null;
    if (!state || raw.approvalId !== approvalId) return fail("storage_invalid");
    const row = valid(raw);
    lineage(state, row);
    return row;
  }
  async findReleaseApprovalRevocation(scope: EvidenceScope, eventId: string) {
    EvidenceScopeSchema.parse(scope);
    OpaqueIdSchema.parse(eventId);
    const state = this.tenants.get(scope.tenantId),
      raw = state?.revocations.get(eventId);
    if (!raw || !same(raw.scope, scope)) return null;
    if (!state || raw.eventId !== eventId || state.revoked.get(raw.approval.approvalId) !== eventId)
      return fail("storage_invalid");
    return revocation(state, raw);
  }
  async publishReleaseApproval(input: ReleaseApproval) {
    const row = valid(input),
      scope = row.subject.scope;
    const state = this.tenants.get(scope.tenantId) ?? empty();
    const prior = state.approvals.get(row.approvalId);
    if (prior) {
      const original = valid(prior);
      lineage(state, original);
      if (!same(releaseApprovalRetryIntent(original), releaseApprovalRetryIntent(row)))
        return fail("approval_conflict");
      return { created: false, approval: original };
    }
    lineage(state, row);
    if (row.supersedes && state.successors.has(row.supersedes.approvalId))
      return fail("supersession_conflict");
    const next = copy(state),
      key = subjectKey(row.kind, row.subject);
    next.approvals.set(row.approvalId, row);
    next.subjects.set(key, new Set([...(state.subjects.get(key) ?? []), row.approvalId]));
    if (row.supersedes) next.successors.set(row.supersedes.approvalId, row.approvalId);
    this.tenants.set(scope.tenantId, next);
    return { created: true, approval: structuredClone(row) };
  }
  async publishReleaseApprovalRevocation(input: ReleaseApprovalRevocation) {
    const parsed = ReleaseApprovalRevocationSchema.parse(input);
    const state = this.tenants.get(parsed.scope.tenantId) ?? empty();
    const event = revocation(state, parsed);
    const prior = state.revocations.get(event.eventId);
    if (prior) {
      const original = revocation(state, prior);
      if (!same(revocationIntent(original), revocationIntent(event)))
        return fail("revocation_conflict");
      return { created: false, event: original };
    }
    if (state.revoked.has(event.approval.approvalId)) return fail("revocation_state_conflict");
    const next = copy(state);
    next.revocations.set(event.eventId, event);
    next.revoked.set(event.approval.approvalId, event.eventId);
    this.tenants.set(event.scope.tenantId, next);
    return { created: true, event: structuredClone(event) };
  }
  async readReleaseApprovalSubject(
    scope: EvidenceScope,
    kind: ReleaseApproval["kind"],
    input: ReleaseApprovalSubject,
    budget: ReleaseDecisionVerificationBudget,
  ) {
    try {
      EvidenceScopeSchema.parse(scope);
      if (kind !== "normal_approval" && kind !== "rule_exception") return fail("scope_mismatch");
      const subject = ReleaseApprovalSubjectSchema.parse(input);
      if (!same(scope, subject.scope)) return fail("scope_mismatch");
      const state = this.tenants.get(scope.tenantId) ?? empty(),
        key = subjectKey(kind, subject);
      const index = state.subjects.get(key) ?? new Set<string>();
      const records: ReleaseApproval[] = [],
        revocations: ReleaseApprovalRevocation[] = [];
      const seen = new Set<string>();
      for (const [id, raw] of state.approvals) {
        if (raw.kind !== kind || !same(raw.subject, subject)) continue;
        budget.observe(raw, "approval");
        const row = valid(raw);
        if (row.approvalId !== id || !index.has(id) || seen.has(id)) return fail("storage_invalid");
        seen.add(id);
        lineage(state, row, budget);
        if (row.supersedes && state.successors.get(row.supersedes.approvalId) !== id)
          return fail("storage_invalid");
        const successorId = state.successors.get(id);
        if (successorId) {
          const successor = state.approvals.get(successorId);
          budget.observe(successor ?? { state: "missing", approvalId: successorId }, "approval");
          if (
            !successor ||
            !same(successor.supersedes, releaseApprovalReference(row)) ||
            successor.kind !== kind ||
            !same(successor.subject, subject) ||
            successor.reviewer.principalId !== row.reviewer.principalId
          )
            return fail("storage_invalid");
          valid(successor);
        }
        const revokedId = state.revoked.get(id);
        if (revokedId) {
          const event = state.revocations.get(revokedId);
          budget.observe(event ?? { state: "missing", eventId: revokedId });
          if (
            !event ||
            event.eventId !== revokedId ||
            !same(event.approval, releaseApprovalReference(row)) ||
            !same(event.scope, scope)
          )
            return fail("storage_invalid");
        }
        records.push(row);
      }
      if (seen.size !== index.size || [...index].some((id) => !seen.has(id)))
        return fail("storage_invalid");
      for (const [id, raw] of state.revocations) {
        if (!seen.has(raw.approval.approvalId)) continue;
        budget.observe(raw);
        if (
          !same(raw.scope, scope) ||
          raw.eventId !== id ||
          state.revoked.get(raw.approval.approvalId) !== id
        )
          return fail("storage_invalid");
        revocations.push(revocation(state, raw, budget));
      }
      if (records.length === 0) budget.observe({ kind, subject, state: "missing" });
      records.sort((a, b) =>
        a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0,
      );
      revocations.sort((a, b) => {
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
      return { records, revocations };
    } catch (cause) {
      if (cause instanceof ReleaseDecisionVerificationBudgetError) throw cause;
      return budget.rejectSourceRead(cause);
    }
  }
}
