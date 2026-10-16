import { isDeepStrictEqual } from "node:util";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  ReleaseDecisionInputSchema,
  encodeReleaseDecisionInputDefinition,
  policyEvaluationTimestampOrderKey,
  type EvidenceScope,
  type ReleaseDecisionInput,
} from "@proofstack/contracts";
import {
  ReleaseDecisionInputRepositoryError,
  ReleaseDecisionVerificationBudget,
  releaseDecisionInputRetryIntent,
  validateReleaseDecisionInputGraph,
  type ReleaseDecisionInputRepository,
  type ReleaseDecisionInputGraph,
} from "@proofstack/core";
import type { Pool, PoolClient } from "pg";
import { withExactReadCommittedScopeTransaction } from "./tenant-transaction.js";

type Client = Pick<PoolClient, "query">;
const same = isDeepStrictEqual;
function fail(reason: ReleaseDecisionInputRepositoryError["reason"] = "storage_invalid"): never {
  throw new ReleaseDecisionInputRepositoryError(reason);
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  return raw as Record<string, unknown>;
}
function canonical(input: ReleaseDecisionInput) {
  const { schemaVersion: _version, definitionSha256: _sha, ...definition } = input;
  return Buffer.from(
    encodeReleaseDecisionInputDefinition({ scope: input.scope, definition }),
  ).toString("utf8");
}
function fields(input: ReleaseDecisionInput) {
  return {
    tenant_id: input.scope.tenantId,
    project_id: input.scope.projectId,
    environment_id: input.scope.environmentId,
    input_id: input.decisionInputRequestId,
    definition_sha256: input.definitionSha256,
    candidate_version_id: input.candidate.candidateVersionId,
    candidate_sha256: input.candidate.definitionSha256,
    selection_version_id: input.selection.selectionVersionId,
    selection_sha256: input.selection.definitionSha256,
    publisher_principal_id: input.publisher.principalId,
    publisher_type: input.publisher.principalType,
    publisher_method: input.publisher.authenticationMethod,
    publisher_credential_id: input.publisher.credentialId,
    publisher_request_id: input.publisher.requestId,
    publisher: input.publisher,
    authenticated_at_lexical: input.publisher.authenticatedAt,
    created_at_lexical: input.createdAt,
    expires_at_lexical: input.expiresAt,
    authenticated_at_key: policyEvaluationTimestampOrderKey(
      input.publisher.authenticatedAt,
    ).toString(),
    created_at_key: policyEvaluationTimestampOrderKey(input.createdAt).toString(),
    expires_at_key: policyEvaluationTimestampOrderKey(input.expiresAt).toString(),
    plan_count: input.evaluations.length,
    canonical_utf8: canonical(input),
    record: input,
  };
}
function common(input: ReleaseDecisionInput) {
  return {
    tenant_id: input.scope.tenantId,
    project_id: input.scope.projectId,
    environment_id: input.scope.environmentId,
    input_id: input.decisionInputRequestId,
    input_sha256: input.definitionSha256,
  };
}
function plans(input: ReleaseDecisionInput) {
  return input.evaluations.map((p, ordinal) => ({
    ...common(input),
    ordinal,
    request_id: p.request.evaluationRequestId,
    request_sha256: p.requestSha256,
    policy_id: p.request.policy.policyId,
    policy_version_id: p.request.policy.policyVersionId,
    policy_sha256: p.request.policy.definitionSha256,
    mode: p.mode,
    planned: p,
  }));
}
function sources(input: ReleaseDecisionInput) {
  const values = [
    {
      ...common(input),
      kind: "candidate",
      ordinal: 0,
      source_id: input.candidate.candidateVersionId,
      source_sha256: input.candidate.definitionSha256,
      reference: input.candidate,
    },
    {
      ...common(input),
      kind: "selection",
      ordinal: 0,
      source_id: input.selection.selectionVersionId,
      source_sha256: input.selection.definitionSha256,
      reference: input.selection,
    },
    ...input.evaluations.map((p, ordinal) => ({
      ...common(input),
      kind: "policy",
      ordinal,
      source_id: p.request.policy.policyVersionId,
      source_sha256: p.request.policy.definitionSha256,
      reference: p.request.policy,
    })),
  ];
  return values.sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.ordinal - b.ordinal,
  );
}
const parameters = (scope: EvidenceScope, id: string) => [
  scope.tenantId,
  scope.projectId,
  scope.environmentId,
  id,
];
const planSql =
  "SELECT tenant_id,project_id,environment_id,input_id,input_sha256,ordinal,request_id,request_sha256,policy_id,policy_version_id,policy_sha256,mode,planned FROM public.proofstack_release_decision_input_plans WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND input_id=$4 ORDER BY ordinal LIMIT 17";
const sourceSql =
  'SELECT tenant_id,project_id,environment_id,input_id,input_sha256,kind,ordinal,source_id,source_sha256,reference FROM public.proofstack_release_decision_input_sources WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND input_id=$4 ORDER BY kind COLLATE "C",ordinal LIMIT 19';

/** Original graph read only. The caller retains its explicit scoped RC client and native input
 * guard, including absence. No current authority, external job reservation or publication seal.
 */
export async function readPostgresReleaseDecisionInputOnClient(
  client: Client,
  scopeInput: EvidenceScope,
  idInput: string,
  budget?: ReleaseDecisionVerificationBudget,
): Promise<ReleaseDecisionInputGraph | null> {
  if (budget !== undefined && !(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget?.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      id = OpaqueIdSchema.parse(idInput);
    const observed = await client.query<{ value: unknown }>(
      "SELECT public.proofstack_read_release_decision_input($1::jsonb,$2) AS value",
      [JSON.stringify(scope), id],
    );
    for (const row of observed.rows)
      if (row.value !== null) budget?.observe(row.value);
      else budget?.observe({ scope, decisionInputRequestId: id, state: "missing" });
    if (observed.rows.length !== 1) fail();
    const raw = observed.rows[0]?.value;
    if (raw === null) return null;
    const root = object(raw),
      input = ReleaseDecisionInputSchema.parse(root["record"]);
    if (
      !same(input.scope, scope) ||
      input.decisionInputRequestId !== id ||
      !same(root, fields(input))
    )
      fail();
    const selected = await client.query(planSql, parameters(scope, id));
    for (const row of selected.rows) budget?.observe(row);
    if (!selected.rows.length) budget?.observe({ scope, inputId: id, plans: [] });
    if (!same(selected.rows, plans(input))) fail();
    const headers = await client.query(sourceSql, parameters(scope, id));
    for (const row of headers.rows) budget?.observe(row);
    const expected = sources(input);
    if (!same(headers.rows, expected)) fail();
    let candidate: unknown, selection: unknown;
    const policies: unknown[] = [];
    // Bodies are read separately so one response never packs sixteen complete policy witnesses.
    for (const source of expected) {
      const result = await client.query<{ record: unknown }>(
        "SELECT record FROM public.proofstack_release_decision_input_sources WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND input_id=$4 AND kind=$5 AND ordinal=$6",
        [...parameters(scope, id), source.kind, source.ordinal],
      );
      for (const row of result.rows) budget?.observe(row);
      if (result.rows.length !== 1 || Object.keys(object(result.rows[0])).length !== 1) fail();
      const record = result.rows[0]?.record;
      if (source.kind === "candidate") candidate = record;
      else if (source.kind === "selection") selection = record;
      else policies[source.ordinal] = record;
    }
    const intents = await client.query(
      `SELECT event_type AS "eventType",schema_version AS "schemaVersion",payload,
      created_at=$3::timestamptz AS "timeMatches" FROM public.proofstack_outbox
      WHERE tenant_id=$1 AND aggregate_type='release_decision_input' AND aggregate_id=$2`,
      [scope.tenantId, id, input.createdAt],
    );
    for (const row of intents.rows) budget?.observe(row);
    if (!intents.rows.length) budget?.observe({ scope, inputId: id, intents: [] });
    if (
      !same(intents.rows, [
        {
          eventType: "release.decision.input.recorded",
          schemaVersion: "0.1",
          payload: { recordKind: "release_decision_input", record: input },
          timeMatches: true,
        },
      ])
    )
      fail();
    return validateReleaseDecisionInputGraph({ request: input, candidate, selection, policies });
  } catch (cause) {
    if (budget) return budget.rejectSourceRead(cause);
    throw cause;
  }
}
function persistenceError(cause: unknown): never {
  const value =
    cause && typeof cause === "object" ? (cause as { code?: unknown; message?: unknown }) : {};
  if (value.code === "P0001" && typeof value.message === "string") {
    const reason = value.message.replace(/^release_decision_input:/, "");
    if (reason === "input_conflict" || reason === "planned_request_conflict")
      throw new ReleaseDecisionInputRepositoryError(reason, { cause });
  }
  if (["23514", "23503", "23505", "P0002", "22023", "22P02"].includes(String(value.code)))
    throw new ReleaseDecisionInputRepositoryError("storage_invalid", { cause });
  throw cause;
}
export class PostgresReleaseDecisionInputRepository implements ReleaseDecisionInputRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  async findReleaseDecisionInput(
    scope: EvidenceScope,
    id: string,
    budget?: ReleaseDecisionVerificationBudget,
  ) {
    if (budget !== undefined && !(budget instanceof ReleaseDecisionVerificationBudget)) fail();
    budget?.snapshot();
    try {
      return await withExactReadCommittedScopeTransaction(
        this.pool,
        EvidenceScopeSchema.parse(scope),
        (client) => readPostgresReleaseDecisionInputOnClient(client, scope, id, budget),
      );
    } catch (cause) {
      if (budget) return budget.rejectSourceRead(cause);
      throw cause;
    }
  }
  async publishReleaseDecisionInput(input: ReleaseDecisionInputGraph) {
    const graph = validateReleaseDecisionInputGraph(input);
    try {
      return await withExactReadCommittedScopeTransaction(
        this.pool,
        graph.request.scope,
        async (client) => {
          const result = await client.query<{ created: unknown }>(
            "SELECT public.proofstack_store_release_decision_input($1::jsonb,$2) AS created",
            [JSON.stringify(graph), canonical(graph.request)],
          );
          if (result.rows.length !== 1 || typeof result.rows[0]?.created !== "boolean") fail();
          const original = await readPostgresReleaseDecisionInputOnClient(
            client,
            graph.request.scope,
            graph.request.decisionInputRequestId,
          );
          if (
            !original ||
            !same(
              releaseDecisionInputRetryIntent(original.request),
              releaseDecisionInputRetryIntent(graph.request),
            ) ||
            (result.rows[0].created && !same(original, graph))
          )
            fail();
          return { created: result.rows[0].created, graph: original };
        },
      );
    } catch (cause) {
      return persistenceError(cause);
    }
  }
}
