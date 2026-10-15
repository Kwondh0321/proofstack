import { describe, expect, it } from "vitest";
import { EvidenceScopeSchema, type EvidenceScope } from "@proofstack/contracts";
import { createMemoryPolicySnapshotResultHarness } from "@proofstack/core/testing";
import type { PoolClient } from "pg";
import type { PolicyTransactionPool } from "./bounded-policy-transaction.js";
import { PostgresPolicySnapshotRepository } from "./postgres-policy-snapshot-repository.js";

/** Read transport fault model only; actual SQL/RLS/roles are exercised in native integration. */
async function fixture() {
  const memory = createMemoryPolicySnapshotResultHarness();
  const seed = await memory.seed();
  const job = await memory.control.findJob(seed.scope, seed.jobId);
  const head = (await memory.control.findHistoryHead(seed.scope, seed.jobId))!;
  const entry = (await memory.control.readHistoryPage(head, 0)).entries.at(-1)!;
  let root: unknown = seed.snapshot,
    page: unknown,
    graph: unknown = job;
  let failHistory = false,
    failIntents = false;
  const calls: string[] = [];
  class Transport extends PostgresPolicySnapshotRepository {
    protected override async transact<T>(
      scope: EvidenceScope,
      operation: (client: PoolClient, scope: EvidenceScope) => Promise<T>,
    ) {
      return operation({} as PoolClient, EvidenceScopeSchema.parse(scope));
    }
    protected override async lastOnClient() {
      if (failHistory) throw new Error("missing_history");
      return entry;
    }
    protected override async verifyIntents() {
      if (failIntents) throw new Error("missing_intent");
    }
    protected override async one(_client: PoolClient, sql: string, values: readonly unknown[]) {
      calls.push(sql);
      if (sql.includes("read_policy_snapshot_page"))
        return page === undefined ? seed.pageSet.pages[Number(values[2])] : page;
      if (sql.includes("read_policy_snapshot(")) return root;
      if (sql.includes("read_policy_evaluation_job")) return graph;
      throw new Error("Unexpected fixed read query");
    }
  }
  return {
    seed,
    job,
    calls,
    reader: new Transport({} as PolicyTransactionPool),
    root: (value: unknown) => {
      root = value;
    },
    page: (value: unknown) => {
      page = value;
    },
    graph: (value: unknown) => {
      graph = value;
    },
    failHistory: () => {
      failHistory = true;
    },
    failIntents: () => {
      failIntents = true;
    },
  };
}
describe("stored policy snapshot reader response integrity", () => {
  it("reads the original exact header and individual retained pages", async () => {
    const f = await fixture();
    expect(await f.reader.findSnapshot(f.seed.expected)).toEqual(f.seed.snapshot);
    for (let index = 0; index < f.seed.pageSet.pages.length; index++)
      expect(await f.reader.readSnapshotPage(f.seed.expected, index)).toEqual(
        f.seed.pageSet.pages[index],
      );
  });
  it("returns absence without looking up an unrelated job or page", async () => {
    const f = await fixture();
    f.root(null);
    expect(await f.reader.findSnapshot(f.seed.expected)).toBeNull();
    expect(await f.reader.readSnapshotPage(f.seed.expected, 0)).toBeNull();
    expect(f.calls.every((sql) => sql.includes("read_policy_snapshot("))).toBe(true);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, NaN])(
    "rejects page index %s before transport",
    async (index) => {
      const f = await fixture();
      await expect(f.reader.readSnapshotPage(f.seed.expected, index)).rejects.toThrow();
      expect(f.calls).toEqual([]);
    },
  );
  it("rejects substituted job identity before transport", async () => {
    const f = await fixture();
    await expect(
      f.reader.findSnapshot({
        ...f.seed.expected,
        job: { ...f.seed.expected.job, definitionSha256: "0".repeat(64) },
      }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each([null, {}, []])("rejects malformed retained header %j", async (value) => {
    const f = await fixture();
    f.root(value === null ? undefined : value);
    await expect(f.reader.findSnapshot(f.seed.expected)).rejects.toThrow();
  });
  it("binds original worker/attempt identity even when a forged root is internally self-consistent", async () => {
    const f = await fixture();
    f.root({ ...f.seed.snapshot, workerId: "worker_forged", sealedByPrincipalId: "worker_forged" });
    await expect(f.reader.findSnapshot(f.seed.expected)).rejects.toThrow();
  });
  it("rejects normalized graph, history and intent corruption", async () => {
    for (const kind of ["job", "history", "intent"] as const) {
      const f = await fixture();
      if (kind === "job")
        f.graph({ ...f.job, job: { ...f.job!.job, definitionSha256: "0".repeat(64) } });
      if (kind === "history") f.failHistory();
      if (kind === "intent") f.failIntents();
      await expect(f.reader.findSnapshot(f.seed.expected)).rejects.toThrow();
    }
  });
  it("rejects a page outside the original root before fetching page content", async () => {
    const f = await fixture();
    await expect(
      f.reader.readSnapshotPage(f.seed.expected, f.seed.snapshot.pages.length),
    ).rejects.toThrow();
    expect(f.calls.some((sql) => sql.includes("read_policy_snapshot_page"))).toBe(false);
  });
  it.each(["missing", "other_page", "wrong_scope"] as const)(
    "rejects %s page transport",
    async (kind) => {
      const f = await fixture();
      f.page(
        kind === "missing"
          ? null
          : kind === "other_page"
            ? f.seed.pageSet.pages[1]
            : {
                ...f.seed.pageSet.pages[0],
                scope: { ...f.seed.scope, environmentId: "environment_other" },
              },
      );
      await expect(f.reader.readSnapshotPage(f.seed.expected, 0)).rejects.toThrow();
    },
  );
});
