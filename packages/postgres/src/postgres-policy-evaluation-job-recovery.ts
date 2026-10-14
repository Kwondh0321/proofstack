import {
  type EvidenceScope,
  EvidenceScopeSchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import type { Pool } from "pg";
import { loadBundledMigrations } from "./migrations.js";
import {
  PostgresPolicyEvaluationJobContractError,
  PostgresPolicyEvaluationJobReader,
} from "./postgres-policy-evaluation-job-base.js";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";

/** Owner-only restored-state repair. This does not grant runtime control/worker recovery authority. */
export class PostgresPolicyEvaluationJobRecovery extends PostgresPolicyEvaluationJobReader {
  constructor(pool: Pick<Pool, "connect">) {
    super(pool);
  }
  async recoverJob(scopeInput: EvidenceScope, jobId: string) {
    return this.transact(scopeInput, async (client, scope) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('proofstack:replay-recovery-epoch',0))",
      );
      const previous = this.inspect(
        await this.one(client, "SELECT public.proofstack_read_policy_evaluation_job($1) AS value", [
          jobId,
        ]),
        scope,
        jobId,
      );
      const latest = await this.lastOnClient(client, scope, previous);
      await this.verifyIntents(client, previous);
      const next = this.inspect(
        await this.one(
          client,
          "SELECT public.proofstack_recover_policy_evaluation_job($1) AS value",
          [jobId],
        ),
        scope,
        jobId,
      );
      if (next.job.stateVersion !== previous.job.stateVersion)
        await this.append(client, previous, latest, next, {
          kind: "recovery",
          recoveryEpoch: next.job.recoveryEpoch,
        });
      else if (
        serializeEvaluationCanonicalJson(previous) !== serializeEvaluationCanonicalJson(next)
      )
        throw new PostgresPolicyEvaluationJobContractError(
          "Idempotent policy recovery changed its graph",
        );
      return next;
    });
  }
  async recoverAllAtCurrentEpoch() {
    const migrations = await loadBundledMigrations();
    const client = await this.pool.connect();
    let connectionDestroyed = false;
    let transactionStarted = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      transactionStarted = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('proofstack:replay-recovery-epoch',0))",
      );
      await this.admitMigrations(client, migrations);
      const rows = await client.query<{
        tenant_id: string;
        project_id: string;
        environment_id: string;
        job_id: string;
      }>(
        "SELECT tenant_id,project_id,environment_id,job_id FROM public.proofstack_policy_evaluation_jobs WHERE status IN ('queued','acquiring','sealed','running','retry_ready') ORDER BY tenant_id,project_id,environment_id,job_id LIMIT 100001",
      );
      if (rows.rows.length > 100000)
        throw new PostgresPolicyEvaluationJobContractError(
          "Policy recovery job count exceeds fixed admission",
        );
      let recovered = 0;
      for (const row of rows.rows) {
        const scope = EvidenceScopeSchema.parse({
          tenantId: row.tenant_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
        });
        await client.query(
          "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
          [scope.tenantId, scope.projectId, scope.environmentId],
        );
        const admitted = this.inspect(
          await this.one(
            client,
            "SELECT public.proofstack_read_policy_evaluation_job($1) AS value",
            [row.job_id],
          ),
          scope,
          row.job_id,
        );
        const latest = await this.lastOnClient(client, scope, admitted);
        await this.verifyIntents(client, admitted);
        const next = this.inspect(
          await this.one(
            client,
            "SELECT public.proofstack_recover_policy_evaluation_job($1) AS value",
            [row.job_id],
          ),
          scope,
          row.job_id,
        );
        if (next.job.stateVersion !== admitted.job.stateVersion) {
          await this.append(client, admitted, latest, next, {
            kind: "recovery",
            recoveryEpoch: next.job.recoveryEpoch,
          });
          recovered++;
        } else if (
          serializeEvaluationCanonicalJson(admitted) !== serializeEvaluationCanonicalJson(next)
        )
          throw new PostgresPolicyEvaluationJobContractError(
            "Idempotent policy recovery changed its graph",
          );
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return { recoveredJobs: recovered };
    } catch (error) {
      if (!transactionStarted) {
        client.release(true);
        connectionDestroyed = true;
        throw error;
      }
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        client.release(true);
        connectionDestroyed = true;
        throw new PostgresTransactionCleanupError(error, rollbackError);
      }
      throw error;
    } finally {
      if (!connectionDestroyed) client.release();
    }
  }
}
