import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PolicyEvaluationRequestReferenceSchema,
  PolicyEvaluationJobHistoryHeadSchema,
  PolicyEvaluationJobSnapshotSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationRequestReference,
} from "@proofstack/contracts";
import {
  buildPolicyEvaluationJobOutboxIntents,
  digestPolicyEvaluationJobGraph,
  PolicyEvaluationRequestConflictError,
  validatePolicyEvaluationJobHistoryPage,
  validatePolicyEvaluationJobSnapshotRecord,
} from "@proofstack/core";
import type { PoolClient } from "pg";
import { PostgresPolicyEvaluationJobContractError } from "./postgres-policy-evaluation-job-errors.js";

type Client = Pick<PoolClient, "query">;
export async function readPolicyJobValue(
  client: Client,
  statement: string,
  values: readonly unknown[],
): Promise<unknown> {
  const rows = await client.query<{ value: unknown }>(statement, [...values]);
  if (rows.rows.length !== 1)
    throw new PostgresPolicyEvaluationJobContractError(
      "Policy function returned an unexpected row count",
    );
  return rows.rows[0]?.value;
}
export function inspectStoredPolicyJob(raw: unknown, scope: EvidenceScope, jobId: string) {
  const graph = PolicyEvaluationJobSnapshotSchema.parse(raw);
  return validatePolicyEvaluationJobSnapshotRecord({
    expected: { scope, job: { jobId, definitionSha256: graph.job.definitionSha256 } },
    snapshot: graph,
  });
}
export async function readPolicyJobHistoryHeadOnClient(
  client: Client,
  scope: EvidenceScope,
  jobId: string,
  sequence?: number,
) {
  const raw = await readPolicyJobValue(
    client,
    sequence === undefined
      ? "SELECT public.proofstack_read_policy_evaluation_history_head($1) AS value"
      : "SELECT public.proofstack_read_policy_evaluation_history_head_at($1,$2::integer) AS value",
    sequence === undefined ? [jobId] : [jobId, sequence],
  );
  if (raw === null) return null;
  const head = PolicyEvaluationJobHistoryHeadSchema.parse(raw);
  if (
    head.job.jobId !== jobId ||
    serializeEvaluationCanonicalJson(head.scope) !== serializeEvaluationCanonicalJson(scope)
  )
    throw new PostgresPolicyEvaluationJobContractError(
      "Policy history substituted its exact query subject",
    );
  return head;
}
export async function readPolicyJobLastHistoryOnClient(
  client: Client,
  scope: EvidenceScope,
  snapshot: PolicyEvaluationJobSnapshot,
) {
  const head = await readPolicyJobHistoryHeadOnClient(
    client,
    scope,
    snapshot.job.jobId,
    snapshot.job.stateVersion - 1,
  );
  if (
    head === null ||
    head.sequence + 1 !== snapshot.job.stateVersion ||
    head.job.definitionSha256 !== snapshot.job.definitionSha256 ||
    head.graphSha256 !== digestPolicyEvaluationJobGraph(snapshot)
  )
    throw new PostgresPolicyEvaluationJobContractError(
      "Policy history head does not bind its current graph",
    );
  const raw = await readPolicyJobValue(
    client,
    "SELECT public.proofstack_read_policy_evaluation_history_page($1::jsonb,$2::integer) AS value",
    [JSON.stringify(head), Math.floor(head.sequence / 100)],
  );
  const page = validatePolicyEvaluationJobHistoryPage({ expected: head, page: raw });
  const last = page.entries.at(-1);
  if (!last || last.entrySha256 !== head.entrySha256)
    throw new PostgresPolicyEvaluationJobContractError("Policy last history entry is absent");
  return last;
}
export async function verifyPolicyJobIntentsOnClient(
  client: Client,
  snapshot: PolicyEvaluationJobSnapshot,
) {
  for (const intent of buildPolicyEvaluationJobOutboxIntents(null, snapshot)) {
    const status = await readPolicyJobValue(
      client,
      "SELECT public.proofstack_policy_evaluation_intent_status($1,$2,$3::jsonb,$4::timestamptz) AS value",
      [snapshot.job.jobId, intent.eventType, JSON.stringify(intent.payload), intent.createdAt],
    );
    if (status !== "canonical")
      throw new PostgresPolicyEvaluationJobContractError(
        "Policy canonical outbox intent is missing or conflicting",
      );
  }
}
async function inspectOwningRead(
  client: Client,
  scope: EvidenceScope,
  raw: unknown,
  jobId: string,
) {
  const snapshot = inspectStoredPolicyJob(raw, scope, jobId);
  await readPolicyJobLastHistoryOnClient(client, scope, snapshot);
  await verifyPolicyJobIntentsOnClient(client, snapshot);
  return snapshot;
}
/** Trusted caller retains its exact scoped transaction/migration guards. No second client or transaction. */
export async function readPostgresPolicyEvaluationJobOnClient(
  client: Client,
  input: EvidenceScope,
  id: string,
) {
  const scope = EvidenceScopeSchema.parse(input),
    jobId = OpaqueIdSchema.parse(id);
  const raw = await readPolicyJobValue(
    client,
    "SELECT public.proofstack_read_policy_evaluation_job($1) AS value",
    [jobId],
  );
  return raw === null ? null : inspectOwningRead(client, scope, raw, jobId);
}
/** Immutable request ownership only; not current authority, an absence guard, or permission to publish. */
export async function readPostgresPolicyEvaluationJobForRequestOnClient(
  client: Client,
  input: EvidenceScope,
  reference: PolicyEvaluationRequestReference,
) {
  const scope = EvidenceScopeSchema.parse(input);
  const request = PolicyEvaluationRequestReferenceSchema.parse(reference);
  let raw: unknown;
  try {
    raw = await readPolicyJobValue(
      client,
      "SELECT public.proofstack_read_policy_evaluation_job_for_request($1,$2) AS value",
      [request.evaluationRequestId, request.definitionSha256],
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505")
      throw new PolicyEvaluationRequestConflictError();
    throw error;
  }
  if (raw === null) return null;
  const graph = PolicyEvaluationJobSnapshotSchema.parse(raw);
  if (
    serializeEvaluationCanonicalJson(graph.job.request) !==
    serializeEvaluationCanonicalJson(request)
  )
    throw new PostgresPolicyEvaluationJobContractError(
      "Original request selector substituted its owning request",
    );
  return inspectOwningRead(client, scope, graph, graph.job.jobId);
}
