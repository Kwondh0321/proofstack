import {
  type JsonObject,
  JsonValueSchema,
  OpaqueIdSchema,
  TimestampSchema,
} from "@proofstack/contracts";
import {
  REGRESSION_DATASET_VERSION_AGGREGATE_TYPE,
  REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
  REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
  REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
  REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
  type RegressionVersionPublishedOutboxIntent,
} from "@proofstack/datasets";
import {
  regressionVersionRepositoryConformanceCases,
  type RegressionVersionPublicationKind,
} from "@proofstack/datasets/testing";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresRegressionVersionRepository } from "./postgres-regression-version-repository.js";
import {
  provisionRuntimeRoles,
  type RuntimeRoleCredentials,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = `${process.pid}_${Date.now()}`;
const credentials = {
  api: {
    name: `proofstack_regression_api_${runKey}`,
    password: `proofstack-regression-api-${runKey}-password`,
  },
  artifact: {
    name: `proofstack_regression_art_${runKey}`,
    password: `proofstack-regression-artifact-${runKey}-password`,
  },
  consumer: {
    name: `proofstack_regression_con_${runKey}`,
    password: `proofstack-regression-consumer-${runKey}-password`,
  },
  identity: {
    name: `proofstack_regression_id_${runKey}`,
    password: `proofstack-regression-identity-${runKey}-password`,
  },
  publisher: {
    name: `proofstack_regression_pub_${runKey}`,
    password: `proofstack-regression-publisher-${runKey}-password`,
  },
} as const satisfies RuntimeRoleProvisioningOptions;

const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const runtimePool = new Pool({
  connectionString: connectionStringFor(credentials.api),
  max: 12,
});

interface StoredIntentRow extends QueryResultRow {
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly created_at: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly schema_version: string;
  readonly tenant_id: string;
}

interface PublicationIntentStatusRow extends QueryResultRow {
  readonly status: string;
}

interface PublicationIntentProbe {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly createdAt: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly schemaVersion: string;
  readonly tenantId: string;
}

function connectionStringFor(role: RuntimeRoleCredentials): string {
  const url = new URL(databaseUrl as string);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

function isJsonObject(input: unknown): input is JsonObject {
  const parsed = JsonValueSchema.safeParse(input);
  return (
    parsed.success &&
    typeof parsed.data === "object" &&
    parsed.data !== null &&
    !Array.isArray(parsed.data)
  );
}

function intentFromRow(row: StoredIntentRow): RegressionVersionPublishedOutboxIntent {
  if (
    !OpaqueIdSchema.safeParse(row.tenant_id).success ||
    !OpaqueIdSchema.safeParse(row.aggregate_id).success ||
    row.schema_version !== REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION ||
    !TimestampSchema.safeParse(row.created_at).success ||
    !isJsonObject(row.payload)
  ) {
    throw new Error("Stored regression publication intent is invalid");
  }

  if (
    row.event_type === REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE &&
    row.aggregate_type === REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE
  ) {
    return {
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      createdAt: row.created_at,
      eventType: row.event_type,
      payload: row.payload,
      schemaVersion: row.schema_version,
      tenantId: row.tenant_id,
    } as RegressionVersionPublishedOutboxIntent;
  }
  if (
    row.event_type === REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE &&
    row.aggregate_type === REGRESSION_DATASET_VERSION_AGGREGATE_TYPE
  ) {
    return {
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      createdAt: row.created_at,
      eventType: row.event_type,
      payload: row.payload,
      schemaVersion: row.schema_version,
      tenantId: row.tenant_id,
    } as RegressionVersionPublishedOutboxIntent;
  }
  throw new Error("Stored regression publication intent has an invalid type pair");
}

class FaultInjectingRegressionPool implements Pick<Pool, "connect"> {
  private readonly pendingFailures = new Set<RegressionVersionPublicationKind>();

  constructor(private readonly pool: Pool) {}

  async connect(): Promise<PoolClient> {
    const client = await this.pool.connect();
    const pendingFailures = this.pendingFailures;
    return new Proxy(client, {
      get(target, property) {
        if (property === "query") {
          return async (...arguments_: unknown[]) => {
            const statement = arguments_[0];
            const values = arguments_[1];
            if (
              typeof statement === "string" &&
              statement.includes("INSERT INTO public.proofstack_outbox") &&
              Array.isArray(values)
            ) {
              const eventType = values[1];
              const kind =
                eventType === REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE
                  ? "fixture"
                  : eventType === REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE
                    ? "dataset"
                    : null;
              if (kind && pendingFailures.delete(kind)) {
                throw new Error(`Injected ${kind} regression publication intent failure`);
              }
            }
            const query = target.query.bind(target) as unknown as (
              ...queryArguments: unknown[]
            ) => Promise<unknown>;
            return query(...arguments_);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  failNextPublicationIntent(kind: RegressionVersionPublicationKind): void {
    this.pendingFailures.add(kind);
  }

  clearPublicationIntentFailures(): void {
    this.pendingFailures.clear();
  }
}

const faultPool = new FaultInjectingRegressionPool(runtimePool);
const repository = new PostgresRegressionVersionRepository(faultPool);

async function publishedIntents(
  tenantId: string,
): Promise<readonly RegressionVersionPublishedOutboxIntent[]> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<StoredIntentRow>(
      `
        SELECT
          tenant_id,
          event_type,
          aggregate_type,
          aggregate_id,
          schema_version,
          payload,
          to_char(
            created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS created_at
        FROM public.proofstack_outbox
        WHERE tenant_id = $1
          AND event_type = ANY($2::varchar[])
        ORDER BY
          event_type COLLATE "C",
          aggregate_type COLLATE "C",
          aggregate_id COLLATE "C"
      `,
      [
        tenantId,
        [
          REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
          REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
        ],
      ],
    );
    await client.query("COMMIT");
    return result.rows.map(intentFromRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function publicationIntentStatus(
  currentTenantId: string,
  expected: PublicationIntentProbe,
  expectedCreatedAt: string | null = expected.createdAt,
): Promise<string> {
  const client = await runtimePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [currentTenantId]);
    const result = await client.query<PublicationIntentStatusRow>(
      `
        SELECT public.proofstack_regression_publication_intent_status(
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          $7::timestamptz
        ) AS status
      `,
      [
        expected.tenantId,
        expected.eventType,
        expected.aggregateType,
        expected.aggregateId,
        expected.schemaVersion,
        JSON.stringify(expected.payload),
        expectedCreatedAt,
      ],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || typeof row.status !== "string") {
      throw new Error("PostgreSQL returned an invalid publication intent status");
    }
    return row.status;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertIntentProbes(probes: readonly PublicationIntentProbe[]): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    for (const probe of probes) {
      await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [probe.tenantId]);
      await client.query(
        `
          INSERT INTO public.proofstack_outbox (
            tenant_id,
            event_type,
            aggregate_type,
            aggregate_id,
            schema_version,
            payload,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
        `,
        [
          probe.tenantId,
          probe.eventType,
          probe.aggregateType,
          probe.aggregateId,
          probe.schemaVersion,
          JSON.stringify(probe.payload),
          probe.createdAt,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resetRegressionCatalog(): Promise<void> {
  await adminPool.query(`
    TRUNCATE TABLE
      public.proofstack_interaction_fixture_content_revocations,
      public.proofstack_interaction_fixture_artifact_ownerships,
      public.proofstack_recorded_interaction_fixture_versions,
      public.proofstack_regression_dataset_members,
      public.proofstack_regression_dataset_versions,
      public.proofstack_regression_datasets,
      public.proofstack_regression_fixture_events,
      public.proofstack_regression_fixture_versions,
      public.proofstack_regression_fixtures,
      public.proofstack_outbox
    RESTART IDENTITY CASCADE
  `);
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, credentials);
});

beforeEach(async () => {
  faultPool.clearPublicationIntentFailures();
  await resetRegressionCatalog();
});

afterAll(async () => {
  await runtimePool.end();
  for (const role of Object.values(credentials)) {
    const exists = await adminPool.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [role.name],
    );
    if (exists.rows[0]?.present) {
      await adminPool.query(`DROP OWNED BY "${role.name}"`);
      await adminPool.query(`DROP ROLE "${role.name}"`);
    }
  }
  await adminPool.end();
});

describe("PostgresRegressionVersionRepository contract", () => {
  for (const testCase of regressionVersionRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => ({
        failNextPublicationIntent: (kind) => faultPool.failNextPublicationIntent(kind),
        publishedIntents,
        repository,
      }));
    });
  }

  it("keeps the regression intent oracle narrow while direct outbox reads remain denied", async () => {
    const canonical: PublicationIntentProbe = {
      aggregateId: "fixv_status_probe",
      aggregateType: REGRESSION_FIXTURE_VERSION_AGGREGATE_TYPE,
      createdAt: "2026-08-29T02:00:00.000Z",
      eventType: REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
      payload: {
        definitionSha256: "a".repeat(64),
        environmentId: "env_status_probe",
        fixtureId: "fix_status_probe",
        fixtureVersionId: "fixv_status_probe",
        projectId: "prj_status_probe",
      },
      schemaVersion: REGRESSION_PUBLICATION_OUTBOX_SCHEMA_VERSION,
      tenantId: "ten_status_probe",
    };
    const evidence: PublicationIntentProbe = {
      aggregateId: "evt_status_probe",
      aggregateType: "evidence",
      createdAt: "2026-08-29T02:01:00.000Z",
      eventType: "evidence.appended",
      payload: { eventId: "evt_status_probe" },
      schemaVersion: "0.1",
      tenantId: canonical.tenantId,
    };
    await insertIntentProbes([canonical, evidence]);

    await expect(publicationIntentStatus(canonical.tenantId, canonical)).resolves.toBe("canonical");
    await expect(publicationIntentStatus(evidence.tenantId, evidence)).resolves.toBe("absent");
    await expect(publicationIntentStatus("ten_status_other", canonical)).resolves.toBe("absent");
    await expect(publicationIntentStatus(canonical.tenantId, canonical, null)).resolves.toBe(
      "absent",
    );
    await expect(publicationIntentStatus(canonical.tenantId, canonical, "infinity")).resolves.toBe(
      "absent",
    );
    await expect(
      publicationIntentStatus(canonical.tenantId, {
        ...canonical,
        payload: { ...canonical.payload, unexpected: "field" },
      }),
    ).resolves.toBe("absent");
    await expect(
      publicationIntentStatus(canonical.tenantId, {
        ...canonical,
        aggregateId: "fixv_status_mismatch",
      }),
    ).resolves.toBe("absent");
    await expect(
      publicationIntentStatus(canonical.tenantId, {
        ...canonical,
        schemaVersion: "1.0",
      }),
    ).resolves.toBe("absent");
    await expect(
      publicationIntentStatus(canonical.tenantId, {
        ...canonical,
        payload: { ...canonical.payload, fixtureId: 42 },
      }),
    ).resolves.toBe("absent");

    const client = await runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [
        canonical.tenantId,
      ]);
      await expect(
        client.query("SELECT aggregate_id FROM public.proofstack_outbox WHERE tenant_id = $1", [
          canonical.tenantId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
