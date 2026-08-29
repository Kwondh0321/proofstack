import {
  ReplayAttemptSchema,
  ReplayJobSchema,
  ReplayWorkerMutationFenceSchema,
} from "@proofstack/contracts";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

describe("replay attempt history migration", () => {
  it("backfills a canonical audit event for attempts created by the previous schema", async () => {
    const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `proofstack_attempt_upgrade_${runKey}`;
    const controlPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const upgradeUrl = new URL(databaseUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    let upgradePool: Pool | undefined;

    try {
      await controlPool.query(`CREATE DATABASE "${databaseName}"`);
      upgradePool = new Pool({ connectionString: upgradeUrl.toString(), max: 1 });
      const migrations = await loadBundledMigrations();
      const leaseAuthorityIndex = migrations.findIndex(
        ({ id }) => id === "0019_replay_worker_lease_authority",
      );
      const historyIndex = migrations.findIndex(
        ({ id }) => id === "0020_audited_replay_attempt_transitions",
      );
      expect(leaseAuthorityIndex).toBeGreaterThan(0);
      expect(historyIndex).toBe(leaseAuthorityIndex + 1);
      const previousMigrations = migrations.slice(0, historyIndex);
      const targetMigrations = migrations.slice(0, historyIndex + 1);
      await migrateDatabase(upgradePool, previousMigrations);

      const scope = {
        environmentId: `env_attempt_upgrade_${runKey}`,
        projectId: `prj_attempt_upgrade_${runKey}`,
        tenantId: `ten_attempt_upgrade_${runKey}`,
      } as const;
      const jobId = `job_attempt_upgrade_${runKey}`;
      const attemptId = `att_attempt_upgrade_${runKey}`;
      const leaseId = `lease_attempt_upgrade_${runKey}`;
      const workerId = `worker_attempt_upgrade_${runKey}`;
      const startedAt = "2026-08-29T12:00:00.000Z";
      const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" } as const;
      const fence = ReplayWorkerMutationFenceSchema.parse({
        attemptId,
        fencingToken: 1,
        jobId,
        leaseId,
        recoveryEpoch: 0,
        workerId,
      });
      const plan = {
        definitionSha256: "1".repeat(64),
        planId: `plan_attempt_upgrade_${runKey}`,
        planVersionId: `plv_attempt_upgrade_${runKey}`,
      } as const;
      const job = ReplayJobSchema.parse({
        createdAt: startedAt,
        createdByPrincipalId: "usr_attempt_upgrade",
        currentLease: {
          acquiredAt: startedAt,
          attemptSequence: 0,
          expiresAt: "2026-08-29T12:01:00.000Z",
          heartbeatAt: startedAt,
          mutationFence: fence,
          schemaVersion: "0.1",
          scope,
        },
        jobId,
        lastFencingToken: 1,
        latestAttemptSequence: 0,
        plan,
        recoveryEpoch: 0,
        schemaVersion: "0.1",
        scope,
        startedAt,
        stateVersion: 2,
        status: "running",
      });
      const attempt = ReplayAttemptSchema.parse({
        attemptId,
        attemptSequence: 0,
        isolationProfile: {
          definitionSha256: "2".repeat(64),
          id: "iso_attempt_upgrade",
          kind: "local_child_process",
          version: "1.0.0",
        },
        jobId,
        mutationFence: fence,
        plan,
        runtimeProfile: {
          definitionSha256: "3".repeat(64),
          family: "node",
          id: "run_attempt_upgrade",
          version: "1.0.0",
        },
        schemaVersion: "0.1",
        scope,
        startedAt,
        status: "running",
        targetRelease: {
          definitionSha256: "4".repeat(64),
          targetAdapter: {
            name: "proofstack.attempt_upgrade",
            protocolVersion: "1.0.0",
            version: "1.0.0",
          },
          targetId: `target_attempt_upgrade_${runKey}`,
          targetReleaseId: `trg_attempt_upgrade_${runKey}`,
          workerProtocol,
        },
        workerBuildSha256: "5".repeat(64),
        workerProtocol,
      });

      const client = await upgradePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = 'replica'");
        await client.query(
          `INSERT INTO public.proofstack_replay_jobs (
            tenant_id, project_id, environment_id, job_id, schema_version, plan_id,
            plan_version_id, plan_definition_sha256, status, state_version, recovery_epoch,
            latest_attempt_sequence, last_fencing_token, current_attempt_id, current_lease_id,
            current_worker_id, current_fencing_token, current_attempt_sequence,
            current_lease_acquired_at, current_lease_acquired_at_lexical,
            current_lease_heartbeat_at, current_lease_heartbeat_at_lexical,
            current_lease_expires_at, current_lease_expires_at_lexical,
            started_at, started_at_lexical, created_at, created_at_lexical,
            created_by_principal_id, job
          ) VALUES (
            $1, $2, $3, $4, '0.1', $5, $6, $7, 'running', 2, 0, 0, 1,
            $8, $9, $10, 1, 0, $11::timestamptz, $12, $11::timestamptz, $12,
            $13::timestamptz, $14, $11::timestamptz, $12, $11::timestamptz, $12,
            $15, $16::jsonb
          )`,
          [
            scope.tenantId,
            scope.projectId,
            scope.environmentId,
            jobId,
            plan.planId,
            plan.planVersionId,
            plan.definitionSha256,
            attemptId,
            leaseId,
            workerId,
            startedAt,
            startedAt,
            job.currentLease?.expiresAt,
            job.currentLease?.expiresAt,
            job.createdByPrincipalId,
            JSON.stringify(job),
          ],
        );
        await client.query(
          `INSERT INTO public.proofstack_replay_attempts (
            tenant_id, project_id, environment_id, job_id, attempt_id, attempt_sequence,
            schema_version, status, lease_id, worker_id, fencing_token, recovery_epoch,
            plan_id, plan_version_id, plan_definition_sha256, target_id, target_release_id,
            target_definition_sha256, worker_protocol_name, worker_protocol_version,
            worker_build_sha256, started_at, started_at_lexical, attempt
          ) VALUES (
            $1, $2, $3, $4, $5, 0, '0.1', 'running', $6, $7, 1, 0,
            $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17::timestamptz, $18, $19::jsonb
          )`,
          [
            scope.tenantId,
            scope.projectId,
            scope.environmentId,
            jobId,
            attemptId,
            leaseId,
            workerId,
            plan.planId,
            plan.planVersionId,
            plan.definitionSha256,
            attempt.targetRelease.targetId,
            attempt.targetRelease.targetReleaseId,
            attempt.targetRelease.definitionSha256,
            workerProtocol.name,
            workerProtocol.version,
            attempt.workerBuildSha256,
            startedAt,
            startedAt,
            JSON.stringify(attempt),
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await expect(
        upgradePool.query("SELECT * FROM public.proofstack_replay_attempt_events"),
      ).rejects.toMatchObject({ code: "42P01" });
      await expect(migrateDatabase(upgradePool, targetMigrations)).resolves.toMatchObject({
        newlyAppliedIds: ["0020_audited_replay_attempt_transitions"],
      });
      await expect(assertMigrationsCurrent(upgradePool, targetMigrations)).resolves.toBeUndefined();

      const history = await upgradePool.query<{
        readonly event: unknown;
        readonly event_type: string;
        readonly status: string;
        readonly transition_sequence: string;
      }>(
        `SELECT event_type, status, transition_sequence::text, event
         FROM public.proofstack_replay_attempt_events
         WHERE tenant_id = $1 AND attempt_id = $2`,
        [scope.tenantId, attemptId],
      );
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]).toMatchObject({
        event: { attempt, eventType: "attempt_imported", status: "running" },
        event_type: "attempt_imported",
        status: "running",
        transition_sequence: "0",
      });

      const security = await upgradePool.query<{
        readonly relforcerowsecurity: boolean;
        readonly relrowsecurity: boolean;
      }>(
        `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
         WHERE oid = 'public.proofstack_replay_attempt_events'::regclass`,
      );
      expect(security.rows).toEqual([{ relforcerowsecurity: true, relrowsecurity: true }]);
    } finally {
      await upgradePool?.end();
      await controlPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await controlPool.end();
    }
  });
});
