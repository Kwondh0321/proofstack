import { randomUUID } from "node:crypto";
import {
  type EvidenceScope,
  OpaqueIdSchema,
  type PolicyEvaluationJobHistoryEntryDefinition,
  type PolicyEvaluationJobSnapshot,
  PolicyEvaluationUsageSchema,
  type PolicyEvaluationWorkerMutationFence,
  PolicyEvaluationWorkerMutationFenceSchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationJobWorkerRepository,
  validatePolicyEvaluationJobHistoryEntry,
} from "@proofstack/core";
import {
  PostgresPolicyEvaluationJobContractError,
  PostgresPolicyEvaluationJobReader,
} from "./postgres-policy-evaluation-job-base.js";

export class PostgresPolicyEvaluationJobWorkerRepository
  extends PostgresPolicyEvaluationJobReader
  implements PolicyEvaluationJobWorkerRepository
{
  private async mutate(
    scopeInput: EvidenceScope,
    id: string,
    statement: string,
    values: readonly unknown[],
    operation: (
      next: PolicyEvaluationJobSnapshot,
    ) => PolicyEvaluationJobHistoryEntryDefinition["operation"],
    budgetFence: PolicyEvaluationWorkerMutationFence | null | false,
  ) {
    const jobId = OpaqueIdSchema.parse(id);
    return this.transact(scopeInput, async (client, scope) => {
      const previous = this.inspect(
        await this.one(
          client,
          "SELECT public.proofstack_prepare_policy_evaluation_job_mutation($1) AS value",
          [jobId],
        ),
        scope,
        jobId,
      );
      if (budgetFence !== false)
        await this.admitWorkerBudget(client, previous, budgetFence ?? undefined);
      const latest = await this.lastOnClient(client, scope, previous);
      await this.verifyIntents(client, previous);
      const next = this.inspect(await this.one(client, statement, values), scope, jobId);
      if (next.job.currentLease)
        await this.admitWorkerBudget(client, next, next.job.currentLease.mutationFence);
      if (next.job.stateVersion !== previous.job.stateVersion) {
        const action =
          next.job.status === "budget_exhausted" && next.job.stateVersion === 100000
            ? { kind: "history_limit" as const }
            : operation(next);
        await this.append(client, previous, latest, next, action);
      } else if (
        serializeEvaluationCanonicalJson(previous) !== serializeEvaluationCanonicalJson(next)
      )
        throw new PostgresPolicyEvaluationJobContractError(
          "Idempotent policy mutation changed its graph",
        );
      return next;
    });
  }
  async claimJob(command: Parameters<PolicyEvaluationJobWorkerRepository["claimJob"]>[0]) {
    const jobId = OpaqueIdSchema.parse(command.jobId),
      workerId = OpaqueIdSchema.parse(command.workerId),
      attemptId = OpaqueIdSchema.parse(command.attemptId),
      leaseId = OpaqueIdSchema.parse(command.leaseId);
    return this.mutate(
      command.scope,
      jobId,
      "SELECT public.proofstack_claim_policy_evaluation_job($1,$2,$3,$4) AS value",
      [jobId, workerId, attemptId, leaseId],
      (next) => {
        const fence = next.job.currentLease?.mutationFence;
        if (!fence)
          throw new PostgresPolicyEvaluationJobContractError(
            "Policy claim omitted its native lease",
          );
        return { kind: "claim", fence };
      },
      null,
    );
  }
  async heartbeatJob(command: Parameters<PolicyEvaluationJobWorkerRepository["heartbeatJob"]>[0]) {
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
    return this.mutate(
      command.scope,
      fence.jobId,
      "SELECT public.proofstack_heartbeat_policy_evaluation_job($1::jsonb) AS value",
      [JSON.stringify(fence)],
      () => ({ kind: "heartbeat", fence }),
      fence,
    );
  }
  async interruptJob(command: Parameters<PolicyEvaluationJobWorkerRepository["interruptJob"]>[0]) {
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
    return this.mutate(
      command.scope,
      fence.jobId,
      "SELECT public.proofstack_interrupt_policy_evaluation_job($1::jsonb,$2) AS value",
      [JSON.stringify(fence), command.reason],
      () => ({ kind: "interrupt", fence, reason: command.reason }),
      fence,
    );
  }
  async reclaimJob(command: Parameters<PolicyEvaluationJobWorkerRepository["reclaimJob"]>[0]) {
    const jobId = OpaqueIdSchema.parse(command.jobId);
    return this.mutate(
      command.scope,
      jobId,
      "SELECT public.proofstack_reclaim_policy_evaluation_job($1) AS value",
      [jobId],
      () => ({ kind: "reclaim" }),
      false,
    );
  }
  async reserveWork(command: Parameters<PolicyEvaluationJobWorkerRepository["reserveWork"]>[0]) {
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence),
      reservationId = OpaqueIdSchema.parse(command.reservationId),
      delta = PolicyEvaluationUsageSchema.parse(command.delta);
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
      await this.admitWorkerBudget(client, previous, fence);
      const latest = await this.lastOnClient(client, scope, previous);
      await this.verifyIntents(client, previous);
      const result = await client.query<{
        created: unknown;
        snapshot: unknown;
        reservation: unknown;
      }>("SELECT * FROM public.proofstack_reserve_policy_evaluation_work($1::jsonb,$2,$3::jsonb)", [
        JSON.stringify(fence),
        reservationId,
        JSON.stringify(delta),
      ]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || typeof row?.created !== "boolean")
        throw new PostgresPolicyEvaluationJobContractError(
          "Policy reservation returned an invalid receipt",
        );
      const next = this.inspect(row.snapshot, scope, fence.jobId);
      if (next.job.currentLease)
        await this.admitWorkerBudget(client, next, next.job.currentLease.mutationFence);
      if (next.job.stateVersion === previous.job.stateVersion) {
        if (
          row.created ||
          serializeEvaluationCanonicalJson(previous) !== serializeEvaluationCanonicalJson(next)
        )
          throw new PostgresPolicyEvaluationJobContractError(
            "Policy reservation retry changed retained state",
          );
        const reservation = validatePolicyEvaluationJobHistoryEntry(row.reservation);
        if (
          serializeEvaluationCanonicalJson(reservation.definition.scope) !==
            serializeEvaluationCanonicalJson(scope) ||
          reservation.definition.job.jobId !== fence.jobId ||
          reservation.definition.job.definitionSha256 !== next.job.definitionSha256 ||
          reservation.definition.sequence > latest.definition.sequence ||
          serializeEvaluationCanonicalJson(reservation.definition.operation) !==
            serializeEvaluationCanonicalJson({ kind: "reserve", fence, reservationId, delta })
        )
          throw new PostgresPolicyEvaluationJobContractError(
            "Policy reservation retry substituted its original occurrence",
          );
        return {
          created: false,
          snapshot: next,
          reservation,
        };
      }
      const exhausted = next.job.status === "budget_exhausted" && next.job.stateVersion === 100000;
      if (row.created !== !exhausted || row.reservation !== null)
        throw new PostgresPolicyEvaluationJobContractError(
          "New policy reservation returned an inconsistent receipt",
        );
      const entry = await this.append(
        client,
        previous,
        latest,
        next,
        exhausted ? { kind: "history_limit" } : { kind: "reserve", fence, reservationId, delta },
      );
      return { created: !exhausted, snapshot: next, reservation: exhausted ? null : entry };
    });
  }
  async reserveUsage(command: Parameters<PolicyEvaluationJobWorkerRepository["reserveUsage"]>[0]) {
    return (
      await this.reserveWork({
        ...command,
        reservationId: `reservation_${randomUUID().replaceAll("-", "")}`,
      })
    ).snapshot;
  }
}
