import {
  OpaqueIdSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  PolicyEvaluationSnapshotSchema,
  PolicyEvaluationSchema,
  encodePolicyEvaluationDefinition,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationSnapshotPageSet,
} from "@proofstack/contracts";
import {
  computeSealedPolicyEvaluation,
  completePolicyEvaluationJob,
  digestPolicyEvaluationDefinition,
  validatePolicyEvaluationSnapshotRecord,
  type PolicyEvaluationResultPublisher,
  type PolicyEvaluationResultReader,
} from "@proofstack/core";
import type { PoolClient } from "pg";
import {
  PostgresPolicyEvaluationJobReader,
  PostgresPolicyEvaluationJobContractError,
} from "./postgres-policy-evaluation-job-base.js";
import {
  readPostgresPolicyEvaluationResultOnClient,
  validatePostgresStoredPolicyResult,
} from "./postgres-policy-result-readers.js";

export class PostgresPolicyEvaluationResultRepository
  extends PostgresPolicyEvaluationJobReader
  implements PolicyEvaluationResultPublisher, PolicyEvaluationResultReader
{
  private async originalSnapshot(client: PoolClient, job: PolicyEvaluationJobSnapshot) {
    const reference = job.job.snapshot;
    if (!reference)
      throw new PostgresPolicyEvaluationJobContractError("Policy result omitted original seal");
    return PolicyEvaluationSnapshotSchema.parse(
      await this.one(client, "SELECT public.proofstack_read_policy_snapshot($1,$2) AS value", [
        reference.snapshotId,
        reference.definitionSha256,
      ]),
    );
  }
  private checkedResult(
    job: PolicyEvaluationJobSnapshot,
    record: unknown,
    original: ReturnType<typeof PolicyEvaluationSnapshotSchema.parse>,
    pageSet: PolicyEvaluationSnapshotPageSet,
  ) {
    return validatePostgresStoredPolicyResult(job, record, original, pageSet);
  }
  async publishResult(command: Parameters<PolicyEvaluationResultPublisher["publishResult"]>[0]) {
    const evaluationId = OpaqueIdSchema.parse(command.evaluationId);
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
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
      const previousEntry = await this.lastOnClient(client, scope, previous);
      await this.verifyIntents(client, previous);
      if (previous.job.status !== "completed")
        await this.admitWorkerBudget(client, previous, fence);
      const original = await this.originalSnapshot(client, previous);
      const reference = previous.job.snapshot;
      if (!reference)
        throw new PostgresPolicyEvaluationJobContractError("Missing original policy seal");
      const owning = {
        scope,
        jobId: fence.jobId,
        request: previous.job.request,
        snapshot: reference,
      };
      const { inputs } = validatePolicyEvaluationSnapshotRecord({
        expected: owning,
        record: original,
        pageSet: command.pageSet,
      });
      if (previous.job.status !== "completed") {
        const attempt = previous.attempts.at(-1);
        if (
          !attempt ||
          previous.usage.ruleEvaluations - attempt.usageAtStart.ruleEvaluations <
            inputs.rules.ruleCount
        )
          throw new PostgresPolicyEvaluationJobContractError(
            "Policy result omitted prepaid whole rule work",
          );
      }
      const definition = computeSealedPolicyEvaluation({
        evaluationId,
        expected: { scope, jobId: fence.jobId, request: previous.job.request, snapshot: reference },
        record: original,
        pageSet: command.pageSet,
      });
      const digest = digestPolicyEvaluationDefinition(scope, definition);
      const raw = await this.one(
        client,
        "SELECT public.proofstack_publish_policy_evaluation_result($1::jsonb,$2,$3) AS value",
        [
          JSON.stringify(fence),
          Buffer.from(encodePolicyEvaluationDefinition({ scope, definition })).toString("utf8"),
          digest,
        ],
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 3 ||
        typeof Reflect.get(raw, "created") !== "boolean"
      )
        throw new PostgresPolicyEvaluationJobContractError(
          "Invalid policy result publication receipt",
        );
      const created = Reflect.get(raw, "created") as boolean;
      const evaluation = PolicyEvaluationSchema.parse(Reflect.get(raw, "evaluation"));
      const next = this.inspect(Reflect.get(raw, "job"), scope, fence.jobId);
      if (created) {
        const expected = completePolicyEvaluationJob({
          snapshot: previous,
          now: evaluation.recordedAt,
          recoveryEpoch: previous.job.recoveryEpoch,
          fence,
          result: { evaluationId, definitionSha256: digest },
          ruleCount: definition.ruleCount,
        });
        if (serializeEvaluationCanonicalJson(expected) !== serializeEvaluationCanonicalJson(next))
          throw new PostgresPolicyEvaluationJobContractError(
            "Native policy completion differs from owning transition",
          );
        await this.append(client, previous, previousEntry, next, {
          kind: "complete",
          fence,
          result: { evaluationId, definitionSha256: digest },
          ruleCount: definition.ruleCount,
        });
      } else if (
        serializeEvaluationCanonicalJson(previous) !== serializeEvaluationCanonicalJson(next)
      )
        throw new PostgresPolicyEvaluationJobContractError(
          "Policy result retry changed original graph",
        );
      const checked = this.checkedResult(next, evaluation, original, command.pageSet);
      await this.lastOnClient(client, scope, next);
      await this.verifyIntents(client, next);
      return { created, evaluation: checked, snapshot: next };
    });
  }
  async findResult(scope: EvidenceScope, id: string, pageSet: PolicyEvaluationSnapshotPageSet) {
    const jobId = OpaqueIdSchema.parse(id);
    return this.transact(scope, (client, exact) =>
      readPostgresPolicyEvaluationResultOnClient(client, exact, jobId, pageSet),
    );
  }
}
