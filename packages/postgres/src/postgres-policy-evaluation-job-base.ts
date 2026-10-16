import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  encodePolicyEvaluationJobHistoryEntry,
  OpaqueIdSchema,
  type PolicyEvaluationJobHistoryEntry,
  type PolicyEvaluationJobHistoryEntryDefinition,
  type PolicyEvaluationJobHistoryHead,
  PolicyEvaluationJobHistoryHeadSchema,
  PolicyEvaluationJobHistoryPageIndexSchema,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationRequestReference,
  PolicyEvaluationRequestReferenceSchema,
  PolicyEvaluationTimeSchema,
  type PolicyEvaluationWorkerMutationFence,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  buildPolicyEvaluationJobOutboxIntents,
  createPolicyEvaluationJobHistoryEntry,
  encodePolicyEvaluationJobGraph,
  PolicyEvaluationJobNotFoundError,
  type PolicyEvaluationJobReader,
  type PolicyEvaluationRequestJobReader,
  PolicyEvaluationRequestConflictError,
  PolicyEvaluationSchedulerTransitionError,
  replayPolicyEvaluationJobHistoryEntry,
  validatePolicyEvaluationJobHistoryPage,
} from "@proofstack/core";
import type { PoolClient } from "pg";
import {
  type PolicyTransactionPool,
  tightenPolicyTransaction,
  withBoundedPolicyTransaction,
} from "./bounded-policy-transaction.js";
import { assertMigrationsCurrentOnClient } from "./migration-runner.js";
import { loadBundledMigrations, type Migration } from "./migrations.js";

import { PostgresPolicyEvaluationJobContractError } from "./postgres-policy-evaluation-job-errors.js";
export { PostgresPolicyEvaluationJobContractError } from "./postgres-policy-evaluation-job-errors.js";
import {
  inspectStoredPolicyJob,
  readPolicyJobValue,
  readPolicyJobHistoryHeadOnClient,
  readPolicyJobLastHistoryOnClient,
  verifyPolicyJobIntentsOnClient,
  readPostgresPolicyEvaluationJobOnClient,
  readPostgresPolicyEvaluationJobForRequestOnClient,
} from "./postgres-policy-evaluation-job-readers.js";
function persistenceError(error: unknown): never {
  const code =
    error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "P0002") throw new PolicyEvaluationJobNotFoundError();
  if (code === "23505") throw new PolicyEvaluationRequestConflictError();
  if (code === "40001") throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
  if (code === "55000") throw new PolicyEvaluationSchedulerTransitionError("lease_expired");
  if (code === "22003") throw new PolicyEvaluationSchedulerTransitionError("budget_exhausted");
  throw error;
}
/** Fixed SQL only, exact transaction scope; no SQL/client/DML port escapes to an application caller. */
export abstract class PostgresPolicyEvaluationJobReader
  implements PolicyEvaluationJobReader, PolicyEvaluationRequestJobReader
{
  constructor(protected readonly pool: PolicyTransactionPool) {}
  protected async admitMigrations(client: PoolClient, migrations: readonly Migration[]) {
    const guard = await client.query<{ acquired: unknown }>(
      "SELECT pg_try_advisory_xact_lock_shared(1347579483,1) AS acquired",
    );
    if (guard.rows.length !== 1 || guard.rows[0]?.acquired !== true)
      throw new PostgresPolicyEvaluationJobContractError(
        "Policy migration guard is unavailable or invalid",
      );
    await assertMigrationsCurrentOnClient(client, migrations);
  }
  protected async transact<T>(
    input: EvidenceScope,
    work: (client: PoolClient, scope: EvidenceScope) => Promise<T>,
    options: { readonly requireWire?: boolean } = {},
  ): Promise<T> {
    const scope = EvidenceScopeSchema.parse(input);
    const migrations = await loadBundledMigrations();
    try {
      return await withBoundedPolicyTransaction(
        this.pool,
        async (client) => {
          await this.admitMigrations(client, migrations);
          return work(client, scope);
        },
        { scope, ...(options.requireWire === true ? { requireWire: true } : {}) },
      );
    } catch (error) {
      return persistenceError(error);
    }
  }
  protected async one(
    client: PoolClient,
    statement: string,
    values: readonly unknown[],
  ): Promise<unknown> {
    return readPolicyJobValue(client, statement, values);
  }
  protected async admitWorkerBudget(
    client: PoolClient,
    snapshot: PolicyEvaluationJobSnapshot,
    fence?: PolicyEvaluationWorkerMutationFence,
  ) {
    const invokedAt = performance.now();
    const raw = await this.one(
      client,
      "SELECT public.proofstack_policy_evaluation_io_budget($1,$2::jsonb) AS value",
      [snapshot.job.jobId, fence ? JSON.stringify(fence) : null],
    );
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 5
    )
      throw new PostgresPolicyEvaluationJobContractError(
        "Policy I/O admission returned an invalid descriptor",
      );
    const value = raw as Record<string, unknown>;
    const cut = PolicyEvaluationTimeSchema.parse(value["observedAt"]);
    const order = policyEvaluationTimestampOrderKey;
    let expiry = order(snapshot.job.deadlineAt);
    if (snapshot.job.currentLease)
      expiry = [
        expiry,
        order(snapshot.job.currentLease.expiresAt),
        order(snapshot.job.currentLease.attemptDeadlineAt),
      ].reduce((left, right) => (left < right ? left : right));
    const milliseconds = Number((expiry - order(cut)) / 10n ** 27n);
    if (
      order(cut) < order(snapshot.job.updatedAt) ||
      milliseconds <= 0 ||
      value["remainingMilliseconds"] !== Math.min(2000, milliseconds) ||
      value["stateVersion"] !== snapshot.job.stateVersion ||
      serializeEvaluationCanonicalJson(value["scope"]) !==
        serializeEvaluationCanonicalJson(snapshot.job.scope) ||
      serializeEvaluationCanonicalJson(value["job"]) !==
        serializeEvaluationCanonicalJson({
          jobId: snapshot.job.jobId,
          definitionSha256: snapshot.job.definitionSha256,
        })
    )
      throw new PostgresPolicyEvaluationJobContractError(
        "Policy I/O admission substituted its subject, cut or remaining window",
      );
    const remaining = Math.min(2000, milliseconds);
    tightenPolicyTransaction(client, remaining, invokedAt);
    await client.query(
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
      [String(Math.min(1000, remaining)), String(Math.min(250, remaining))],
    );
  }
  protected inspect(raw: unknown, scope: EvidenceScope, jobId: string) {
    return inspectStoredPolicyJob(raw, scope, jobId);
  }
  protected async headOnClient(
    client: PoolClient,
    scope: EvidenceScope,
    jobId: string,
    sequence?: number,
  ) {
    return readPolicyJobHistoryHeadOnClient(client, scope, jobId, sequence);
  }
  protected async lastOnClient(
    client: PoolClient,
    scope: EvidenceScope,
    snapshot: PolicyEvaluationJobSnapshot,
  ): Promise<PolicyEvaluationJobHistoryEntry> {
    return readPolicyJobLastHistoryOnClient(client, scope, snapshot);
  }
  protected async verifyIntents(client: PoolClient, snapshot: PolicyEvaluationJobSnapshot) {
    return verifyPolicyJobIntentsOnClient(client, snapshot);
  }
  protected async append(
    client: PoolClient,
    previous: PolicyEvaluationJobSnapshot | null,
    previousEntry: PolicyEvaluationJobHistoryEntry | null,
    next: PolicyEvaluationJobSnapshot,
    operation: PolicyEvaluationJobHistoryEntryDefinition["operation"],
  ) {
    const entry = createPolicyEvaluationJobHistoryEntry({
      previous,
      previousEntry,
      next,
      operation,
    });
    if (previous !== null) replayPolicyEvaluationJobHistoryEntry(previous, entry);
    await client.query(
      "SELECT public.proofstack_append_policy_evaluation_job_history($1::jsonb,$2,$3,$4::jsonb)",
      [
        JSON.stringify(entry),
        Buffer.from(encodePolicyEvaluationJobHistoryEntry(entry.definition)).toString("utf8"),
        Buffer.from(encodePolicyEvaluationJobGraph(next)).toString("utf8"),
        JSON.stringify(buildPolicyEvaluationJobOutboxIntents(previous, next)),
      ],
    );
    await this.lastOnClient(client, next.job.scope, next);
    await this.verifyIntents(client, next);
    return entry;
  }
  async findJob(input: EvidenceScope, id: string) {
    const jobId = OpaqueIdSchema.parse(id);
    return this.transact(input, (client, scope) =>
      readPostgresPolicyEvaluationJobOnClient(client, scope, jobId),
    );
  }
  async findJobForRequest(input: EvidenceScope, reference: PolicyEvaluationRequestReference) {
    const request = PolicyEvaluationRequestReferenceSchema.parse(reference);
    return this.transact(input, (client, scope) =>
      readPostgresPolicyEvaluationJobForRequestOnClient(client, scope, request),
    );
  }
  async findHistoryHead(scope: EvidenceScope, id: string) {
    const jobId = OpaqueIdSchema.parse(id);
    return this.transact(scope, (client, exact) => this.headOnClient(client, exact, jobId));
  }
  async readHistoryPage(input: PolicyEvaluationJobHistoryHead, index: number) {
    const head = PolicyEvaluationJobHistoryHeadSchema.parse(input);
    const pageIndex = PolicyEvaluationJobHistoryPageIndexSchema.parse(index);
    return this.transact(head.scope, async (client) =>
      validatePolicyEvaluationJobHistoryPage({
        expected: head,
        page: await this.one(
          client,
          "SELECT public.proofstack_read_policy_evaluation_history_page($1::jsonb,$2::integer) AS value",
          [JSON.stringify(head), pageIndex],
        ),
      }),
    );
  }
}
