import { randomUUID } from "node:crypto";
import type { ReleasePolicy, ReleasePolicyLifecycleEvent } from "@proofstack/contracts";
import {
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
  releasePolicyFixtureScope,
} from "@proofstack/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

function publicationCommand(policy: ReleasePolicy): Readonly<Record<string, unknown>> {
  return {
    definitionSha256: policy.definitionSha256,
    environmentId: policy.scope.environmentId,
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
    projectId: policy.scope.projectId,
    publishedAt: policy.publishedAt,
    publishedByPrincipalId: policy.publishedByPrincipalId,
    record: policy,
    schemaVersion: policy.schemaVersion,
    tenantId: policy.scope.tenantId,
  };
}

function lifecycleCommand(event: ReleasePolicyLifecycleEvent): Readonly<Record<string, unknown>> {
  return {
    actorPrincipalId: event.actorPrincipalId,
    environmentId: event.scope.environmentId,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    projectId: event.scope.projectId,
    record: event,
    schemaVersion: event.schemaVersion,
    tenantId: event.scope.tenantId,
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

beforeAll(async () => {
  await migrateDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("release policy withdrawal migration", () => {
  it("allows an exact withdrawal while retaining successor foreign keys", async () => {
    const namespace = `policy_withdraw_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const scope = releasePolicyFixtureScope(namespace);
    const policy = releasePolicyRepositoryFixture(namespace, scope);
    const withdrawal = releasePolicyLifecycleFixture(namespace, policy);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [scope.tenantId]);
      await client.query("SELECT set_config('proofstack.project_id', $1, true)", [scope.projectId]);
      await client.query("SELECT set_config('proofstack.environment_id', $1, true)", [
        scope.environmentId,
      ]);
      await client.query("SELECT public.proofstack_publish_release_policy($1::jsonb)", [
        JSON.stringify(publicationCommand(policy)),
      ]);
      await client.query("SELECT public.proofstack_publish_release_policy_lifecycle($1::jsonb)", [
        JSON.stringify(lifecycleCommand(withdrawal)),
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const retained = await pool.query<{ readonly event_id: string; readonly kind: string }>(
      `SELECT event_id, kind
       FROM public.proofstack_release_policy_lifecycle_events
       WHERE tenant_id = $1 AND event_id = $2`,
      [scope.tenantId, withdrawal.eventId],
    );
    const constraint = await pool.query<{ readonly match_type: string }>(
      `SELECT confmatchtype::text AS match_type
       FROM pg_constraint
       WHERE conname = 'proofstack_release_policy_lifecycle_events_successor_fk'`,
    );
    expect(retained.rows).toEqual([{ event_id: withdrawal.eventId, kind: "withdrawn" }]);
    expect(constraint.rows).toEqual([{ match_type: "s" }]);
  });
});
