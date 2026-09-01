import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { loadBundledMigrations } from "./migrations.js";
import {
  DEFAULT_RUNTIME_ROLE_NAMES,
  provisionRuntimeRoles,
  RuntimeRoleProvisioningError,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";

const bundledMigrations = await loadBundledMigrations();

interface RoleRow {
  readonly has_memberships: boolean;
  readonly marker: string | null;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
  readonly rolsuper: boolean;
}

class FakeClient {
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  readonly releaseArguments: Array<boolean | undefined> = [];
  readonly roles = new Map<string, RoleRow>();
  appliedMigrations = bundledMigrations.map(({ checksum, id }) => ({ checksum, id }));
  failOn?: string;
  failRollback = false;
  migrationLedgerPresent = true;
  schemaPresent = true;
  suppressFormattedStatement = false;

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values ? { values } : {}) });
    if (text === "ROLLBACK" && this.failRollback) throw new Error("rollback failed");
    if (this.failOn && text.includes(this.failOn)) throw new Error(`failed: ${this.failOn}`);
    if (text.includes("every(to_regclass")) return { rows: [{ present: this.schemaPresent }] };
    if (text.includes("to_regclass('public.proofstack_schema_migrations')")) {
      return {
        rows: [{ ledger: this.migrationLedgerPresent ? "proofstack_schema_migrations" : null }],
      };
    }
    if (text.startsWith("SELECT id, checksum")) return { rows: this.appliedMigrations };
    if (text.includes("FROM pg_roles")) {
      const row = this.roles.get(String(values?.[0]));
      return { rows: row ? [row] : [] };
    }
    if (text.includes("SELECT format(")) {
      if (this.suppressFormattedStatement) return { rows: [] };
      const operation = text.includes("'ALTER ROLE") ? "ALTER" : "CREATE";
      return { rows: [{ statement: `${operation} ROLE formatted_safely` }] };
    }
    return { rows: [] };
  }

  release(argument?: boolean): void {
    this.releaseArguments.push(argument);
  }
}

function poolWith(client: FakeClient, connections = { count: 0 }): Pick<Pool, "connect"> {
  return {
    connect: async () => {
      connections.count += 1;
      return client;
    },
  } as unknown as Pick<Pool, "connect">;
}

function options(overrides: Partial<RuntimeRoleProvisioningOptions> = {}) {
  return {
    api: { name: DEFAULT_RUNTIME_ROLE_NAMES.api, password: "local-api-password" },
    artifact: {
      name: DEFAULT_RUNTIME_ROLE_NAMES.artifact,
      password: "local-artifact-password",
    },
    consumer: {
      name: DEFAULT_RUNTIME_ROLE_NAMES.consumer,
      password: "local-consumer-password",
    },
    evaluationWorker: {
      name: DEFAULT_RUNTIME_ROLE_NAMES.evaluationWorker,
      password: "local-evaluation-worker-password",
    },
    humanReviewer: {
      name: DEFAULT_RUNTIME_ROLE_NAMES.humanReviewer,
      password: "local-human-reviewer-password",
    },
    identity: {
      name: DEFAULT_RUNTIME_ROLE_NAMES.identity,
      password: "local-identity-password",
    },
    modelEvaluationWorker: {
      name: DEFAULT_RUNTIME_ROLE_NAMES.modelEvaluationWorker,
      password: "local-model-evaluation-worker-password",
    },
    publisher: {
      name: DEFAULT_RUNTIME_ROLE_NAMES.publisher,
      password: "local-publisher-password",
    },
    replayWorker: {
      name: DEFAULT_RUNTIME_ROLE_NAMES.replayWorker,
      password: "local-replay-worker-password",
    },
    ...overrides,
  };
}

function managedRole(
  kind:
    | "api"
    | "artifact"
    | "consumer"
    | "evaluationWorker"
    | "humanReviewer"
    | "identity"
    | "modelEvaluationWorker"
    | "publisher"
    | "replayWorker",
  overrides: Partial<RoleRow> = {},
): RoleRow {
  return {
    has_memberships: false,
    marker: `proofstack-managed-runtime-role:v1:${kind}`,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolsuper: false,
    ...overrides,
  };
}

describe("provisionRuntimeRoles", () => {
  it("creates marked roles and replaces their platform grants atomically", async () => {
    const client = new FakeClient();

    await expect(provisionRuntimeRoles(poolWith(client), options())).resolves.toEqual({
      createdRoles: [
        "proofstack_api",
        "proofstack_identity",
        "proofstack_evaluation_worker",
        "proofstack_model_evaluation_worker",
        "proofstack_human_reviewer",
        "proofstack_replay_worker",
        "proofstack_artifact_maintenance",
        "proofstack_publisher",
        "proofstack_consumer",
      ],
      updatedRoles: [],
    });
    const statements = client.queries.map(({ text }) => text.trim());
    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    expect(
      statements.some(
        (statement) =>
          statement.startsWith("REVOKE ALL PRIVILEGES ON FUNCTION") &&
          statement.endsWith("FROM PUBLIC"),
      ),
    ).toBe(true);
    expect(statements).toContain(
      "COMMENT ON ROLE \"proofstack_api\" IS 'proofstack-managed-runtime-role:v1:api'",
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.proofstack_evidence_events TO "proofstack_api"',
    );
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.proofstack_find_active_api_key(text) TO "proofstack_identity"',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.proofstack_find_and_touch_active_browser_session(text) TO "proofstack_identity"',
    );
    const identityTableRevocation = statements.find(
      (statement) =>
        statement.startsWith("REVOKE ALL PRIVILEGES ON TABLE") &&
        statement.endsWith('FROM "proofstack_identity"'),
    );
    expect(identityTableRevocation).toBeDefined();
    for (const table of [
      "proofstack_api_key_credentials",
      "proofstack_replay_jobs",
      "proofstack_replay_attempts",
      "proofstack_replay_attempt_events",
      "proofstack_replay_budget_entries",
      "proofstack_replay_budget_entry_dimensions",
      "proofstack_replay_cancellation_requests",
      "proofstack_replay_cancellation_acknowledgements",
      "proofstack_replay_observations",
      "proofstack_replay_usage_measurements",
      "proofstack_target_releases",
    ]) {
      expect(identityTableRevocation).toContain(`public.${table}`);
    }
    expect(
      statements.some(
        (statement) =>
          statement.startsWith("REVOKE ALL PRIVILEGES ON FUNCTION") &&
          statement.endsWith('FROM "proofstack_identity"'),
      ),
    ).toBe(true);
    expect(statements).toContain(
      'GRANT SELECT, UPDATE ON TABLE public.proofstack_outbox TO "proofstack_publisher"',
    );
    expect(statements).toContain(
      'GRANT SELECT ON TABLE public.proofstack_schema_migrations TO "proofstack_replay_worker"',
    );
    expect(
      statements.filter((statement) =>
        statement.endsWith('TO "proofstack_model_evaluation_worker"'),
      ),
    ).toEqual([
      'GRANT USAGE ON SCHEMA public TO "proofstack_model_evaluation_worker"',
      'GRANT SELECT ON TABLE public.proofstack_schema_migrations TO "proofstack_model_evaluation_worker"',
      'GRANT SELECT ON TABLE public.proofstack_evaluation_record_registry, public.proofstack_evaluation_resource_bindings, public.proofstack_evaluation_lineage, public.proofstack_evaluation_unique_bindings, public.proofstack_evaluation_records TO "proofstack_model_evaluation_worker"',
      'GRANT SELECT ON TABLE public.proofstack_model_assurance_records TO "proofstack_model_evaluation_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_publish_model_assurance_execution_record(jsonb) TO "proofstack_model_evaluation_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_evaluation_intent_status(text, text, text, text, jsonb, timestamp with time zone) TO "proofstack_model_evaluation_worker"',
    ]);
    expect(
      statements.filter((statement) => statement.endsWith('TO "proofstack_human_reviewer"')),
    ).toEqual([
      'GRANT USAGE ON SCHEMA public TO "proofstack_human_reviewer"',
      'GRANT SELECT ON TABLE public.proofstack_schema_migrations TO "proofstack_human_reviewer"',
      'GRANT SELECT ON TABLE public.proofstack_evaluation_record_registry, public.proofstack_evaluation_resource_bindings, public.proofstack_evaluation_lineage, public.proofstack_evaluation_unique_bindings, public.proofstack_evaluation_records TO "proofstack_human_reviewer"',
      'GRANT SELECT ON TABLE public.proofstack_model_assurance_records TO "proofstack_human_reviewer"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_publish_model_assurance_human_review_record(jsonb) TO "proofstack_human_reviewer"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_evaluation_intent_status(text, text, text, text, jsonb, timestamp with time zone) TO "proofstack_human_reviewer"',
    ]);
    expect(
      statements.filter((statement) => statement.endsWith('TO "proofstack_replay_worker"')),
    ).toEqual([
      'GRANT USAGE ON SCHEMA public TO "proofstack_replay_worker"',
      'GRANT SELECT ON TABLE public.proofstack_schema_migrations TO "proofstack_replay_worker"',
      'GRANT SELECT ON TABLE public.proofstack_replay_targets, public.proofstack_target_releases, public.proofstack_replay_plan_resources, public.proofstack_replay_plans, public.proofstack_replay_plan_budgets, public.proofstack_replay_plan_boundaries TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_acknowledge_replay_cancellation(text, text, text, text, text, text, bigint, bigint, text, text) TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_append_replay_execution_observation(text, text, text, text, text, text, bigint, bigint, text, jsonb) TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_append_replay_usage_observation(text, text, text, text, text, text, bigint, bigint, text, text, text, jsonb) TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_claim_replay_job(text, text, text, text, text, text, text, text, text, bigint) TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_complete_replay_job(text, text, text, text, text, text, bigint, bigint, text, text, jsonb, jsonb) TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_heartbeat_replay_job(text, text, text, text, text, text, bigint, bigint, bigint) TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_read_replay_job_snapshot(text, text, text) TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_reconcile_replay_budget(text, text, text, text, text, text, bigint, bigint, text, text, jsonb) TO "proofstack_replay_worker"',
      'GRANT EXECUTE ON FUNCTION public.proofstack_reserve_replay_budget(text, text, text, text, text, text, bigint, bigint, text, jsonb, jsonb) TO "proofstack_replay_worker"',
    ]);
    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.proofstack_artifact_catalog TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.proofstack_artifact_tombstones TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.proofstack_artifact_purge_receipts TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.proofstack_regression_fixtures, public.proofstack_regression_fixture_versions, public.proofstack_regression_fixture_events, public.proofstack_regression_datasets, public.proofstack_regression_dataset_versions, public.proofstack_regression_dataset_members TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.proofstack_recorded_interaction_fixture_versions, public.proofstack_interaction_fixture_artifact_ownerships, public.proofstack_interaction_fixture_content_revocations TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.proofstack_replay_targets, public.proofstack_target_releases, public.proofstack_replay_plan_resources, public.proofstack_replay_plans, public.proofstack_replay_plan_budgets, public.proofstack_replay_plan_boundaries TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT SELECT ON TABLE public.proofstack_replay_jobs, public.proofstack_replay_attempts, public.proofstack_replay_cancellation_requests, public.proofstack_replay_cancellation_acknowledgements, public.proofstack_replay_budget_entries, public.proofstack_replay_budget_entry_dimensions, public.proofstack_replay_observations, public.proofstack_replay_usage_measurements TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.proofstack_create_replay_job(text, text, text, text, text, text, text) TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.proofstack_request_replay_cancellation(text, text, text, text, text, text, text) TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.proofstack_read_replay_job_snapshot(text, text, text) TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.proofstack_valid_regression_text(text, integer) TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.proofstack_regression_publication_intent_status(text, text, text, text, text, jsonb, timestamptz) TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.proofstack_replay_publication_intent_status(text, text, text, text, text, jsonb, timestamptz) TO "proofstack_api"',
    );
    expect(statements).toContain(
      'GRANT SELECT, UPDATE ON TABLE public.proofstack_artifact_catalog TO "proofstack_artifact_maintenance"',
    );
    expect(statements).toContain(
      'GRANT SELECT ON TABLE public.proofstack_interaction_fixture_artifact_ownerships, public.proofstack_interaction_fixture_content_revocations TO "proofstack_artifact_maintenance"',
    );
    expect(statements).not.toContain(
      'GRANT INSERT, UPDATE, DELETE ON TABLE public.proofstack_interaction_fixture_artifact_ownerships, public.proofstack_interaction_fixture_content_revocations TO "proofstack_artifact_maintenance"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.proofstack_artifact_tombstones TO "proofstack_artifact_maintenance"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.proofstack_artifact_purge_receipts TO "proofstack_artifact_maintenance"',
    );
    expect(statements).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.proofstack_artifact_catalog TO "proofstack_artifact_maintenance"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.proofstack_consumer_receipts TO "proofstack_consumer"',
    );
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("rotates existing marked role passwords without recreating roles", async () => {
    const client = new FakeClient();
    client.roles.set("proofstack_api", managedRole("api"));
    client.roles.set("proofstack_artifact_maintenance", managedRole("artifact"));
    client.roles.set("proofstack_identity", managedRole("identity"));
    client.roles.set("proofstack_publisher", managedRole("publisher"));
    client.roles.set("proofstack_consumer", managedRole("consumer"));
    client.roles.set("proofstack_evaluation_worker", managedRole("evaluationWorker"));
    client.roles.set("proofstack_human_reviewer", managedRole("humanReviewer"));
    client.roles.set("proofstack_model_evaluation_worker", managedRole("modelEvaluationWorker"));
    client.roles.set("proofstack_replay_worker", managedRole("replayWorker"));

    await expect(provisionRuntimeRoles(poolWith(client), options())).resolves.toEqual({
      createdRoles: [],
      updatedRoles: [
        "proofstack_api",
        "proofstack_identity",
        "proofstack_evaluation_worker",
        "proofstack_model_evaluation_worker",
        "proofstack_human_reviewer",
        "proofstack_replay_worker",
        "proofstack_artifact_maintenance",
        "proofstack_publisher",
        "proofstack_consumer",
      ],
    });
    expect(client.queries.filter(({ text }) => text.includes("'ALTER ROLE"))).toHaveLength(9);
    expect(client.queries.some(({ text }) => text.startsWith("COMMENT ON ROLE"))).toBe(false);
  });

  it.each([
    ["superuser", { rolsuper: true }],
    ["database creator", { rolcreatedb: true }],
    ["role creator", { rolcreaterole: true }],
    ["replication", { rolreplication: true }],
    ["RLS bypass", { rolbypassrls: true }],
    ["membership", { has_memberships: true }],
  ])("refuses an existing managed role with %s capability", async (_label, elevated) => {
    const client = new FakeClient();
    client.roles.set("proofstack_api", managedRole("api", elevated));

    await expect(provisionRuntimeRoles(poolWith(client), options())).rejects.toThrow(
      "elevated attributes or memberships",
    );
    expect(client.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
  });

  it("refuses to adopt an unmanaged existing role", async () => {
    const client = new FakeClient();
    client.roles.set("proofstack_api", managedRole("api", { marker: null }));

    await expect(provisionRuntimeRoles(poolWith(client), options())).rejects.toThrow("unmanaged");
  });

  it("requires the durable schema before changing roles", async () => {
    const client = new FakeClient();
    client.schemaPresent = false;

    await expect(provisionRuntimeRoles(poolWith(client), options())).rejects.toThrow(
      "migrations must be current",
    );
    expect(client.queries.some(({ text }) => text.includes("CREATE ROLE"))).toBe(false);
  });

  it("requires every bundled migration before changing roles", async () => {
    const client = new FakeClient();
    client.appliedMigrations = client.appliedMigrations.slice(0, -1);

    await expect(provisionRuntimeRoles(poolWith(client), options())).rejects.toThrow(
      "migrations must be current",
    );
    expect(client.queries.some(({ text }) => text.includes("CREATE ROLE"))).toBe(false);
  });

  it("fails closed when PostgreSQL cannot format a credential statement", async () => {
    const client = new FakeClient();
    client.suppressFormattedStatement = true;

    await expect(provisionRuntimeRoles(poolWith(client), options())).rejects.toThrow(
      "did not format",
    );
  });

  it.each([
    ["invalid name", { name: "INVALID", password: "valid-api-password" }],
    ["short password", { name: "proofstack_api", password: "too-short" }],
    ["long password", { name: "proofstack_api", password: "x".repeat(1_025) }],
    ["NUL password", { name: "proofstack_api", password: "valid-password\0bad" }],
  ])("rejects an %s before connecting", async (_label, api) => {
    const client = new FakeClient();
    const connections = { count: 0 };

    await expect(
      provisionRuntimeRoles(poolWith(client, connections), options({ api })),
    ).rejects.toBeInstanceOf(RuntimeRoleProvisioningError);
    expect(connections.count).toBe(0);
  });

  it("requires distinct role names before connecting", async () => {
    const client = new FakeClient();
    const connections = { count: 0 };

    await expect(
      provisionRuntimeRoles(
        poolWith(client, connections),
        options({
          consumer: { name: "proofstack_api", password: "valid-consumer-password" },
        }),
      ),
    ).rejects.toThrow("must be distinct");
    expect(connections.count).toBe(0);
  });

  it("rolls back an operation failure", async () => {
    const client = new FakeClient();
    client.failOn = "REVOKE CREATE";

    await expect(provisionRuntimeRoles(poolWith(client), options())).rejects.toThrow(
      "REVOKE CREATE",
    );
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("destroys a connection when beginning the transaction fails", async () => {
    const client = new FakeClient();
    client.failOn = "BEGIN";

    await expect(provisionRuntimeRoles(poolWith(client), options())).rejects.toThrow("BEGIN");
    expect(client.releaseArguments).toEqual([true]);
  });

  it("destroys a connection and preserves a rollback failure", async () => {
    const client = new FakeClient();
    client.failOn = "REVOKE CREATE";
    client.failRollback = true;

    await expect(provisionRuntimeRoles(poolWith(client), options())).rejects.toBeInstanceOf(
      PostgresTransactionCleanupError,
    );
    expect(client.releaseArguments).toEqual([true]);
  });
});
