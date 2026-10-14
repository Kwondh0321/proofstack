import {
  OpaqueIdSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  PolicyEvaluationAcquisitionUsageSchema,
  PolicyEvaluationAcquisitionAllowanceSchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  reservePolicyEvaluationAcquisition,
  settlePolicyEvaluationAcquisition,
  exhaustPolicyEvaluationJobHistory,
  type PolicyEvaluationAcquisitionRepository,
} from "@proofstack/core";
import {
  PostgresPolicyEvaluationJobReader,
  PostgresPolicyEvaluationJobContractError,
} from "./postgres-policy-evaluation-job-base.js";

/** Fixed internal fenced mutations; credit is committed before acquisition starts. */
export class PostgresPolicyAcquisitionRepository
  extends PostgresPolicyEvaluationJobReader
  implements PolicyEvaluationAcquisitionRepository
{
  async reserveAcquisition(
    command: Parameters<PolicyEvaluationAcquisitionRepository["reserveAcquisition"]>[0],
  ) {
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
    const allowanceId = OpaqueIdSchema.parse(command.allowanceId);
    return this.transact(command.scope, async (client, scope) => {
      const previous = this.inspect(
        await this.one(
          client,
          "SELECT public.proofstack_prepare_policy_evaluation_job_mutation($1) AS value",
          [fence.jobId],
        ),
        scope,
        fence.jobId,
      );
      const head = await this.lastOnClient(client, scope, previous);
      await this.verifyIntents(client, previous);
      await this.admitWorkerBudget(client, previous, fence);
      const raw = await this.one(
        client,
        "SELECT public.proofstack_reserve_policy_acquisition($1::jsonb,$2) AS value",
        [JSON.stringify(fence), allowanceId],
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 3 ||
        typeof Reflect.get(raw, "created") !== "boolean"
      )
        throw new PostgresPolicyEvaluationJobContractError("Invalid acquisition credit receipt");
      const created = Reflect.get(raw, "created") as boolean;
      const next = this.inspect(Reflect.get(raw, "snapshot"), scope, fence.jobId);
      if (next.job.status === "budget_exhausted" && next.job.stateVersion === 100000) {
        const expected = exhaustPolicyEvaluationJobHistory(previous, next.job.updatedAt);
        if (
          created ||
          Reflect.get(raw, "allowance") !== null ||
          serializeEvaluationCanonicalJson(expected) !== serializeEvaluationCanonicalJson(next)
        )
          throw new PostgresPolicyEvaluationJobContractError(
            "Invalid final acquisition history slot",
          );
        await this.append(client, previous, head, next, { kind: "history_limit" });
        return { created: false, snapshot: next, allowance: null };
      }
      const allowance = PolicyEvaluationAcquisitionAllowanceSchema.parse(
        Reflect.get(raw, "allowance"),
      );
      if (
        serializeEvaluationCanonicalJson(next.acquisitionAllowance) !==
          serializeEvaluationCanonicalJson(allowance) ||
        allowance.allowanceId !== allowanceId
      )
        throw new PostgresPolicyEvaluationJobContractError(
          "Acquisition credit substituted its owning occurrence",
        );
      if (created) {
        const expected = reservePolicyEvaluationAcquisition({
          snapshot: previous,
          now: next.job.updatedAt,
          recoveryEpoch: previous.job.recoveryEpoch,
          fence,
          allowanceId,
        });
        if (serializeEvaluationCanonicalJson(expected) !== serializeEvaluationCanonicalJson(next))
          throw new PostgresPolicyEvaluationJobContractError(
            "Native acquisition reservation differs from its owning transition",
          );
        await this.append(client, previous, head, next, {
          kind: "reserve_acquisition",
          fence,
          allowanceId,
        });
      } else if (
        serializeEvaluationCanonicalJson(previous) !== serializeEvaluationCanonicalJson(next)
      )
        throw new PostgresPolicyEvaluationJobContractError(
          "Acquisition retry changed original credit",
        );
      await this.lastOnClient(client, scope, next);
      await this.verifyIntents(client, next);
      return { created, snapshot: next, allowance };
    });
  }
  async settleAcquisition(
    command: Parameters<PolicyEvaluationAcquisitionRepository["settleAcquisition"]>[0],
  ) {
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
    const allowanceId = OpaqueIdSchema.parse(command.allowanceId);
    const usage =
      command.usage === null ? null : PolicyEvaluationAcquisitionUsageSchema.parse(command.usage);
    return this.transact(command.scope, async (client, scope) => {
      const previous = this.inspect(
        await this.one(
          client,
          "SELECT public.proofstack_prepare_policy_evaluation_job_mutation($1) AS value",
          [fence.jobId],
        ),
        scope,
        fence.jobId,
      );
      const head = await this.lastOnClient(client, scope, previous);
      await this.verifyIntents(client, previous);
      await this.admitWorkerBudget(client, previous, fence);
      const next = this.inspect(
        await this.one(
          client,
          "SELECT public.proofstack_settle_policy_acquisition($1::jsonb,$2,$3::jsonb) AS value",
          [JSON.stringify(fence), allowanceId, JSON.stringify(usage)],
        ),
        scope,
        fence.jobId,
      );
      const historyExhausted =
        next.job.status === "budget_exhausted" && next.job.stateVersion === 100000;
      const expected = historyExhausted
        ? exhaustPolicyEvaluationJobHistory(previous, next.job.updatedAt)
        : settlePolicyEvaluationAcquisition({
            snapshot: previous,
            now: next.job.updatedAt,
            recoveryEpoch: previous.job.recoveryEpoch,
            fence,
            allowanceId,
            usage,
          });
      if (serializeEvaluationCanonicalJson(expected) !== serializeEvaluationCanonicalJson(next))
        throw new PostgresPolicyEvaluationJobContractError(
          "Native acquisition settlement differs from its owning transition",
        );
      await this.append(
        client,
        previous,
        head,
        next,
        historyExhausted
          ? { kind: "history_limit" }
          : {
              kind: "settle_acquisition",
              fence,
              allowanceId,
              usage,
            },
      );
      return next;
    });
  }
}
