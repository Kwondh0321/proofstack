import {
  OpaqueIdSchema,
  type PolicyEvaluationJobSnapshot,
  PolicyEvaluationJobSnapshotSchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationJobDefinition,
  type PolicyEvaluationJobControlRepository,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import {
  PostgresPolicyEvaluationJobContractError,
  PostgresPolicyEvaluationJobReader,
} from "./postgres-policy-evaluation-job-base.js";

export class PostgresPolicyEvaluationJobControlRepository
  extends PostgresPolicyEvaluationJobReader
  implements PolicyEvaluationJobControlRepository
{
  async createJob(command: Parameters<PolicyEvaluationJobControlRepository["createJob"]>[0]) {
    const request = validatePolicyEvaluationRequestRecord(command.request);
    const jobId = OpaqueIdSchema.parse(command.jobId);
    const digest = digestPolicyEvaluationJobDefinition(request.scope, {
      jobId,
      request: {
        evaluationRequestId: request.evaluationRequestId,
        definitionSha256: request.definitionSha256,
      },
    });
    return this.transact(request.scope, async (client, scope) => {
      const result = await client.query<{ created: unknown; snapshot: unknown }>(
        "SELECT * FROM public.proofstack_create_policy_evaluation_job($1::jsonb,$2,$3)",
        [JSON.stringify(request), jobId, digest],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || typeof row?.created !== "boolean")
        throw new PostgresPolicyEvaluationJobContractError(
          "Policy creation returned an invalid receipt",
        );
      const parsed = PolicyEvaluationJobSnapshotSchema.parse(row.snapshot);
      const snapshot = this.inspect(parsed, scope, row.created ? jobId : parsed.job.jobId);
      if (
        snapshot.request.evaluationRequestId !== request.evaluationRequestId ||
        snapshot.request.definitionSha256 !== request.definitionSha256
      )
        throw new PostgresPolicyEvaluationJobContractError(
          "Policy creation substituted its immutable request",
        );
      if (row.created) await this.append(client, null, null, snapshot, { kind: "created" });
      else {
        await this.lastOnClient(client, scope, snapshot);
        await this.verifyIntents(client, snapshot);
      }
      return { created: row.created, snapshot };
    });
  }
  async cancelJob(
    command: Parameters<PolicyEvaluationJobControlRepository["cancelJob"]>[0],
  ): Promise<PolicyEvaluationJobSnapshot> {
    const jobId = OpaqueIdSchema.parse(command.jobId);
    const cancellationId = OpaqueIdSchema.parse(command.cancellationId);
    const principalId = OpaqueIdSchema.parse(command.principalId);
    return this.transact(command.scope, async (client, scope) => {
      const previous = this.inspect(
        await this.one(
          client,
          "SELECT public.proofstack_prepare_policy_evaluation_job_mutation($1) AS value",
          [jobId],
        ),
        scope,
        jobId,
      );
      const latest = await this.lastOnClient(client, scope, previous);
      await this.verifyIntents(client, previous);
      const next = this.inspect(
        await this.one(
          client,
          "SELECT public.proofstack_cancel_policy_evaluation_job($1,$2,$3,$4) AS value",
          [jobId, cancellationId, principalId, command.reason],
        ),
        scope,
        jobId,
      );
      if (next.job.stateVersion !== previous.job.stateVersion) {
        if (next.cancellation === null)
          throw new PostgresPolicyEvaluationJobContractError(
            "Policy cancellation omitted its original intent",
          );
        await this.append(client, previous, latest, next, {
          kind: "cancel",
          intent: next.cancellation,
        });
      } else if (
        serializeEvaluationCanonicalJson(previous) !== serializeEvaluationCanonicalJson(next)
      )
        throw new PostgresPolicyEvaluationJobContractError(
          "Idempotent policy cancellation changed its graph",
        );
      return next;
    });
  }
}
