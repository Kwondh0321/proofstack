import type { EvidenceScope } from "@proofstack/contracts";
import type { PolicyEvaluationSourceRecheckPorts } from "@proofstack/policy-evaluation";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadBundledMigrations } from "./migrations.js";
import { PostgresPolicySourceTransactions } from "./postgres-policy-source-transactions.js";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";

const scope: EvidenceScope = {
  tenantId: "tenant_guard",
  projectId: "project_guard",
  environmentId: "environment_guard",
};
const at = "2026-10-01T02:00:00.000001Z";
type Rows = { rows: Record<string, unknown>[] };
const migrationRows = (await loadBundledMigrations()).map(({ id, checksum }) => ({ id, checksum }));
const historyLimits = { maxRecords: 10, maxRecordBytes: 100_000 };

function fixture() {
  const queries: { text: string; values?: readonly unknown[] }[] = [];
  const release = vi.fn();
  const response = vi.fn(
    async (text: string): Promise<Rows> =>
      text.includes("try_lock_policy")
        ? { rows: [{ acquired: true }] }
        : text.includes("clock_timestamp")
          ? { rows: [{ observed_at: at }] }
          : text.includes("to_regclass")
            ? { rows: [{ ledger: "proofstack_schema_migrations" }] }
            : text.includes("SELECT id, checksum")
              ? { rows: migrationRows }
              : { rows: [] },
  );
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, ...(values ? { values } : {}) });
      return response(text);
    },
    release,
  };
  const connect = vi.fn(async () => client);
  const adapter = new PostgresPolicySourceTransactions({ connect } as unknown as Pick<
    Pool,
    "connect"
  >);
  return { queries, release, response, connect, adapter };
}

describe("PostgresPolicySourceTransactions", () => {
  it("sets explicit READ COMMITTED and exact scope before all locks and normalized reads on one connection", async () => {
    const f = fixture();
    const result = await f.adapter.run(scope, async (ports) => {
      expect(Object.keys(ports).sort()).toEqual([
        "findArtifact",
        "findCriterion",
        "findPolicy",
        "listCriterionSetStatuses",
        "listPolicyHistory",
        "observationTime",
        "tryGuard",
        "tryMetadataGuard",
      ]);
      expect(await ports.tryMetadataGuard()).toBe(true);
      expect(await ports.tryGuard("artifact", "artifact_one")).toBe(true);
      expect(await ports.tryGuard("release_policy", "policy_one")).toBe(true);
      expect(await ports.findArtifact("artifact_one")).toBeNull();
      expect(await ports.findPolicy("policy_one")).toBeNull();
      expect(await ports.listPolicyHistory("policy_one")).toEqual([]);
      expect(await ports.findCriterion("criterion_one")).toBeNull();
      expect(await ports.listCriterionSetStatuses(historyLimits)).toEqual([]);
      return ports.observationTime();
    });
    expect(result).toBe(at);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.queries.slice(0, 4)).toEqual([
      { text: "BEGIN ISOLATION LEVEL READ COMMITTED" },
      { text: "SELECT set_config('proofstack.tenant_id', $1, true)", values: [scope.tenantId] },
      { text: "SELECT set_config('proofstack.project_id', $1, true)", values: [scope.projectId] },
      {
        text: "SELECT set_config('proofstack.environment_id', $1, true)",
        values: [scope.environmentId],
      },
    ]);
    const reads = f.queries.filter(
      ({ text }) =>
        text.includes("FROM public.proofstack_artifact_catalog") ||
        text.includes("FROM public.proofstack_release_policies") ||
        text.includes("FROM public.proofstack_release_policy_lifecycle_events"),
    );
    expect(reads).toHaveLength(3);
    for (const read of reads)
      expect(read.values?.slice(0, 3)).toEqual([
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
      ]);
    const criterionReads = f.queries.filter(({ text }) =>
      text.includes("FROM public.proofstack_evaluation_records"),
    );
    expect(criterionReads.map(({ values }) => values)).toEqual([
      [scope.tenantId, "criterion_set", "criterion_one"],
      [scope.tenantId, scope.projectId, scope.environmentId, historyLimits.maxRecords + 1],
    ]);
    const ledgerIndex = f.queries.findIndex(({ text }) => text.includes("SELECT id, checksum"));
    expect(ledgerIndex).toBeGreaterThan(
      f.queries.findIndex(({ text }) => text.includes("try_lock_policy_evaluation_metadata")),
    );
    expect(ledgerIndex).toBeLessThan(
      f.queries.findIndex(({ text }) => text.includes("FROM public.proofstack_evaluation_records")),
    );
    expect(f.queries.at(-1)?.text).toBe("COMMIT");
    expect(f.release.mock.calls).toEqual([[]]);
  });

  it("owns scope before an asynchronous connection callback can mutate caller input", async () => {
    const f = fixture();
    const input = { ...scope };
    const connect = f.connect.getMockImplementation();
    if (!connect) throw new Error("Expected connection fixture");
    f.connect.mockImplementation(async () => {
      input.tenantId = "tenant_changed";
      return connect();
    });
    await f.adapter.run(input, (ports) => ports.findArtifact("artifact_one"));
    expect(f.queries[1]?.values).toEqual([scope.tenantId]);
    expect(
      f.queries.find(({ text }) => text.includes("FROM public.proofstack_artifact_catalog"))
        ?.values,
    ).toEqual([scope.tenantId, scope.projectId, scope.environmentId, "artifact_one"]);
  });

  it("rolls back all earlier guards and taints even a caught later acquisition failure", async () => {
    const f = fixture();
    let calls = 0;
    f.response.mockImplementation(async (text) =>
      text.includes("try_lock_policy") ? { rows: [{ acquired: ++calls === 1 }] } : { rows: [] },
    );
    let failure: unknown;
    await expect(
      f.adapter.run(scope, async (ports) => {
        await ports.tryGuard("artifact", "artifact_first");
        try {
          await ports.tryGuard("artifact", "artifact_last");
        } catch (error) {
          failure = error;
        }
        await expect(ports.findPolicy("policy_one")).rejects.toBe(failure);
        return "must_not_commit";
      }),
    ).rejects.toMatchObject({ reason: "guard_unavailable" });
    expect(f.queries.map(({ text }) => text)).not.toContain("COMMIT");
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(f.queries.filter(({ text }) => text.includes("try_lock_policy"))).toHaveLength(2);
    expect(
      f.queries.some(({ text }) => text.includes("FROM public.proofstack_release_policies")),
    ).toBe(false);
  });

  it.each([
    { rows: [] },
    { rows: [{ acquired: true }, { acquired: true }] },
    { rows: [{ acquired: "true" }] },
    { rows: [{ acquired: null }] },
  ])("rejects malformed guard rows %j instead of treating them as success", async ({ rows }) => {
    const f = fixture();
    f.response.mockImplementation(async (text) =>
      text.includes("try_lock_policy") ? { rows } : { rows: [] },
    );
    await expect(
      f.adapter.run(scope, (ports) => ports.tryGuard("artifact", "artifact_one")),
    ).rejects.toMatchObject({ reason: "guard_invalid" });
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it.each(["kind", "id"])("rejects invalid guard %s before its SQL", async (kind) => {
    const f = fixture();
    await expect(
      f.adapter.run(scope, (ports) =>
        ports.tryGuard(
          kind === "kind" ? ("unknown" as "artifact") : "artifact",
          kind === "id" ? "invalid id" : "artifact_one",
        ),
      ),
    ).rejects.toThrow();
    expect(f.queries.some(({ text }) => text.includes("try_lock_policy"))).toBe(false);
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects invalid %s before connecting",
    async (field) => {
      const f = fixture();
      await expect(f.adapter.run({ ...scope, [field]: "" }, async () => null)).rejects.toThrow();
      expect(f.connect).not.toHaveBeenCalled();
    },
  );

  it.each([
    { rows: [] },
    { rows: [{ observed_at: at }, { observed_at: at }] },
    { rows: [{ observed_at: "bad" }] },
  ])("rejects malformed database clock rows %j", async ({ rows }) => {
    const f = fixture();
    f.response.mockImplementation(async (text) =>
      text.includes("clock_timestamp") ? { rows } : { rows: [] },
    );
    await expect(f.adapter.run(scope, (ports) => ports.observationTime())).rejects.toThrow();
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("expires every read/guard port before releasing the connection", async () => {
    const f = fixture();
    let retained: PolicyEvaluationSourceRecheckPorts | undefined;
    await f.adapter.run(scope, async (ports) => {
      retained = ports;
      return null;
    });
    if (!retained) throw new Error("Expected retained test ports");
    const ports = retained;
    const before = f.queries.length;
    for (const call of [
      () => ports.tryMetadataGuard(),
      () => ports.tryGuard("artifact", "artifact_one"),
      () => ports.findCriterion("criterion_one"),
      () => ports.listCriterionSetStatuses(historyLimits),
      () => ports.findArtifact("artifact_one"),
      () => ports.findPolicy("policy_one"),
      () => ports.listPolicyHistory("policy_one"),
      () => ports.observationTime(),
    ])
      await expect(call()).rejects.toThrow("expired");
    expect(f.queries).toHaveLength(before);
  });

  it.each(["criterion", "history"])(
    "rejects a %s read before metadata acquisition without SQL",
    async (kind) => {
      const f = fixture();
      await expect(
        f.adapter.run(scope, (ports) =>
          kind === "criterion"
            ? ports.findCriterion("criterion_one")
            : ports.listCriterionSetStatuses(historyLimits),
        ),
      ).rejects.toMatchObject({ reason: "guard_unavailable", identity: "metadata" });
      expect(f.queries.some(({ text }) => text.includes("proofstack_evaluation_records"))).toBe(
        false,
      );
      expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  it.each([
    { rows: [], reason: "guard_invalid" },
    { rows: [{ acquired: false }], reason: "guard_unavailable" },
    { rows: [{ acquired: "true" }], reason: "guard_invalid" },
    { rows: [{ acquired: null }], reason: "guard_invalid" },
    { rows: [{ acquired: true }, { acquired: true }], reason: "guard_invalid" },
  ])("abandons partial metadata guards on $reason response $rows", async ({ rows, reason }) => {
    const f = fixture();
    f.response.mockImplementation(async (text) =>
      text.includes("try_lock_policy_evaluation_metadata") ? { rows } : { rows: [] },
    );
    await expect(f.adapter.run(scope, (ports) => ports.tryMetadataGuard())).rejects.toMatchObject({
      reason,
      identity: "metadata",
    });
    expect(f.queries.some(({ text }) => text.includes("to_regclass"))).toBe(false);
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it.each(["missing", "pending", "checksum", "unknown"])(
    "taints a caught %s migration ledger failure before source reads",
    async (kind) => {
      const f = fixture();
      const original = f.response.getMockImplementation();
      if (!original) throw new Error("Missing query fixture");
      f.response.mockImplementation(async (text) => {
        if (kind === "missing" && text.includes("to_regclass")) return { rows: [{ ledger: null }] };
        if (text.includes("SELECT id, checksum"))
          return {
            rows:
              kind === "pending"
                ? migrationRows.slice(0, -1)
                : kind === "checksum"
                  ? migrationRows.map((row, index) =>
                      index === 0 ? { ...row, checksum: "0".repeat(64) } : row,
                    )
                  : [...migrationRows, { id: "9999_unknown", checksum: "0".repeat(64) }],
          };
        return original(text);
      });
      let failure: unknown;
      await expect(
        f.adapter.run(scope, async (ports) => {
          try {
            await ports.tryMetadataGuard();
          } catch (error) {
            failure = error;
          }
          await expect(ports.findCriterion("criterion_one")).rejects.toBe(failure);
          await expect(ports.listCriterionSetStatuses(historyLimits)).rejects.toBe(failure);
          return "must_not_commit";
        }),
      ).rejects.toBeDefined();
      expect(failure).toMatchObject({
        name:
          kind === "missing" || kind === "pending"
            ? "MigrationRequiredError"
            : "MigrationIntegrityError",
      });
      expect(f.queries.some(({ text }) => text.includes("proofstack_evaluation_records"))).toBe(
        false,
      );
      expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  it.each(["id", "limits"])(
    "validates new %s inputs before their SQL and taints the whole operation",
    async (kind) => {
      const f = fixture();
      await expect(
        f.adapter.run(scope, async (ports) => {
          await ports.tryMetadataGuard();
          return kind === "id"
            ? ports.findCriterion("invalid id")
            : ports.listCriterionSetStatuses({ ...historyLimits, maxRecords: -1 });
        }),
      ).rejects.toThrow();
      expect(f.queries.some(({ text }) => text.includes("proofstack_evaluation_records"))).toBe(
        false,
      );
      expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  for (const fail of [false, true])
    it(`drains an unawaited ${fail ? "failed" : "successful"} read before transaction cleanup`, async () => {
      const f = fixture();
      let finish: (rows: Rows) => void = () => {
        throw new Error("Missing read barrier");
      };
      let reject: (error: Error) => void = () => {
        throw new Error("Missing failure barrier");
      };
      const read = new Promise<Rows>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      });
      let notice: () => void = () => {
        throw new Error("Missing operation barrier");
      };
      const started = new Promise<void>((resolve) => {
        notice = resolve;
      });
      f.response.mockImplementation(async (text) =>
        text.includes("clock_timestamp") ? read : { rows: [] },
      );
      const failure = new Error("late read failed");
      const running = f.adapter.run(scope, async (ports) => {
        void ports.observationTime().catch(() => undefined);
        notice();
        return "done";
      });
      const outcome = running.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await started;
      expect(f.release).not.toHaveBeenCalled();
      expect(f.queries.map(({ text }) => text)).not.toContain("COMMIT");
      if (fail) reject(failure);
      else finish({ rows: [{ observed_at: at }] });
      expect(await outcome).toEqual(fail ? { error: failure } : { value: "done" });
      expect(f.queries.at(-1)?.text).toBe(fail ? "ROLLBACK" : "COMMIT");
      expect(f.release).toHaveBeenCalledTimes(1);
    });

  it("preserves an operation error and destroys the connection if rollback also fails", async () => {
    const f = fixture();
    const failure = new Error("operation failed");
    const rollback = new Error("rollback failed");
    f.response.mockImplementation(async (text) => {
      if (text === "ROLLBACK") throw rollback;
      return { rows: [] };
    });
    await expect(
      f.adapter.run(scope, async () => {
        throw failure;
      }),
    ).rejects.toMatchObject({
      name: PostgresTransactionCleanupError.name,
      cause: failure,
      rollbackError: rollback,
    });
    expect(f.release.mock.calls).toEqual([[true]]);
  });
});
