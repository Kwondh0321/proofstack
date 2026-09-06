import { randomUUID } from "node:crypto";
import type { EvidenceScope, ReleaseCandidate } from "@proofstack/contracts";
import { ReleaseCandidateRepositoryContractError } from "@proofstack/core";
import {
  createReleaseCandidateRepositoryTestHarness,
  releaseCandidateFixture,
  releaseCandidateRepositoryConformanceCases,
} from "@proofstack/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresReleaseCandidateRepository } from "./postgres-release-candidate-repository.js";
import {
  provisionRuntimeRoles,
  type RuntimeRoleCredentials,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";
import { withTenantTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = {
  api: {
    name: `ps_candidate_api_${runKey}`,
    password: `proofstack-candidate-api-${runKey}`,
  },
  artifact: {
    name: `ps_candidate_art_${runKey}`,
    password: `proofstack-candidate-artifact-${runKey}`,
  },
  consumer: {
    name: `ps_candidate_con_${runKey}`,
    password: `proofstack-candidate-consumer-${runKey}`,
  },
  evaluationWorker: {
    name: `ps_candidate_eval_${runKey}`,
    password: `proofstack-candidate-evaluation-${runKey}`,
  },
  humanReviewer: {
    name: `ps_candidate_human_${runKey}`,
    password: `proofstack-candidate-human-${runKey}`,
  },
  identity: {
    name: `ps_candidate_id_${runKey}`,
    password: `proofstack-candidate-identity-${runKey}`,
  },
  modelEvaluationWorker: {
    name: `ps_candidate_model_${runKey}`,
    password: `proofstack-candidate-model-${runKey}`,
  },
  publisher: {
    name: `ps_candidate_pub_${runKey}`,
    password: `proofstack-candidate-publisher-${runKey}`,
  },
  replayWorker: {
    name: `ps_candidate_replay_${runKey}`,
    password: `proofstack-candidate-replay-${runKey}`,
  },
} as const satisfies RuntimeRoleProvisioningOptions;

function connectionStringFor(role: RuntimeRoleCredentials): string {
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

function predecessorReference(candidate: ReleaseCandidate) {
  return {
    candidateId: candidate.candidateId,
    candidateVersionId: candidate.candidateVersionId,
    definitionSha256: candidate.definitionSha256,
  };
}

function publicationCommand(candidate: ReleaseCandidate): Readonly<Record<string, unknown>> {
  return {
    candidateId: candidate.candidateId,
    candidateVersionId: candidate.candidateVersionId,
    createdAt: candidate.createdAt,
    createdByPrincipalId: candidate.createdByPrincipalId,
    definitionSha256: candidate.definitionSha256,
    environmentId: candidate.scope.environmentId,
    projectId: candidate.scope.projectId,
    record: candidate,
    schemaVersion: candidate.schemaVersion,
    tenantId: candidate.scope.tenantId,
  };
}

const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const apiPool = new Pool({ connectionString: connectionStringFor(credentials.api), max: 20 });
const modelWorkerPool = new Pool({
  connectionString: connectionStringFor(credentials.modelEvaluationWorker),
  max: 2,
});
let conformanceSequence = 0;

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, credentials);
});

afterAll(async () => {
  await Promise.all([apiPool.end(), modelWorkerPool.end()]);
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

describe("PostgresReleaseCandidateRepository conformance", () => {
  for (const conformanceCase of releaseCandidateRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(() => {
        const harness = createReleaseCandidateRepositoryTestHarness(
          `pg_${runKey}_${conformanceSequence++}`,
        );
        return {
          ...harness,
          repository: new PostgresReleaseCandidateRepository(apiPool),
        };
      });
    });
  }

  it("retains one canonical outbox intent across retry and repository restart", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness(`pg_${runKey}_durability`);
    const repository = new PostgresReleaseCandidateRepository(apiPool);
    await repository.publishReleaseCandidate(harness.candidate);
    await repository.publishReleaseCandidate(harness.successor);
    await repository.publishReleaseCandidate(structuredClone(harness.candidate));
    await repository.publishReleaseCandidate(structuredClone(harness.successor));

    const records = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_release_candidates
       WHERE tenant_id = $1`,
      [harness.scope.tenantId],
    );
    const lineage = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_release_candidate_lineage
       WHERE tenant_id = $1`,
      [harness.scope.tenantId],
    );
    const intents = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_outbox
       WHERE tenant_id = $1
         AND event_type = 'release.candidate.published'
         AND aggregate_type = 'release_candidate'`,
      [harness.scope.tenantId],
    );
    expect(records.rows).toEqual([{ count: "2" }]);
    expect(lineage.rows).toEqual([{ count: "1" }]);
    expect(intents.rows).toEqual([{ count: "2" }]);

    const restartedPool = new Pool({
      connectionString: connectionStringFor(credentials.api),
      max: 1,
    });
    try {
      await expect(
        new PostgresReleaseCandidateRepository(restartedPool).findReleaseCandidate(
          harness.scope,
          harness.successor.candidateVersionId,
        ),
      ).resolves.toEqual(harness.successor);
    } finally {
      await restartedPool.end();
    }
  });

  it("denies publication outside candidate management authority and active tenant scope", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness(`pg_${runKey}_authority`);
    await expect(
      new PostgresReleaseCandidateRepository(modelWorkerPool).publishReleaseCandidate(
        harness.candidate,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      apiPool.query("SELECT public.proofstack_publish_release_candidate($1::jsonb)", [
        JSON.stringify(publicationCommand(harness.candidate)),
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      new PostgresReleaseCandidateRepository(apiPool).findReleaseCandidate(
        harness.scope,
        harness.candidate.candidateVersionId,
      ),
    ).resolves.toBeNull();
  });

  it("fails closed when a retained record no longer matches its canonical digest", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness(`pg_${runKey}_corrupt_record`);
    const repository = new PostgresReleaseCandidateRepository(apiPool);
    await repository.publishReleaseCandidate(harness.candidate);

    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `UPDATE public.proofstack_release_candidates
         SET record = jsonb_set(record, '{target,purpose}', '"tampered"'::jsonb)
         WHERE tenant_id = $1 AND candidate_version_id = $2`,
        [harness.scope.tenantId, harness.candidate.candidateVersionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expect(
      repository.findReleaseCandidate(harness.scope, harness.candidate.candidateVersionId),
    ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
  });

  it("fails closed when an immutable record loses its canonical publication intent", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness(`pg_${runKey}_corrupt_intent`);
    const repository = new PostgresReleaseCandidateRepository(apiPool);
    await repository.publishReleaseCandidate(harness.candidate);

    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `UPDATE public.proofstack_outbox
         SET payload = jsonb_build_object('recordKind', 'release_candidate')
         WHERE tenant_id = $1
           AND event_type = 'release.candidate.published'
           AND aggregate_id = $2`,
        [harness.scope.tenantId, harness.candidate.candidateVersionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expect(
      repository.publishReleaseCandidate(structuredClone(harness.candidate)),
    ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
  });

  it("isolates colliding candidate graphs and pooled context across three tenants", async () => {
    const repository = new PostgresReleaseCandidateRepository(apiPool);
    const namespace = `pg_shared_${runKey}`;
    const scopes = ["alpha", "beta", "gamma"].map(
      (label): EvidenceScope => ({
        environmentId: `env_matrix_${runKey}`,
        projectId: `prj_matrix_${runKey}`,
        tenantId: `ten_matrix_${label}_${runKey}`,
      }),
    );

    for (const scope of scopes) {
      const candidate = releaseCandidateFixture(namespace, scope);
      const successor = releaseCandidateFixture(namespace, scope, {
        predecessor: predecessorReference(candidate),
        version: "v2",
      });
      await repository.publishReleaseCandidate(candidate);
      await repository.publishReleaseCandidate(successor);
    }

    for (const scope of scopes) {
      const visible = await withTenantTransaction(apiPool, scope.tenantId, (client) =>
        client.query<{
          readonly candidate_tenants: readonly string[];
          readonly lineage_tenants: readonly string[];
          readonly registry_tenants: readonly string[];
          readonly resource_tenants: readonly string[];
          readonly tenant_context: string;
        }>(`
          SELECT
            current_setting('proofstack.tenant_id') AS tenant_context,
            ARRAY(
              SELECT DISTINCT tenant_id
              FROM public.proofstack_release_candidate_registry
              ORDER BY tenant_id
            ) AS registry_tenants,
            ARRAY(
              SELECT DISTINCT tenant_id
              FROM public.proofstack_release_candidate_resources
              ORDER BY tenant_id
            ) AS resource_tenants,
            ARRAY(
              SELECT DISTINCT tenant_id
              FROM public.proofstack_release_candidate_lineage
              ORDER BY tenant_id
            ) AS lineage_tenants,
            ARRAY(
              SELECT DISTINCT tenant_id
              FROM public.proofstack_release_candidates
              ORDER BY tenant_id
            ) AS candidate_tenants
        `),
      );
      expect(visible.rows).toEqual([
        {
          candidate_tenants: [scope.tenantId],
          lineage_tenants: [scope.tenantId],
          registry_tenants: [scope.tenantId],
          resource_tenants: [scope.tenantId],
          tenant_context: scope.tenantId,
        },
      ]);
    }
  });
});
