import { randomUUID } from "node:crypto";
import type {
  EvidenceScope,
  ReleasePolicy,
  ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";
import { ReleasePolicyRepositoryContractError } from "@proofstack/core";
import {
  createReleasePolicyRepositoryTestHarness,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryConformanceCases,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresReleasePolicyRepository } from "./postgres-release-policy-repository.js";
import {
  provisionRuntimeRoles,
  type RuntimeRoleCredentials,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = {
  api: { name: `ps_policy_api_${runKey}`, password: `proofstack-policy-api-${runKey}` },
  artifact: { name: `ps_policy_art_${runKey}`, password: `proofstack-policy-artifact-${runKey}` },
  consumer: { name: `ps_policy_con_${runKey}`, password: `proofstack-policy-consumer-${runKey}` },
  evaluationWorker: {
    name: `ps_policy_eval_${runKey}`,
    password: `proofstack-policy-evaluation-${runKey}`,
  },
  humanReviewer: {
    name: `ps_policy_human_${runKey}`,
    password: `proofstack-policy-human-${runKey}`,
  },
  identity: { name: `ps_policy_id_${runKey}`, password: `proofstack-policy-identity-${runKey}` },
  modelEvaluationWorker: {
    name: `ps_policy_model_${runKey}`,
    password: `proofstack-policy-model-${runKey}`,
  },
  policyAuthor: {
    name: `ps_policy_author_${runKey}`,
    password: `proofstack-policy-author-${runKey}`,
  },
  publisher: { name: `ps_policy_pub_${runKey}`, password: `proofstack-policy-publisher-${runKey}` },
  replayWorker: {
    name: `ps_policy_replay_${runKey}`,
    password: `proofstack-policy-replay-${runKey}`,
  },
} as const satisfies RuntimeRoleProvisioningOptions;

function connectionStringFor(role: RuntimeRoleCredentials): string {
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

function policyReference(policy: ReleasePolicy) {
  return {
    definitionSha256: policy.definitionSha256,
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
  };
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

async function disableIntegrityAndUpdate(statement: string, values: unknown[]) {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(statement, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const policyAuthorPool = new Pool({
  connectionString: connectionStringFor(credentials.policyAuthor),
  max: 20,
});
const apiPool = new Pool({ connectionString: connectionStringFor(credentials.api), max: 2 });

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, credentials);
});

afterAll(async () => {
  await Promise.all([policyAuthorPool.end(), apiPool.end()]);
  for (const { name } of Object.values(credentials)) {
    const exists = await adminPool.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [name],
    );
    if (exists.rows[0]?.present) {
      await adminPool.query(`DROP OWNED BY "${name}"`);
      await adminPool.query(`DROP ROLE "${name}"`);
    }
  }
  await adminPool.end();
});

describe("PostgresReleasePolicyRepository conformance", () => {
  for (const conformanceCase of releasePolicyRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run((namespace) => {
        const harness = createReleasePolicyRepositoryTestHarness(namespace);
        return {
          ...harness,
          repository: new PostgresReleasePolicyRepository(policyAuthorPool),
        };
      });
    });
  }

  it("retains exact policy projections, lifecycle records, and outbox intents across restart", async () => {
    const harness = createReleasePolicyRepositoryTestHarness(`pg_policy_${runKey}_durability`);
    const repository = new PostgresReleasePolicyRepository(policyAuthorPool);
    await repository.publishReleasePolicy(harness.policy);
    await repository.publishReleasePolicy(harness.successor);
    await repository.publishReleasePolicyLifecycleEvent(harness.supersession);
    await repository.publishReleasePolicy(structuredClone(harness.policy));
    await repository.publishReleasePolicyLifecycleEvent(structuredClone(harness.supersession));

    const counts = await adminPool.query<{
      readonly lifecycle_count: string;
      readonly lineage_count: string;
      readonly outbox_count: string;
      readonly policy_count: string;
      readonly resource_count: string;
      readonly rule_count: string;
      readonly rule_source_count: string;
      readonly source_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM public.proofstack_release_policies
          WHERE tenant_id = $1) AS policy_count,
         (SELECT count(*)::text FROM public.proofstack_release_policy_resources
          WHERE tenant_id = $1) AS resource_count,
         (SELECT count(*)::text FROM public.proofstack_release_policy_lineage
          WHERE tenant_id = $1) AS lineage_count,
         (SELECT count(*)::text FROM public.proofstack_release_policy_sources
          WHERE tenant_id = $1) AS source_count,
         (SELECT count(*)::text FROM public.proofstack_release_policy_rules
          WHERE tenant_id = $1) AS rule_count,
         (SELECT count(*)::text FROM public.proofstack_release_policy_rule_sources
          WHERE tenant_id = $1) AS rule_source_count,
         (SELECT count(*)::text FROM public.proofstack_release_policy_lifecycle_events
          WHERE tenant_id = $1) AS lifecycle_count,
         (SELECT count(*)::text FROM public.proofstack_outbox
          WHERE tenant_id = $1
            AND aggregate_type IN ('release_policy', 'release_policy_lifecycle')) AS outbox_count`,
      [harness.scope.tenantId],
    );
    const projectedSources =
      harness.policy.sources.length +
      harness.policy.counterevidence.length +
      harness.successor.sources.length +
      harness.successor.counterevidence.length;
    const projectedRules = harness.policy.rules.length + harness.successor.rules.length;
    const projectedRuleSources = [...harness.policy.rules, ...harness.successor.rules].reduce(
      (total, rule) => total + rule.sources.length,
      0,
    );
    expect(counts.rows).toEqual([
      {
        lifecycle_count: "1",
        lineage_count: "1",
        outbox_count: "3",
        policy_count: "2",
        resource_count: "1",
        rule_count: String(projectedRules),
        rule_source_count: String(projectedRuleSources),
        source_count: String(projectedSources),
      },
    ]);

    const restartedPool = new Pool({
      connectionString: connectionStringFor(credentials.policyAuthor),
      max: 1,
    });
    try {
      const restarted = new PostgresReleasePolicyRepository(restartedPool);
      await expect(
        restarted.findReleasePolicy(harness.scope, harness.successor.policyVersionId),
      ).resolves.toEqual(harness.successor);
      await expect(
        restarted.findReleasePolicyLifecycleEvent(harness.scope, harness.supersession.eventId),
      ).resolves.toEqual(harness.supersession);
    } finally {
      await restartedPool.end();
    }
  });

  it("denies publication outside policy-author authority and outside an exact active scope", async () => {
    const harness = createReleasePolicyRepositoryTestHarness(`pg_policy_${runKey}_authority`);
    await expect(
      new PostgresReleasePolicyRepository(apiPool).publishReleasePolicy(harness.policy),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      policyAuthorPool.query("SELECT public.proofstack_publish_release_policy($1::jsonb)", [
        JSON.stringify(publicationCommand(harness.policy)),
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      new PostgresReleasePolicyRepository(policyAuthorPool).findReleasePolicy(
        harness.scope,
        harness.policy.policyVersionId,
      ),
    ).resolves.toBeNull();
  });

  it("fails closed when the canonical policy record is altered", async () => {
    const harness = createReleasePolicyRepositoryTestHarness(`pg_policy_${runKey}_record_tamper`);
    const repository = new PostgresReleasePolicyRepository(policyAuthorPool);
    await repository.publishReleasePolicy(harness.policy);
    await disableIntegrityAndUpdate(
      `UPDATE public.proofstack_release_policies
       SET record = jsonb_set(record, '{changeRationale}', '"tampered"'::jsonb)
       WHERE tenant_id = $1 AND policy_version_id = $2`,
      [harness.scope.tenantId, harness.policy.policyVersionId],
    );

    await expect(
      repository.findReleasePolicy(harness.scope, harness.policy.policyVersionId),
    ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
  });

  it("fails closed when a normalized projection differs from the canonical record", async () => {
    const harness = createReleasePolicyRepositoryTestHarness(
      `pg_policy_${runKey}_projection_tamper`,
    );
    const repository = new PostgresReleasePolicyRepository(policyAuthorPool);
    await repository.publishReleasePolicy(harness.policy);
    await disableIntegrityAndUpdate(
      `UPDATE public.proofstack_release_policy_rules
       SET rule = jsonb_set(rule, '{description}', '"tampered"'::jsonb)
       WHERE tenant_id = $1 AND policy_version_id = $2 AND rule_position = 1`,
      [harness.scope.tenantId, harness.policy.policyVersionId],
    );

    await expect(
      repository.findReleasePolicy(harness.scope, harness.policy.policyVersionId),
    ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
  });

  it("fails closed when an immutable policy loses its canonical outbox intent", async () => {
    const harness = createReleasePolicyRepositoryTestHarness(`pg_policy_${runKey}_intent_tamper`);
    const repository = new PostgresReleasePolicyRepository(policyAuthorPool);
    await repository.publishReleasePolicy(harness.policy);
    await disableIntegrityAndUpdate(
      `UPDATE public.proofstack_outbox
       SET payload = jsonb_build_object('recordKind', 'release_policy')
       WHERE tenant_id = $1
         AND aggregate_type = 'release_policy'
         AND aggregate_id = $2`,
      [harness.scope.tenantId, harness.policy.policyVersionId],
    );

    await expect(
      repository.publishReleasePolicy(structuredClone(harness.policy)),
    ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
  });

  it("isolates every policy table by tenant, project, and environment on pooled connections", async () => {
    const repository = new PostgresReleasePolicyRepository(policyAuthorPool);
    const sharedTenant = `ten_policy_matrix_${runKey}`;
    const scopes: readonly EvidenceScope[] = [
      {
        environmentId: `env_policy_matrix_a_${runKey}`,
        projectId: `prj_policy_matrix_a_${runKey}`,
        tenantId: sharedTenant,
      },
      {
        environmentId: `env_policy_matrix_a_${runKey}`,
        projectId: `prj_policy_matrix_b_${runKey}`,
        tenantId: sharedTenant,
      },
      {
        environmentId: `env_policy_matrix_b_${runKey}`,
        projectId: `prj_policy_matrix_a_${runKey}`,
        tenantId: sharedTenant,
      },
      {
        environmentId: `env_policy_matrix_a_${runKey}`,
        projectId: `prj_policy_matrix_a_${runKey}`,
        tenantId: `ten_policy_matrix_other_${runKey}`,
      },
    ];
    const events: ReleasePolicyLifecycleEvent[] = [];
    for (const [index, scope] of scopes.entries()) {
      const namespace = `matrix_${runKey}_${index}`;
      const policy = releasePolicyRepositoryFixture(namespace, scope);
      const successor = releasePolicyRepositoryFixture(namespace, scope, {
        predecessor: policyReference(policy),
        publishedAt: "2026-09-07T02:00:00.000Z",
        semanticVersion: "1.0.1",
      });
      const event = releasePolicyLifecycleFixture(namespace, policy);
      events.push(event);
      await repository.publishReleasePolicy(policy);
      await repository.publishReleasePolicy(successor);
      await repository.publishReleasePolicyLifecycleEvent(event);
    }

    for (const [index, scope] of scopes.entries()) {
      const expected = `${scope.tenantId}|${scope.projectId}|${scope.environmentId}`;
      const visible = await withExactScopeTransaction(policyAuthorPool, scope, (client) =>
        client.query<{
          readonly contexts: readonly string[];
          readonly lifecycle_scopes: readonly string[];
          readonly lineage_scopes: readonly string[];
          readonly policy_scopes: readonly string[];
          readonly registry_scopes: readonly string[];
          readonly resource_scopes: readonly string[];
          readonly rule_scopes: readonly string[];
          readonly rule_source_scopes: readonly string[];
          readonly source_scopes: readonly string[];
        }>(`SELECT
          ARRAY[
            current_setting('proofstack.tenant_id'),
            current_setting('proofstack.project_id'),
            current_setting('proofstack.environment_id')
          ] AS contexts,
          ARRAY(SELECT DISTINCT concat_ws('|', tenant_id, project_id, environment_id)
                FROM public.proofstack_release_policy_registry ORDER BY 1) AS registry_scopes,
          ARRAY(SELECT DISTINCT concat_ws('|', tenant_id, project_id, environment_id)
                FROM public.proofstack_release_policy_resources ORDER BY 1) AS resource_scopes,
          ARRAY(SELECT DISTINCT concat_ws('|', tenant_id, project_id, environment_id)
                FROM public.proofstack_release_policy_lineage ORDER BY 1) AS lineage_scopes,
          ARRAY(SELECT DISTINCT concat_ws('|', tenant_id, project_id, environment_id)
                FROM public.proofstack_release_policies ORDER BY 1) AS policy_scopes,
          ARRAY(SELECT DISTINCT concat_ws('|', tenant_id, project_id, environment_id)
                FROM public.proofstack_release_policy_sources ORDER BY 1) AS source_scopes,
          ARRAY(SELECT DISTINCT concat_ws('|', tenant_id, project_id, environment_id)
                FROM public.proofstack_release_policy_rules ORDER BY 1) AS rule_scopes,
          ARRAY(SELECT DISTINCT concat_ws('|', tenant_id, project_id, environment_id)
                FROM public.proofstack_release_policy_rule_sources ORDER BY 1) AS rule_source_scopes,
          ARRAY(SELECT DISTINCT concat_ws('|', tenant_id, project_id, environment_id)
                FROM public.proofstack_release_policy_lifecycle_events ORDER BY 1) AS lifecycle_scopes`),
      );
      expect(visible.rows).toEqual([
        {
          contexts: [scope.tenantId, scope.projectId, scope.environmentId],
          lifecycle_scopes: [expected],
          lineage_scopes: [expected],
          policy_scopes: [expected],
          registry_scopes: [expected],
          resource_scopes: [expected],
          rule_scopes: [expected],
          rule_source_scopes: [expected],
          source_scopes: [expected],
        },
      ]);
      await expect(
        repository.findReleasePolicyLifecycleEvent(scope, events[index]?.eventId ?? "missing"),
      ).resolves.toEqual(events[index]);
    }
  });
});
