import { isDeepStrictEqual } from "node:util";
import {
  EvidenceScopeSchema,
  ReleaseDecisionInputReferenceSchema,
  policyEvaluationTimestampOrderKey,
  type EvidenceScope,
  type PolicyEvaluationRequestReference,
  type ReleaseDecisionInputReference,
} from "@proofstack/contracts";
import {
  ReleaseDecisionInputRepositoryError,
  ReleaseDecisionVerificationBudget,
  type ReleaseDecisionInputGraph,
} from "@proofstack/core";
import type { PoolClient } from "pg";
import { readPostgresReleaseDecisionInputOnClient } from "./postgres-release-decision-input-repository.js";

export interface PostgresDecisionRequestReservation {
  readonly ordinal: number;
  readonly request: PolicyEvaluationRequestReference;
  readonly reservedAt: string | null;
  readonly reservedAtKey: string | null;
}
export interface PostgresDecisionInputReservationObservation {
  readonly state: "reservations_observed" | "legacy_unreserved";
  readonly graph: ReleaseDecisionInputGraph;
  readonly reservations: readonly PostgresDecisionRequestReservation[];
}
const sql = `SELECT tenant_id,project_id,environment_id,input_id,input_sha256,ordinal,
  request_id,request_sha256,reservation_profile,reserved_at_lexical,reserved_at_key::text
  FROM public.proofstack_release_decision_input_plans
  WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND input_id=$4
  ORDER BY ordinal LIMIT 17`;
function fail(): never {
  throw new ReleaseDecisionInputRepositoryError("storage_invalid");
}
const contextSql = "SELECT pg_backend_pid() AS backend_pid,txid_current()::text AS transaction_id";
async function transactionContext(
  client: Pick<PoolClient, "query">,
  budget: ReleaseDecisionVerificationBudget,
) {
  const result = await client.query<Record<string, unknown>>(contextSql);
  for (const row of result.rows) budget.observe(row);
  if (!result.rows.length) budget.observe({ transactionContext: "missing" });
  if (result.rows.length !== 1) fail();
  const row = result.rows[0];
  if (!row) fail();
  const pid = row["backend_pid"],
    id = row["transaction_id"];
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof id !== "string" ||
    !/^[1-9][0-9]*$/.test(id) ||
    !isDeepStrictEqual(row, { backend_pid: pid, transaction_id: id })
  )
    fail();
  return { backend_pid: pid, transaction_id: id };
}

/** Owning original graph plus complete native reservation inventory on the same scoped RC client.
 * The original meter charges every raw/repeated/empty read before interpretation. Guards remain
 * with the caller; any failure requires whole rollback. Legacy rows are never promoted to proof.
 * This observation supplies no authentication, current authority, migration/epoch check or seal.
 */
export async function readPostgresReleaseDecisionReservationsOnClient(
  client: Pick<PoolClient, "query">,
  scopeInput: EvidenceScope,
  referenceInput: ReleaseDecisionInputReference,
  budget: ReleaseDecisionVerificationBudget,
): Promise<PostgresDecisionInputReservationObservation | null> {
  if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput);
    const reference = ReleaseDecisionInputReferenceSchema.parse(referenceInput);
    // Assign/read the same native XID on both sides. Autocommit or a pool masquerading as
    // a supplied client cannot return an observation after releasing its transaction guards.
    const before = await transactionContext(client, budget);
    const finish = async (value: PostgresDecisionInputReservationObservation | null) => {
      if (!isDeepStrictEqual(before, await transactionContext(client, budget))) fail();
      return value;
    };
    const graph = await readPostgresReleaseDecisionInputOnClient(
      client,
      scope,
      reference.decisionInputRequestId,
      budget,
    );
    if (graph === null) return await finish(null);
    if (graph.request.definitionSha256 !== reference.definitionSha256) fail();
    const rows = await client.query<Record<string, unknown>>(sql, [
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
      reference.decisionInputRequestId,
    ]);
    for (const row of rows.rows) budget.observe(row);
    if (!rows.rows.length) budget.observe({ scope, reference, reservations: [] });
    if (rows.rows.length !== graph.request.evaluations.length) fail();
    let legacy = 0;
    const reservations = rows.rows.map((raw, ordinal): PostgresDecisionRequestReservation => {
      const plan = graph.request.evaluations[ordinal];
      if (!plan) fail();
      const profile = raw["reservation_profile"];
      const at = raw["reserved_at_lexical"];
      const key = raw["reserved_at_key"];
      if (profile === null && at === null && key === null) legacy++;
      else if (
        profile !== 1 ||
        typeof at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:000|\d{0,5}[1-9])Z$/.test(at) ||
        typeof key !== "string" ||
        key !== policyEvaluationTimestampOrderKey(at).toString()
      )
        fail();
      if (
        !isDeepStrictEqual(raw, {
          tenant_id: scope.tenantId,
          project_id: scope.projectId,
          environment_id: scope.environmentId,
          input_id: reference.decisionInputRequestId,
          input_sha256: reference.definitionSha256,
          ordinal,
          request_id: plan.request.evaluationRequestId,
          request_sha256: plan.requestSha256,
          reservation_profile: profile,
          reserved_at_lexical: at,
          reserved_at_key: key,
        })
      )
        fail();
      return {
        ordinal,
        request: {
          evaluationRequestId: plan.request.evaluationRequestId,
          definitionSha256: plan.requestSha256,
        },
        reservedAt: at as string | null,
        reservedAtKey: key as string | null,
      };
    });
    if (legacy !== 0 && legacy !== reservations.length) fail();
    return await finish({
      state: legacy === 0 ? "reservations_observed" : "legacy_unreserved",
      graph,
      reservations,
    });
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}
