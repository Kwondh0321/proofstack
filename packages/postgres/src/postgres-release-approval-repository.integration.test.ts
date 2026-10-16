import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { encodeReleaseApprovalDefinition, type EvidenceScope } from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  releaseApprovalReference,
} from "@proofstack/core";
import {
  releaseApprovalRepositoryConformanceCases,
  releaseApprovalRepositoryFixture,
  approvalVersion,
  approvalRevocation,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresReleaseApprovalRepository,
  readPostgresReleaseApprovalSubjectOnClient,
} from "./postgres-release-approval-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const repository = new PostgresReleaseApprovalRepository(pool);
const key = randomUUID().replaceAll("-", "").slice(0, 8);
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 100000,
    maxAcquisitionRecordBytes: 64 * 1024 * 1024,
    maxApprovalRecords: 4096,
  });
async function begin(client: PoolClient, scope: EvidenceScope, isolation = "READ COMMITTED") {
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query(
    "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
    [scope.tenantId, scope.projectId, scope.environmentId],
  );
}
async function close(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}
function exception(namespace: string) {
  const f = fixture(namespace);
  const original = approvalVersion(f.original, {
    kind: "rule_exception",
    action: "approve",
    conditions: ["Synthetic condition."],
    declaredConflicts: ["Synthetic declared conflict."],
    compensatingControls: [
      {
        artifactId: "artifact_synthetic_control",
        sha256: "a".repeat(64),
        classification: "internal",
        mediaType: "application/json",
        sizeBytes: 1,
      },
    ],
  });
  return {
    ...f,
    original,
    revocation: approvalRevocation(f.revocation, { approval: releaseApprovalReference(original) }),
  };
}
function fixture(namespace: string) {
  // The unchanged factory contract gives each case isolated state. Unlike target-owned version
  // fixtures, approval fixtures share a full subject by default, so use distinct exact scopes.
  const f = releaseApprovalRepositoryFixture(`a_${key}_${namespace}`);
  const scope = {
    tenantId: `tenant_a_${key}_${namespace}`,
    projectId: `project_a_${key}_${namespace}`,
    environmentId: `env_a_${key}_${namespace}`,
  };
  const original = approvalVersion(f.original, { subject: { ...f.subject, scope } });
  const successor = approvalVersion(f.successor, {
    subject: original.subject,
    supersedes: releaseApprovalReference(original),
  });
  const revocation = approvalRevocation(f.revocation, {
    scope,
    approval: releaseApprovalReference(original),
  });
  return { original, successor, revocation, scope, subject: original.subject };
}
beforeAll(async () => {
  expect(
    (
      await pool.query(
        "SELECT current_database() AS name,current_setting('server_version') AS version",
      )
    ).rows,
  ).toEqual([{ name: "proofstack_test", version: "16.15" }]);
  await migrateDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});
describe("native original approval/receipt storage / unchanged shared conformance", () => {
  for (const example of releaseApprovalRepositoryConformanceCases)
    it(example.name, () =>
      example.run((namespace) => ({ repository, fixture: fixture(namespace) })),
    );
  it("keeps caller backend/XID/savepoint and whole kind/subject source guards held", async () => {
    const f = fixture("owner");
    await repository.publishReleaseApproval(f.original);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
        [f.scope.tenantId, f.scope.projectId, f.scope.environmentId],
      );
      await client.query("SAVEPOINT owner");
      const before = (
        await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")
      ).rows;
      expect(
        await readPostgresReleaseApprovalSubjectOnClient(
          client,
          f.scope,
          f.original.kind,
          f.subject,
          new ReleaseDecisionVerificationBudget({
            maxAcquisitionRecords: 100000,
            maxAcquisitionRecordBytes: 64 * 1024 * 1024,
            maxApprovalRecords: 4096,
          }),
        ),
      ).toEqual({ records: [f.original], revocations: [] });
      expect(
        (await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")).rows,
      ).toEqual(before);
      await client.query("ROLLBACK TO SAVEPOINT owner");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("native approval completeness, guarded races and normalized integrity", () => {
  it("reads fixed pages of every action without selecting a favorable latest row", async () => {
    const f = fixture("pages");
    const actions = ["approve", "oppose", "escalate", "abstain"] as const;
    const records = [];
    for (let index = 0; index < 33; index++) {
      const record = approvalVersion(f.original, {
        approvalId: `approval_pages_${key}_${String(index).padStart(2, "0")}`,
        action: actions[index % actions.length] ?? "abstain",
      });
      await repository.publishReleaseApproval(record);
      records.push(record);
    }
    await expect(
      repository.readReleaseApprovalSubject(f.scope, f.original.kind, f.subject, meter()),
    ).resolves.toEqual({ records, revocations: [] });
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects a substituted %s and taints the original cut",
    async (field) => {
      const f = fixture(`scope_${field.toLowerCase()}`),
        client = await pool.connect(),
        budget = meter();
      try {
        await begin(client, f.scope);
        await expect(
          readPostgresReleaseApprovalSubjectOnClient(
            client,
            { ...f.scope, [field]: "scope_foreign" },
            f.original.kind,
            f.subject,
            budget,
          ),
        ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
        expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      } finally {
        await close(client);
      }
    },
  );
  it("refuses a stale REPEATABLE READ snapshot", async () => {
    const f = fixture("isolation"),
      client = await pool.connect();
    try {
      await begin(client, f.scope, "REPEATABLE READ");
      await expect(
        readPostgresReleaseApprovalSubjectOnClient(
          client,
          f.scope,
          f.original.kind,
          f.subject,
          meter(),
        ),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(client);
    }
  });
  it("rejects a contended read without returning a partial census", async () => {
    const f = fixture("contention"),
      reader = await pool.connect(),
      writer = await pool.connect(),
      budget = meter();
    try {
      await begin(writer, f.scope);
      await writer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-approval.v1',$1::text)::text,0))",
        [f.scope.tenantId],
      );
      await begin(reader, f.scope);
      await expect(
        readPostgresReleaseApprovalSubjectOnClient(
          reader,
          f.scope,
          f.original.kind,
          f.subject,
          budget,
        ),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(reader);
      await close(writer);
    }
  });
  it.each(["absent", "revocation", "successor"] as const)(
    "holds %s stable until the caller releases the transaction",
    async (kind) => {
      const f = fixture(`race_${kind}`);
      if (kind !== "absent") await repository.publishReleaseApproval(f.original);
      const reader = await pool.connect();
      let writing: Promise<unknown> | undefined;
      try {
        await begin(reader, f.scope);
        const before = await readPostgresReleaseApprovalSubjectOnClient(
          reader,
          f.scope,
          f.original.kind,
          f.subject,
          meter(),
        );
        expect(before).toEqual({ records: kind === "absent" ? [] : [f.original], revocations: [] });
        writing =
          kind === "revocation"
            ? repository.publishReleaseApprovalRevocation(f.revocation)
            : repository.publishReleaseApproval(kind === "successor" ? f.successor : f.original);
        void writing.catch(() => undefined);
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          blocked =
            (
              await pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%proofstack_store_release_approval%') AS blocked",
              )
            ).rows[0]?.blocked === true;
          if (blocked) break;
          await delay(10);
        }
        expect(blocked).toBe(true);
        expect(
          await readPostgresReleaseApprovalSubjectOnClient(
            reader,
            f.scope,
            f.original.kind,
            f.subject,
            meter(),
          ),
        ).toEqual(before);
        await reader.query("ROLLBACK");
        await writing;
        expect(
          await repository.readReleaseApprovalSubject(f.scope, f.original.kind, f.subject, meter()),
        ).toEqual({
          records: kind === "successor" ? [f.original, f.successor] : [f.original],
          revocations: kind === "revocation" ? [f.revocation] : [],
        });
      } finally {
        await close(reader);
        if (writing) await writing;
      }
    },
  );
  it.each([
    "proofstack_release_approval_sources",
    "proofstack_release_approval_declarations",
    "proofstack_release_approval_controls",
  ])("rejects damaged %s and retains a failed budget", async (table) => {
    const f = exception(`damage_${table.split("_").at(-1)}`);
    await repository.publishReleaseApproval(f.original);
    const client = await pool.connect(),
      budget = meter();
    try {
      await begin(client, f.scope);
      await client.query("SET LOCAL session_replication_role='replica'");
      await client.query(`DELETE FROM public.${table} WHERE tenant_id=$1 AND approval_id=$2`, [
        f.scope.tenantId,
        f.original.approvalId,
      ]);
      await expect(
        readPostgresReleaseApprovalSubjectOnClient(
          client,
          f.scope,
          f.original.kind,
          f.subject,
          budget,
        ),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(client);
    }
    expect(await repository.findReleaseApproval(f.scope, f.original.approvalId)).toEqual(
      f.original,
    );
  });
  it.each(["proofstack_release_approval_declarations", "proofstack_release_approval_controls"])(
    "rejects a deferred ordinal gap in %s and rolls back the whole intent",
    async (table) => {
      const f = exception(`gap_${table.split("_").at(-1)}`),
        client = await pool.connect();
      const { schemaVersion: _version, definitionSha256: _hash, ...definition } = f.original;
      const canonical = Buffer.from(
        encodeReleaseApprovalDefinition({ scope: f.scope, definition }),
      ).toString("utf8");
      try {
        await begin(client, f.scope);
        await client.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${table}_append_only`);
        await client.query("SELECT public.proofstack_store_release_approval($1::jsonb,$2)", [
          JSON.stringify(f.original),
          canonical,
        ]);
        await client.query(
          `UPDATE public.${table} SET ordinal=ordinal+10 WHERE tenant_id=$1 AND approval_id=$2`,
          [f.scope.tenantId, f.original.approvalId],
        );
        await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
          code: "23514",
        });
      } finally {
        await close(client);
      }
      expect(await repository.findReleaseApproval(f.scope, f.original.approvalId)).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer AS count FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_id=$2",
            [f.scope.tenantId, f.original.approvalId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    },
  );
  it("forces RLS even for the owner of every nonempty approval table", async () => {
    const f = exception("rls"),
      role = `ps_approval_rls_${key}`;
    await repository.publishReleaseApproval(f.original);
    await repository.publishReleaseApprovalRevocation(f.revocation);
    const tables = [
      "proofstack_release_approvals",
      "proofstack_release_approval_sources",
      "proofstack_release_approval_declarations",
      "proofstack_release_approval_controls",
      "proofstack_release_approval_revocations",
    ];
    await pool.query(
      `CREATE ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    const client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      for (const table of tables)
        await client.query(`ALTER TABLE public.${table} OWNER TO "${role}"`);
      await client.query(`SET LOCAL ROLE "${role}"`);
      for (const table of tables)
        expect(
          Number(
            (await client.query(`SELECT count(*) AS count FROM public.${table}`)).rows[0]?.count,
          ),
        ).toBeGreaterThan(0);
      for (const field of ["tenant_id", "project_id", "environment_id"]) {
        await client.query("SAVEPOINT scope_check");
        await client.query("SELECT set_config($1,'scope_foreign',true)", [`proofstack.${field}`]);
        for (const table of tables)
          expect(
            (await client.query(`SELECT count(*)::integer AS count FROM public.${table}`)).rows,
          ).toEqual([{ count: 0 }]);
        await client.query("ROLLBACK TO SAVEPOINT scope_check");
      }
      await client.query("SELECT set_config('proofstack.tenant_id','',true)");
      for (const table of tables)
        expect(
          (await client.query(`SELECT count(*)::integer AS count FROM public.${table}`)).rows,
        ).toEqual([{ count: 0 }]);
    } finally {
      await close(client);
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  });
});
