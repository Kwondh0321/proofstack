import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
} from "@proofstack/contracts";
import { validateReleaseDecisionInputGraph } from "../release/release-decision-input-graph-validation.js";
import {
  ReleaseDecisionInputRepositoryError,
  releaseDecisionInputRetryIntent,
  type ReleaseDecisionInputGraph,
  type ReleaseDecisionInputRepository,
} from "../release/release-decision-input-repository.js";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";

interface Owner {
  readonly inputId: string;
  readonly sha256: string;
}
interface State {
  readonly records: Map<string, ReleaseDecisionInputGraph>;
  readonly plans: Map<string, Owner>;
}
const empty = (): State => ({ records: new Map(), plans: new Map() });
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
const fail = (reason: ReleaseDecisionInputRepositoryError["reason"]): never => {
  throw new ReleaseDecisionInputRepositoryError(reason);
};
function checked(
  state: State,
  raw: ReleaseDecisionInputGraph,
  id: string,
  budget?: ReleaseDecisionVerificationBudget,
) {
  // One packed in-memory observation; every original source and planned request still counts.
  // Admission precedes parsing or traversing potentially damaged stored arrays.
  budget?.observe(
    raw,
    "metadata",
    3 +
      (Array.isArray(raw?.policies) ? raw.policies.length : 0) +
      (Array.isArray(raw?.request?.evaluations) ? raw.request.evaluations.length : 0),
  );
  const graph = validateReleaseDecisionInputGraph(raw);
  if (graph.request.decisionInputRequestId !== id) fail("storage_invalid");
  for (const planned of graph.request.evaluations) {
    const owner = state.plans.get(planned.request.evaluationRequestId);
    budget?.observe(owner ?? { requestId: planned.request.evaluationRequestId, state: "missing" });
    if (!owner || owner.inputId !== id || owner.sha256 !== planned.requestSha256)
      fail("storage_invalid");
  }
  return graph;
}
/** Synchronous copy-on-write reference. Local plan ownership is not external job reservation,
 * actual authentication, current authority or a retained native publication transaction.
 */
export class MemoryReleaseDecisionInputRepository implements ReleaseDecisionInputRepository {
  private readonly tenants = new Map<string, State>();
  async findReleaseDecisionInput(
    scopeInput: EvidenceScope,
    idInput: string,
    budget?: ReleaseDecisionVerificationBudget,
  ) {
    if (budget !== undefined && !(budget instanceof ReleaseDecisionVerificationBudget))
      fail("storage_invalid");
    budget?.snapshot();
    try {
      const scope = EvidenceScopeSchema.parse(scopeInput),
        id = OpaqueIdSchema.parse(idInput);
      const state = this.tenants.get(scope.tenantId),
        raw = state?.records.get(id);
      if (!raw || !same(raw.request.scope, scope)) {
        budget?.observe({ scope, decisionInputRequestId: id, state: "missing" });
        return null;
      }
      if (!state) return fail("storage_invalid");
      return checked(state, raw, id, budget);
    } catch (cause) {
      if (budget) return budget.rejectSourceRead(cause);
      throw cause;
    }
  }
  async publishReleaseDecisionInput(input: ReleaseDecisionInputGraph) {
    const graph = validateReleaseDecisionInputGraph(input),
      scope = graph.request.scope,
      id = graph.request.decisionInputRequestId;
    const state = this.tenants.get(scope.tenantId) ?? empty(),
      prior = state.records.get(id);
    if (prior) {
      const original = checked(state, prior, id);
      if (
        !same(
          releaseDecisionInputRetryIntent(original.request),
          releaseDecisionInputRetryIntent(graph.request),
        )
      )
        fail("input_conflict");
      return { created: false, graph: original };
    }
    for (const planned of graph.request.evaluations)
      if (state.plans.has(planned.request.evaluationRequestId)) fail("planned_request_conflict");
    const next: State = { records: new Map(state.records), plans: new Map(state.plans) };
    next.records.set(id, graph);
    for (const planned of graph.request.evaluations)
      next.plans.set(planned.request.evaluationRequestId, {
        inputId: id,
        sha256: planned.requestSha256,
      });
    this.tenants.set(scope.tenantId, next);
    return { created: true, graph: structuredClone(graph) };
  }
}
