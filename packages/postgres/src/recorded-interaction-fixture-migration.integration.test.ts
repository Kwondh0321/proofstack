import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  InteractionCaptureManifest,
  RecordedInteractionFixtureVersionDefinition,
} from "@proofstack/contracts";
import { RecordedInteractionFixtureVersionDefinitionSchema } from "@proofstack/contracts";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const NEW_TABLES = [
  "proofstack_interaction_fixture_artifact_ownerships",
  "proofstack_interaction_fixture_content_revocations",
  "proofstack_recorded_interaction_fixture_versions",
] as const;

const vectorDocument = JSON.parse(
  readFileSync(
    new URL("../../datasets/vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly vectors: readonly {
    readonly input: RecordedInteractionFixtureVersionDefinition;
  }[];
};

const vectorDefinition = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  vectorDocument.vectors[0]?.input,
);

const INSERT_FIXTURE_VERSION_SQL = `
  INSERT INTO public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256,
    fixture_version_id,
    schema_version,
    name,
    description,
    predecessor_fixture_version_id,
    predecessor_definition_sha256,
    replayability,
    source_kind,
    source_trace_id,
    source_event_count,
    source_completeness,
    source_captured_at,
    source_captured_at_lexical,
    created_at,
    created_at_lexical,
    created_by_principal_id,
    definition_sha256
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, 'trace_snapshot',
    $13, 1, 'observed_snapshot', $14::timestamptz, $15::text, $16::timestamptz,
    $17::text, $18, $19
  )
`;

async function asRuntime<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  runtimeRole: string,
  tenantId: string,
  query: (client: PoolClient) => Promise<QueryResult<Row>>,
): Promise<QueryResult<Row>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenantId]);
    const result = await query(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function capture(): InteractionCaptureManifest {
  return structuredClone(vectorDefinition.interactionCapture);
}

describe("recorded interaction fixture migration", () => {
  it("binds complete retained content and revokes it atomically under forced tenant RLS", async () => {
    const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `proofstack_interaction_${process.pid}_${runKey}`;
    const runtimeRole = `ps_interaction_${runKey}`;
    const controlPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const upgradeUrl = new URL(databaseUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    let roleCreated = false;
    let upgradePool: Pool | undefined;

    const tenantId = `ten_interaction_${runKey}`;
    const otherTenantId = `ten_interaction_other_${runKey}`;
    const projectId = `prj_interaction_${runKey}`;
    const environmentId = `env_interaction_${runKey}`;
    const fixtureId = `fix_interaction_${runKey}`;
    const predecessorVersionId = `fiv_evidence_${runKey}`;
    const recordedVersionId = `fiv_recorded_${runKey}`;
    const predecessorDigest = "8".repeat(64);
    const recordedDigest = "9".repeat(64);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const principalId = `usr_interaction_${runKey}`;
    const predecessorCreatedAt = "2026-08-29T09:30:00.000Z";
    const recordedCreatedAt = "2026-08-29T10:00:00.000Z";
    const revocationTime = "2026-08-29T11:00:00.000Z";
    const revocationReason = "Fixture content was revoked by its owner";

    const insertVersion = async (
      client: PoolClient,
      options: {
        readonly definitionDigest: string;
        readonly eventId: string;
        readonly name: string;
        readonly predecessorDigest: string | null;
        readonly predecessorVersionId: string | null;
        readonly replayability: "evidence_only" | "recorded_interactions";
        readonly schemaVersion: "0.1" | "0.2";
        readonly versionId: string;
      },
    ): Promise<void> => {
      const createdAt =
        options.replayability === "evidence_only" ? predecessorCreatedAt : recordedCreatedAt;
      await client.query(INSERT_FIXTURE_VERSION_SQL, [
        tenantId,
        projectId,
        environmentId,
        fixtureId,
        predecessorVersionId,
        predecessorDigest,
        options.versionId,
        options.schemaVersion,
        options.name,
        options.predecessorVersionId,
        options.predecessorDigest,
        options.replayability,
        traceId,
        predecessorCreatedAt,
        predecessorCreatedAt,
        createdAt,
        createdAt,
        principalId,
        options.definitionDigest,
      ]);
      await client.query(
        `
          INSERT INTO public.proofstack_regression_fixture_events (
            tenant_id,
            project_id,
            environment_id,
            fixture_id,
            fixture_version_id,
            source_trace_id,
            source_event_count,
            event_position,
            event_id
          ) VALUES ($1, $2, $3, $4, $5, $6, 1, 0, $7)
        `,
        [
          tenantId,
          projectId,
          environmentId,
          fixtureId,
          options.versionId,
          traceId,
          options.eventId,
        ],
      );
    };

    const insertRecordedCompanion = async (
      client: PoolClient,
      versionId: string,
      manifest: InteractionCaptureManifest,
    ): Promise<void> => {
      await client.query(
        `
          INSERT INTO public.proofstack_recorded_interaction_fixture_versions (
            tenant_id,
            project_id,
            environment_id,
            fixture_id,
            fixture_version_id,
            interaction_capture
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [tenantId, projectId, environmentId, fixtureId, versionId, manifest],
      );
    };

    const insertOwnership = async (
      client: PoolClient,
      versionId: string,
      position: number,
      artifactId: string,
    ): Promise<void> => {
      await client.query(
        `
          INSERT INTO public.proofstack_interaction_fixture_artifact_ownerships (
            tenant_id,
            project_id,
            environment_id,
            artifact_id,
            fixture_id,
            fixture_version_id,
            artifact_position,
            schema_version,
            bound_at,
            bound_at_lexical,
            bound_by_principal_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, '0.1', $8::timestamptz, $9::text, $10
          )
        `,
        [
          tenantId,
          projectId,
          environmentId,
          artifactId,
          fixtureId,
          versionId,
          position,
          recordedCreatedAt,
          recordedCreatedAt,
          principalId,
        ],
      );
    };

    try {
      await controlPool.query(`CREATE DATABASE "${databaseName}"`);
      upgradePool = new Pool({ connectionString: upgradeUrl.toString(), max: 2 });

      const migrations = await loadBundledMigrations();
      const recordedMigrationIndex = migrations.findIndex(
        ({ id }) => id === "0014_recorded_interaction_fixtures",
      );
      const repairMigrationIndex = migrations.findIndex(
        ({ id }) => id === "0015_expand_artifact_tombstone_trigger",
      );
      expect(recordedMigrationIndex).toBeGreaterThan(0);
      expect(repairMigrationIndex).toBe(recordedMigrationIndex + 1);
      const previousMigrations = migrations.slice(0, recordedMigrationIndex);
      const targetMigrations = migrations.slice(0, repairMigrationIndex + 1);
      await migrateDatabase(upgradePool, previousMigrations);
      await expect(migrateDatabase(upgradePool, targetMigrations)).resolves.toMatchObject({
        newlyAppliedIds: [
          "0014_recorded_interaction_fixtures",
          "0015_expand_artifact_tombstone_trigger",
        ],
      });
      await expect(assertMigrationsCurrent(upgradePool, targetMigrations)).resolves.toBeUndefined();

      const tableSecurity = await upgradePool.query<{
        readonly policy_count: number;
        readonly public_dml_grant: boolean;
        readonly relforcerowsecurity: boolean;
        readonly relname: string;
        readonly relrowsecurity: boolean;
      }>(
        `
          SELECT
            relation.relname,
            relation.relrowsecurity,
            relation.relforcerowsecurity,
            (
              SELECT count(*)::integer
              FROM pg_policies AS policy
              WHERE policy.schemaname = namespace.nspname
                AND policy.tablename = relation.relname
            ) AS policy_count,
            EXISTS (
              SELECT 1
              FROM information_schema.table_privileges AS privilege
              WHERE privilege.table_schema = namespace.nspname
                AND privilege.table_name = relation.relname
                AND privilege.grantee = 'PUBLIC'
                AND privilege.privilege_type = ANY (ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
            ) AS public_dml_grant
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY($1::text[])
          ORDER BY relation.relname
        `,
        [NEW_TABLES],
      );
      expect(tableSecurity.rows.map(({ relname }) => relname)).toEqual(NEW_TABLES);
      expect(
        tableSecurity.rows.every(
          ({ policy_count, public_dml_grant, relforcerowsecurity, relrowsecurity }) =>
            policy_count === 2 && !public_dml_grant && relforcerowsecurity && relrowsecurity,
        ),
      ).toBe(true);

      const functionSecurity = await upgradePool.query<{
        readonly proconfig: readonly string[];
        readonly proname: string;
        readonly prosecdef: boolean;
        readonly public_execute: boolean;
      }>(`
        SELECT
          procedure.proname,
          procedure.prosecdef,
          procedure.proconfig,
          EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS privilege
            WHERE privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
          ) AS public_execute
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname = ANY (ARRAY[
            'proofstack_guard_interaction_fixture_ownership',
            'proofstack_guard_interaction_fixture_tombstone',
            'proofstack_verify_interaction_fixture_revocation',
            'proofstack_verify_recorded_interaction_fixture'
          ])
        ORDER BY procedure.proname
      `);
      expect(functionSecurity.rows).toHaveLength(4);
      expect(
        functionSecurity.rows.every(
          ({ proconfig, prosecdef, public_execute }) =>
            !prosecdef && !public_execute && proconfig[0] === "search_path=pg_catalog",
        ),
      ).toBe(true);

      await controlPool.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
      roleCreated = true;
      await upgradePool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
      await upgradePool.query(
        `GRANT SELECT, INSERT ON TABLE public.proofstack_regression_fixtures, public.proofstack_regression_fixture_versions, public.proofstack_regression_fixture_events, ${NEW_TABLES.map((table) => `public.${table}`).join(", ")} TO "${runtimeRole}"`,
      );
      await upgradePool.query(
        `GRANT SELECT, INSERT, UPDATE ON TABLE public.proofstack_artifact_catalog TO "${runtimeRole}"`,
      );
      await upgradePool.query(
        `GRANT SELECT, INSERT ON TABLE public.proofstack_artifact_tombstones TO "${runtimeRole}"`,
      );
      await upgradePool.query(
        `GRANT EXECUTE ON FUNCTION public.proofstack_valid_regression_text(text, integer) TO "${runtimeRole}"`,
      );

      await asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
        await client.query(
          `
            INSERT INTO public.proofstack_regression_fixtures (
              tenant_id,
              project_id,
              environment_id,
              fixture_id,
              root_fixture_version_id,
              root_definition_sha256
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [tenantId, projectId, environmentId, fixtureId, predecessorVersionId, predecessorDigest],
        );
        await insertVersion(client, {
          definitionDigest: predecessorDigest,
          eventId: `evt_evidence_${runKey}`,
          name: "Evidence-only predecessor",
          predecessorDigest: null,
          predecessorVersionId: null,
          replayability: "evidence_only",
          schemaVersion: "0.1",
          versionId: predecessorVersionId,
        });

        for (const binding of capture().artifacts) {
          const reference = binding.contentReference;
          await client.query(
            `
              INSERT INTO public.proofstack_artifact_catalog (
                tenant_id,
                project_id,
                environment_id,
                artifact_id,
                schema_version,
                state,
                classification,
                media_type,
                content_sha256,
                content_size_bytes,
                redaction,
                retention_mode,
                expires_at,
                created_at,
                available_at,
                tombstoned_at,
                purged_at,
                created_by_principal_id,
                object_key,
                encryption_version,
                content_nonce,
                wrapped_key_algorithm,
                wrapped_key_id,
                wrapped_key_ciphertext,
                wrapped_key_nonce,
                wrapped_key_tag,
                object_receipt_sha256,
                object_receipt_size_bytes
              ) VALUES (
                $1, $2, $3, $4, '0.1', 'available', $5, $6, $7, $8, $9, 'retain', NULL,
                '2026-08-29T09:00:00.000Z', '2026-08-29T09:00:01.000Z', NULL, NULL, $10,
                $11, 'a256gcm-v1', 'AAAAAAAAAAAAAAAA', 'A256GCM', 'key_interaction',
                'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCC',
                'DDDDDDDDDDDDDDDDDDDDDD', $12, $13
              )
            `,
            [
              tenantId,
              projectId,
              environmentId,
              reference.artifactId,
              reference.classification,
              reference.mediaType,
              reference.sha256,
              reference.sizeBytes,
              binding.redaction,
              principalId,
              `${tenantId}/${reference.artifactId}`,
              "e".repeat(64),
              reference.sizeBytes + 20,
            ],
          );
        }
        return client.query("SELECT 1");
      });

      const incompleteVersionId = `fiv_incomplete_${runKey}`;
      await expect(
        asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
          await insertVersion(client, {
            definitionDigest: "a".repeat(64),
            eventId: `evt_incomplete_${runKey}`,
            name: "Incomplete recorded fixture",
            predecessorDigest,
            predecessorVersionId,
            replayability: "recorded_interactions",
            schemaVersion: "0.2",
            versionId: incompleteVersionId,
          });
          await insertRecordedCompanion(client, incompleteVersionId, capture());
          return client.query("SELECT 1");
        }),
      ).rejects.toMatchObject({ code: "23514" });

      const mismatchedVersionId = `fiv_mismatch_${runKey}`;
      const manifest = capture();
      const firstArtifact = manifest.artifacts[0];
      const secondArtifact = manifest.artifacts[1];
      if (!firstArtifact || !secondArtifact)
        throw new Error("The interaction vector is incomplete");
      await expect(
        asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
          await insertVersion(client, {
            definitionDigest: "b".repeat(64),
            eventId: `evt_mismatch_${runKey}`,
            name: "Mismatched recorded fixture",
            predecessorDigest,
            predecessorVersionId,
            replayability: "recorded_interactions",
            schemaVersion: "0.2",
            versionId: mismatchedVersionId,
          });
          await insertRecordedCompanion(client, mismatchedVersionId, manifest);
          await insertOwnership(
            client,
            mismatchedVersionId,
            0,
            secondArtifact.contentReference.artifactId,
          );
          return client.query("SELECT 1");
        }),
      ).rejects.toMatchObject({ code: "23514" });

      await asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
        await insertVersion(client, {
          definitionDigest: recordedDigest,
          eventId: `evt_recorded_${runKey}`,
          name: "Recorded interaction fixture",
          predecessorDigest,
          predecessorVersionId,
          replayability: "recorded_interactions",
          schemaVersion: "0.2",
          versionId: recordedVersionId,
        });
        await insertRecordedCompanion(client, recordedVersionId, manifest);
        for (const [position, binding] of manifest.artifacts.entries()) {
          await insertOwnership(
            client,
            recordedVersionId,
            position,
            binding.contentReference.artifactId,
          );
        }
        return client.query("SELECT 1");
      });

      const otherTenantRead = await asRuntime(upgradePool, runtimeRole, otherTenantId, (client) =>
        client.query<{ readonly count: number }>(`
            SELECT count(*)::integer AS count
            FROM public.proofstack_recorded_interaction_fixture_versions
          `),
      );
      expect(otherTenantRead.rows).toEqual([{ count: 0 }]);

      await expect(
        asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
          await client.query(
            `
              INSERT INTO public.proofstack_artifact_tombstones (
                tenant_id,
                artifact_id,
                tombstone_id,
                actor_principal_id,
                tombstone_trigger,
                reason,
                occurred_at
              ) VALUES ($1, $2, $3, $4, 'manual', 'Manual removal', $5)
            `,
            [
              tenantId,
              firstArtifact.contentReference.artifactId,
              `del_manual_${runKey}`,
              principalId,
              revocationTime,
            ],
          );
          return client.query(
            `
              UPDATE public.proofstack_artifact_catalog
              SET state = 'tombstoned', tombstoned_at = $3
              WHERE tenant_id = $1 AND artifact_id = $2
            `,
            [tenantId, firstArtifact.contentReference.artifactId, revocationTime],
          );
        }),
      ).rejects.toMatchObject({ code: "55000" });

      await expect(
        asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
          await client.query(
            `
              INSERT INTO public.proofstack_interaction_fixture_content_revocations (
                tenant_id,
                project_id,
                environment_id,
                fixture_id,
                fixture_version_id,
                revocation_id,
                schema_version,
                reason,
                revoked_at,
                revoked_at_lexical,
                revoked_by_principal_id
              ) VALUES (
                $1, $2, $3, $4, $5, $6, '0.1', $7, $8::timestamptz, $9::text, $10
              )
            `,
            [
              tenantId,
              projectId,
              environmentId,
              fixtureId,
              recordedVersionId,
              `rev_partial_${runKey}`,
              revocationReason,
              revocationTime,
              revocationTime,
              principalId,
            ],
          );
          await client.query(
            `
              INSERT INTO public.proofstack_artifact_tombstones (
                tenant_id,
                artifact_id,
                tombstone_id,
                actor_principal_id,
                tombstone_trigger,
                reason,
                occurred_at
              ) VALUES ($1, $2, $3, $4, 'fixture_revocation', $5, $6)
            `,
            [
              tenantId,
              firstArtifact.contentReference.artifactId,
              `del_partial_${runKey}`,
              principalId,
              revocationReason,
              revocationTime,
            ],
          );
          return client.query(
            `
              UPDATE public.proofstack_artifact_catalog
              SET state = 'tombstoned', tombstoned_at = $3
              WHERE tenant_id = $1 AND artifact_id = $2
            `,
            [tenantId, firstArtifact.contentReference.artifactId, revocationTime],
          );
        }),
      ).rejects.toMatchObject({ code: "23514" });

      await asRuntime(upgradePool, runtimeRole, tenantId, async (client) => {
        await client.query(
          `
            INSERT INTO public.proofstack_interaction_fixture_content_revocations (
              tenant_id,
              project_id,
              environment_id,
              fixture_id,
              fixture_version_id,
              revocation_id,
              schema_version,
              reason,
              revoked_at,
              revoked_at_lexical,
              revoked_by_principal_id
            ) VALUES (
              $1, $2, $3, $4, $5, $6, '0.1', $7, $8::timestamptz, $9::text, $10
            )
          `,
          [
            tenantId,
            projectId,
            environmentId,
            fixtureId,
            recordedVersionId,
            `rev_complete_${runKey}`,
            revocationReason,
            revocationTime,
            revocationTime,
            principalId,
          ],
        );
        for (const [position, binding] of manifest.artifacts.entries()) {
          const artifactId = binding.contentReference.artifactId;
          await client.query(
            `
              INSERT INTO public.proofstack_artifact_tombstones (
                tenant_id,
                artifact_id,
                tombstone_id,
                actor_principal_id,
                tombstone_trigger,
                reason,
                occurred_at
              ) VALUES ($1, $2, $3, $4, 'fixture_revocation', $5, $6)
            `,
            [
              tenantId,
              artifactId,
              `del_fixture_${position}_${runKey}`,
              principalId,
              revocationReason,
              revocationTime,
            ],
          );
          await client.query(
            `
              UPDATE public.proofstack_artifact_catalog
              SET state = 'tombstoned', tombstoned_at = $3
              WHERE tenant_id = $1 AND artifact_id = $2
            `,
            [tenantId, artifactId, revocationTime],
          );
        }
        return client.query("SELECT 1");
      });

      const finalState = await asRuntime(upgradePool, runtimeRole, tenantId, (client) =>
        client.query<{
          readonly ownership_count: number;
          readonly revocation_count: number;
          readonly tombstoned_count: number;
        }>(
          `
              SELECT
                (
                  SELECT count(*)::integer
                  FROM public.proofstack_interaction_fixture_artifact_ownerships
                  WHERE fixture_version_id = $1
                ) AS ownership_count,
                (
                  SELECT count(*)::integer
                  FROM public.proofstack_interaction_fixture_content_revocations
                  WHERE fixture_version_id = $1
                ) AS revocation_count,
                (
                  SELECT count(*)::integer
                  FROM public.proofstack_artifact_catalog
                  WHERE state = 'tombstoned'
                ) AS tombstoned_count
            `,
          [recordedVersionId],
        ),
      );
      expect(finalState.rows).toEqual([
        {
          ownership_count: manifest.artifacts.length,
          revocation_count: 1,
          tombstoned_count: manifest.artifacts.length,
        },
      ]);

      await upgradePool.query(
        `GRANT UPDATE, DELETE ON TABLE ${NEW_TABLES.map((table) => `public.${table}`).join(", ")} TO "${runtimeRole}"`,
      );
      for (const table of NEW_TABLES) {
        const stored = await upgradePool.query<{ readonly count: number }>(
          `SELECT count(*)::integer AS count FROM public.${table} WHERE tenant_id = $1`,
          [tenantId],
        );
        expect(stored.rows[0]?.count).toBeGreaterThan(0);

        const runtimeUpdate = await asRuntime(upgradePool, runtimeRole, tenantId, (client) =>
          client.query(`UPDATE public.${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, [
            tenantId,
          ]),
        );
        expect(runtimeUpdate.rowCount).toBe(0);
        const runtimeDelete = await asRuntime(upgradePool, runtimeRole, tenantId, (client) =>
          client.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [tenantId]),
        );
        expect(runtimeDelete.rowCount).toBe(0);

        await expect(
          upgradePool.query(
            `UPDATE public.${table} SET tenant_id = tenant_id WHERE tenant_id = $1`,
            [tenantId],
          ),
        ).rejects.toMatchObject({ code: "55000" });
        await expect(
          upgradePool.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [tenantId]),
        ).rejects.toMatchObject({ code: "55000" });
      }

      await expect(migrateDatabase(upgradePool, targetMigrations)).resolves.toMatchObject({
        newlyAppliedIds: [],
      });
    } finally {
      await upgradePool?.end();
      await controlPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      if (roleCreated) await controlPool.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await controlPool.end();
    }
  });
});
