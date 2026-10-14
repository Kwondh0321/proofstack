import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import {
  EvidenceScopeSchema,
  encodePolicyEvaluationSnapshotDefinition,
  encodePolicyEvaluationSnapshotPageDefinition,
  PolicyEvaluationTimeSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import {
  validatePolicyEvaluationSnapshot,
  validatePolicyEvaluationSnapshotRecord,
} from "@proofstack/core";
import type {
  PolicyEvaluationSnapshotSealingTransactions,
  PolicyEvaluationSnapshotSealingPorts,
} from "@proofstack/policy-evaluation";
import {
  POLICY_SEAL_TRANSACTION_MILLISECONDS,
  tightenPolicyTransaction,
  withBoundedPolicyTransaction,
  type PolicyTransactionPool,
} from "./bounded-policy-transaction.js";
import { loadBundledMigrations } from "./migrations.js";
import {
  PostgresPolicyEvaluationJobContractError,
  PostgresPolicyEvaluationJobReader,
} from "./postgres-policy-evaluation-job-base.js";
import {
  copyPostgresPolicyMetadataCatalogues,
  createPostgresPolicySourcePorts,
  type PostgresPolicyMetadataCatalogues,
} from "./postgres-policy-source-ports.js";
import type { PoolClient } from "pg";

/** Trusted server adapter; no object/key I/O, arbitrary SQL or page-producing caller port. */
export class PostgresPolicySnapshotTransactions
  extends PostgresPolicyEvaluationJobReader
  implements PolicyEvaluationSnapshotSealingTransactions
{
  private readonly catalogues;
  constructor(pool: PolicyTransactionPool, catalogues: PostgresPolicyMetadataCatalogues = {}) {
    super(pool);
    this.catalogues = copyPostgresPolicyMetadataCatalogues(catalogues);
  }
  private async admitSealBudget(client: PoolClient, graph: PolicyEvaluationJobSnapshot) {
    const invokedAt = performance.now();
    const fence = graph.job.currentLease?.mutationFence;
    if (!fence) throw new PostgresPolicyEvaluationJobContractError("Policy seal lease is absent");
    const raw = await this.one(
      client,
      "SELECT public.proofstack_policy_snapshot_io_budget($1::jsonb) AS value",
      [JSON.stringify(fence)],
    );
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 5
    )
      throw new PostgresPolicyEvaluationJobContractError("Policy seal I/O admission is invalid");
    const value = raw as Record<string, unknown>;
    const cut = PolicyEvaluationTimeSchema.parse(value["observedAt"]);
    const time = policyEvaluationTimestampOrderKey;
    const lease = graph.job.currentLease!;
    const expiry = [
      time(graph.job.deadlineAt),
      time(lease.expiresAt),
      time(lease.attemptDeadlineAt),
    ].reduce((left, right) => (left < right ? left : right));
    const remaining = Math.min(
      POLICY_SEAL_TRANSACTION_MILLISECONDS,
      Number((expiry - time(cut)) / 10n ** 27n),
    );
    if (
      remaining <= 0 ||
      time(cut) < time(graph.job.updatedAt) ||
      value["remainingMilliseconds"] !== remaining ||
      value["stateVersion"] !== graph.job.stateVersion ||
      serializeEvaluationCanonicalJson(value["scope"]) !==
        serializeEvaluationCanonicalJson(graph.job.scope) ||
      serializeEvaluationCanonicalJson(value["job"]) !==
        serializeEvaluationCanonicalJson({
          jobId: graph.job.jobId,
          definitionSha256: graph.job.definitionSha256,
        })
    )
      throw new PostgresPolicyEvaluationJobContractError(
        "Policy seal I/O admission substituted its subject or window",
      );
    tightenPolicyTransaction(client, remaining, invokedAt);
    await client.query(
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
      [String(Math.min(1000, remaining)), String(Math.min(250, remaining))],
    );
  }
  async runSealing<T>(
    command: Parameters<PolicyEvaluationSnapshotSealingTransactions["runSealing"]>[0],
    operation: (ports: PolicyEvaluationSnapshotSealingPorts) => Promise<T>,
  ): Promise<T> {
    const scope = EvidenceScopeSchema.parse(command.scope);
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
    const migrations = await loadBundledMigrations();
    return withBoundedPolicyTransaction(
      this.pool,
      async (client) => {
        await this.admitMigrations(client, migrations);
        const previous = this.inspect(
          await this.one(
            client,
            "SELECT public.proofstack_policy_snapshot_prepare($1::jsonb) AS value",
            [JSON.stringify(fence)],
          ),
          scope,
          fence.jobId,
        );
        await this.admitSealBudget(client, previous);
        const latest = await this.lastOnClient(client, scope, previous);
        await this.verifyIntents(client, previous);
        let active = true,
          failed = false,
          failure: unknown,
          publicationStarted = false;
        const pending = new Set<Promise<unknown>>();
        const call = <Result>(work: () => Promise<Result>): Promise<Result> => {
          if (!active)
            return Promise.reject(new Error("Policy snapshot transaction port has expired"));
          if (failed) return Promise.reject(failure);
          const task = Promise.resolve().then(work);
          pending.add(task);
          void task.then(
            () => pending.delete(task),
            (error: unknown) => {
              pending.delete(task);
              if (!failed) {
                failed = true;
                failure = error;
              }
            },
          );
          return task;
        };
        const sourcePorts = createPostgresPolicySourcePorts(
          client,
          scope,
          call,
          this.catalogues,
          migrations,
          fence,
        );
        try {
          await sourcePorts.sources.tryMetadataGuard();
          const ports: PolicyEvaluationSnapshotSealingPorts = {
            sources: sourcePorts.sources,
            ...sourcePorts.createMetadata(),
            publishSnapshot: (definition, principalId) =>
              call(async () => {
                if (publicationStarted || principalId !== fence.workerId)
                  throw new PostgresPolicyEvaluationJobContractError(
                    "Policy snapshot publication identity or lifetime is invalid",
                  );
                publicationStarted = true;
                const reference = {
                  snapshotId: definition.definition.snapshotId,
                  definitionSha256: definition.definitionSha256,
                };
                const expected = {
                  scope,
                  snapshot: reference,
                  request: previous.job.request,
                  jobId: fence.jobId,
                };
                const inputs = validatePolicyEvaluationSnapshot({ expected, pageSet: definition });
                if (
                  inputs.schemaVersion !== "0.2" ||
                  inputs.sources.logicalRoots.configuration !== "configured" ||
                  serializeEvaluationCanonicalJson(inputs.request) !==
                    serializeEvaluationCanonicalJson(previous.request)
                )
                  throw new PostgresPolicyEvaluationJobContractError(
                    "Policy native seal requires complete current versioned request inputs",
                  );
                for (const page of definition.pages) {
                  const {
                    scope: pageScope,
                    schemaVersion: _version,
                    definitionSha256: pageHash,
                    ...pageDefinition
                  } = page;
                  await client.query(
                    "SELECT public.proofstack_stage_policy_snapshot_page($1::jsonb,$2,$3,$4)",
                    [
                      JSON.stringify(fence),
                      reference.definitionSha256,
                      Buffer.from(
                        encodePolicyEvaluationSnapshotPageDefinition({
                          scope: pageScope,
                          definition: pageDefinition,
                        }),
                      ).toString("utf8"),
                      pageHash,
                    ],
                  );
                }
                const raw = await this.one(
                  client,
                  "SELECT public.proofstack_publish_policy_snapshot($1::jsonb,$2,$3) AS value",
                  [
                    JSON.stringify(fence),
                    Buffer.from(
                      encodePolicyEvaluationSnapshotDefinition({
                        scope,
                        definition: definition.definition,
                      }),
                    ).toString("utf8"),
                    reference.definitionSha256,
                  ],
                );
                if (
                  raw === null ||
                  typeof raw !== "object" ||
                  Array.isArray(raw) ||
                  Object.keys(raw).length !== 2
                )
                  throw new PostgresPolicyEvaluationJobContractError(
                    "Policy native seal returned an invalid receipt",
                  );
                const receipt = raw as Record<string, unknown>;
                const snapshot = validatePolicyEvaluationSnapshotRecord({
                  expected,
                  record: receipt["snapshot"],
                  pageSet: definition,
                }).record;
                const next = this.inspect(receipt["job"], scope, fence.jobId);
                await this.admitWorkerBudget(client, next, fence);
                await this.append(client, previous, latest, next, {
                  kind: "seal",
                  fence,
                  snapshot: reference,
                });
                return { snapshot, job: next };
              }),
          };
          const result = await operation(ports);
          active = false;
          await Promise.allSettled([...pending]);
          if (failed) throw failure;
          return result;
        } finally {
          active = false;
          await Promise.allSettled([...pending]);
        }
      },
      { scope, sealing: true },
    );
  }
}
