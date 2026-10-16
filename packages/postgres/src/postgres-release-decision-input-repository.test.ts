import { readFileSync } from "node:fs";
import {
  ReleaseDecisionInputRepositoryError,
  ReleaseDecisionVerificationBudget,
  type ReleaseDecisionInputGraph,
} from "@proofstack/core";
import { decisionInputVersion } from "@proofstack/core/testing";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresReleaseDecisionInputRepository,
  readPostgresReleaseDecisionInputOnClient,
} from "./postgres-release-decision-input-repository.js";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";

// Actual synthetic PostgreSQL 16.15 rows, not an independent SQL or authority oracle.
const wire = JSON.parse(
  readFileSync(new URL("./fixtures/decision-input-native-wire-v1.json", import.meta.url), "utf8"),
) as {
  format: string;
  graph: ReleaseDecisionInputGraph;
  queries: { sql: string; values: unknown[]; rows: Record<string, unknown>[] }[];
};
if (wire.format !== "proofstack.release-decision-input-native-wire.v1")
  throw new Error("Invalid native input fixture");
const { graph } = wire;
const limits = {
  maxAcquisitionRecords: 100000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 0,
};
const meter = () => new ReleaseDecisionVerificationBudget(limits);
function fixture() {
  const observations = structuredClone(wire.queries);
  const state = {
    created: true as unknown,
    writeRows: undefined as unknown[] | undefined,
    failOn: "",
    failure: new Error("native input unavailable"),
    rollbackFails: false,
    connects: 0,
  };
  const calls: string[] = [],
    released: (boolean | undefined)[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push(sql);
      if (
        (state.failOn && sql.includes(state.failOn)) ||
        (state.rollbackFails && sql === "ROLLBACK")
      )
        throw state.failure;
      if (sql.includes("proofstack_store_release_decision_input"))
        return { rows: state.writeRows ?? [{ created: state.created }] };
      const observation = observations.find(
        (entry) => entry.sql === sql && JSON.stringify(entry.values) === JSON.stringify(values),
      );
      if (observation) return { rows: structuredClone(observation.rows) };
      if (
        sql === "BEGIN ISOLATION LEVEL READ COMMITTED" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      )
        return { rows: [] };
      throw new Error("Unexpected native input query");
    },
    release(destroyed?: boolean) {
      released.push(destroyed);
    },
  } as unknown as PoolClient;
  const pool = {
    async connect() {
      state.connects++;
      return client;
    },
  } as unknown as Pick<Pool, "connect">;
  return {
    state,
    observations,
    client,
    calls,
    released,
    repository: new PostgresReleaseDecisionInputRepository(pool),
  };
}
const read = (f: ReturnType<typeof fixture>, budget = meter()) =>
  readPostgresReleaseDecisionInputOnClient(
    f.client,
    graph.request.scope,
    graph.request.decisionInputRequestId,
    budget,
  );
function row(f: ReturnType<typeof fixture>, index: number): Record<string, unknown> {
  const value = f.observations[index]?.rows[0];
  if (!value) throw new Error("Missing observation row");
  return value;
}
function observation(f: ReturnType<typeof fixture>, index: number) {
  const value = f.observations[index];
  if (!value) throw new Error("Missing wire observation");
  return value;
}

describe("original decision input native transport integrity", () => {
  it("retains the complete source graph, every normalized row and repeated acquisition", async () => {
    const f = fixture(),
      budget = meter();
    expect(await read(f, budget)).toEqual(graph);
    const usage = budget.snapshot();
    expect(usage.records).toBe(wire.queries.reduce((count, q) => count + q.rows.length, 0));
    expect(usage.recordBytes).toBeGreaterThan(0);
    expect(usage.approvalRecords).toBe(0);
    expect(await read(f, budget)).toEqual(graph);
    expect(budget.snapshot()).toEqual({
      records: usage.records * 2,
      recordBytes: usage.recordBytes * 2,
      approvalRecords: 0,
    });
    expect(f.calls).toEqual([...wire.queries, ...wire.queries].map((q) => q.sql));
  });
  it("counts an explicit absence without fetching invented plans or witnesses", async () => {
    const f = fixture(),
      budget = meter();
    observation(f, 0).rows = [{ value: null }];
    expect(await read(f, budget)).toBeNull();
    expect(budget.snapshot()).toMatchObject({ records: 1, approvalRecords: 0 });
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    "candidate_version_id",
    "candidate_sha256",
    "selection_version_id",
    "selection_sha256",
    "publisher_principal_id",
    "publisher_type",
    "publisher_method",
    "publisher_credential_id",
    "publisher_request_id",
    "authenticated_at_key",
    "created_at_key",
    "expires_at_key",
    "canonical_utf8",
    "plan_count",
    "project_id",
    "environment_id",
    "input_id",
  ])("rejects root projection corruption: %s", async (key) => {
    const f = fixture();
    (row(f, 0)["value"] as Record<string, unknown>)[key] = "corrupted";
    await expect(read(f)).rejects.toThrow();
  });
  it.each([null, [], "root", 1])("rejects non-object native roots: %s", async (value) => {
    const f = fixture();
    row(f, 0)["value"] = value;
    if (value === null) expect(await read(f)).toBeNull();
    else await expect(read(f)).rejects.toThrow();
  });
  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "rejects missing and repeated native observations at boundary %i",
    async (index) => {
      for (const repeat of [false, true]) {
        const f = fixture(),
          observation = f.observations[index];
        if (!observation) throw new Error("Missing wire boundary");
        observation.rows = repeat ? [...observation.rows, ...observation.rows] : [];
        const budget = meter();
        await expect(read(f, budget)).rejects.toThrow();
        expect(() => budget.snapshot()).toThrow();
      }
    },
  );
  it.each([
    "request_id",
    "request_sha256",
    "policy_id",
    "policy_version_id",
    "policy_sha256",
    "mode",
    "ordinal",
    "input_sha256",
  ])("rejects normalized plan corruption: %s", async (key) => {
    const f = fixture();
    row(f, 1)[key] = "corrupted";
    await expect(read(f)).rejects.toThrow();
  });
  it.each(["source_id", "source_sha256", "kind", "ordinal", "reference", "input_sha256"])(
    "rejects complete source inventory corruption: %s",
    async (key) => {
      const f = fixture();
      row(f, 2)[key] = "corrupted";
      await expect(read(f)).rejects.toThrow();
    },
  );
  it.each([3, 4, 5, 6])("rehashes every original source body %i", async (index) => {
    const f = fixture();
    const source = row(f, index)["record"] as Record<string, unknown>;
    source["definitionSha256"] = "0".repeat(64);
    await expect(read(f)).rejects.toThrow();
  });
  it("rejects extra body fields and changed policy ordering", async () => {
    const f = fixture();
    row(f, 3)["hidden"] = "unexpected";
    await expect(read(f)).rejects.toThrow();
    const ordered = fixture();
    observation(ordered, 1).rows.reverse();
    await expect(read(ordered)).rejects.toThrow();
  });
  it.each(["eventType", "schemaVersion", "payload", "timeMatches"])(
    "rejects non-canonical original outbox %s",
    async (key) => {
      const f = fixture();
      row(f, 7)[key] = "corrupted";
      await expect(read(f)).rejects.toThrow();
    },
  );
  it("admits exact record/byte bounds and permanently rejects one below", async () => {
    const full = meter();
    await read(fixture(), full);
    const usage = full.snapshot();
    expect(
      await read(
        fixture(),
        new ReleaseDecisionVerificationBudget({
          maxAcquisitionRecords: usage.records,
          maxAcquisitionRecordBytes: usage.recordBytes,
          maxApprovalRecords: 0,
        }),
      ),
    ).toEqual(graph);
    for (const field of ["maxAcquisitionRecords", "maxAcquisitionRecordBytes"] as const) {
      const budget = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: usage.records,
        maxAcquisitionRecordBytes: usage.recordBytes,
        maxApprovalRecords: 0,
        [field]: (field === "maxAcquisitionRecords" ? usage.records : usage.recordBytes) - 1,
      });
      const f = fixture();
      await expect(read(f, budget)).rejects.toThrow();
      const calls = f.calls.length;
      await expect(read(f, budget)).rejects.toThrow();
      expect(f.calls).toHaveLength(calls);
    }
  });
  it("rejects a fake or previously failed meter before acquiring a connection", async () => {
    const f = fixture(),
      budget = meter();
    expect(() => budget.rejectSourceRead(new Error("first failed read"))).toThrow();
    await expect(
      f.repository.findReleaseDecisionInput(
        graph.request.scope,
        graph.request.decisionInputRequestId,
        budget,
      ),
    ).rejects.toThrow();
    await expect(
      readPostgresReleaseDecisionInputOnClient(
        f.client,
        graph.request.scope,
        graph.request.decisionInputRequestId,
        {} as ReleaseDecisionVerificationBudget,
      ),
    ).rejects.toBeInstanceOf(ReleaseDecisionInputRepositoryError);
    expect(f.state.connects).toBe(0);
    expect(f.calls).toEqual([]);
  });
  it("taints the original meter on scope or source acquisition failure", async () => {
    for (const failOn of [
      "set_config",
      "proofstack_read_release_decision_input",
      "proofstack_release_decision_input_plans",
      "proofstack_outbox",
    ]) {
      const f = fixture(),
        budget = meter();
      f.state.failOn = failOn;
      await expect(
        f.repository.findReleaseDecisionInput(
          graph.request.scope,
          graph.request.decisionInputRequestId,
          budget,
        ),
      ).rejects.toThrow();
      expect(() => budget.snapshot()).toThrow();
      expect(f.calls.at(-1)).toBe("ROLLBACK");
      expect(f.released).toEqual([undefined]);
    }
  });
  it("keeps its caller transaction open and never releases its connection", async () => {
    const f = fixture();
    await read(f);
    expect(f.calls.some((sql) => /BEGIN|COMMIT|ROLLBACK/.test(sql))).toBe(false);
    expect(f.released).toEqual([]);
  });
  it("returns independent original graphs through an explicit scoped RC transaction", async () => {
    const f = fixture();
    const observed = await f.repository.findReleaseDecisionInput(
      graph.request.scope,
      graph.request.decisionInputRequestId,
    );
    expect(observed).toEqual(graph);
    expect(observed).not.toBe(graph);
    expect(f.calls[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(f.calls.at(-1)).toBe("COMMIT");
    expect(f.released).toEqual([undefined]);
  });
  it("persists a complete original and preserves its first receipt on relogin", async () => {
    const f = fixture();
    expect(await f.repository.publishReleaseDecisionInput(graph)).toEqual({ created: true, graph });
    const retry = decisionInputVersion(graph.request, {
      publisher: {
        ...graph.request.publisher,
        credentialId: "session_relogin",
        requestId: "retry",
      },
      createdAt: "2026-10-15T12:15:00.000001Z",
      expiresAt: "2026-10-15T12:25:00.000001Z",
    });
    f.state.created = false;
    expect(await f.repository.publishReleaseDecisionInput({ ...graph, request: retry })).toEqual({
      created: false,
      graph,
    });
  });
  it.each([true, false])(
    "rolls back missing or contradictory original publication reads (created=%s)",
    async (created) => {
      const f = fixture();
      f.state.created = created;
      observation(f, 0).rows = [{ value: null }];
      await expect(f.repository.publishReleaseDecisionInput(graph)).rejects.toThrow();
      expect(f.calls.at(-1)).toBe("ROLLBACK");
      const mismatched = fixture();
      mismatched.state.created = created;
      const other = decisionInputVersion(graph.request, {
        rationale: "A different original rationale.",
      });
      await expect(
        mismatched.repository.publishReleaseDecisionInput({ ...graph, request: other }),
      ).rejects.toThrow();
      expect(mismatched.calls.at(-1)).toBe("ROLLBACK");
    },
  );
  it.each([null, "true", 1, undefined])(
    "requires an exact boolean native publication acknowledgement: %s",
    async (created) => {
      const f = fixture();
      f.state.created = created;
      await expect(f.repository.publishReleaseDecisionInput(graph)).rejects.toBeInstanceOf(
        ReleaseDecisionInputRepositoryError,
      );
      expect(f.calls.at(-1)).toBe("ROLLBACK");
    },
  );
  it.for([[], [{ created: true }, { created: true }]])(
    "rejects missing or duplicate native publication acknowledgement",
    async (rows) => {
      const f = fixture();
      f.state.writeRows = rows;
      await expect(f.repository.publishReleaseDecisionInput(graph)).rejects.toThrow();
    },
  );
  it.each(["input_conflict", "planned_request_conflict"])(
    "preserves a native whole-conflict reason: %s",
    async (reason) => {
      const f = fixture();
      f.state.failOn = "proofstack_store_release_decision_input";
      f.state.failure = Object.assign(new Error(`release_decision_input:${reason}`), {
        code: "P0001",
      });
      await expect(f.repository.publishReleaseDecisionInput(graph)).rejects.toMatchObject({
        reason,
        cause: f.state.failure,
      });
      expect(f.calls.at(-1)).toBe("ROLLBACK");
    },
  );
  it.each(["23514", "23503", "23505", "P0002", "22023", "22P02", "P0001", "XX000"])(
    "preserves native integrity failures without committing: %s",
    async (code) => {
      const f = fixture();
      f.state.failOn = "proofstack_store_release_decision_input";
      f.state.failure = Object.assign(new Error("native failure"), { code });
      await expect(f.repository.publishReleaseDecisionInput(graph)).rejects.toThrow();
      expect(f.calls.at(-1)).toBe("ROLLBACK");
    },
  );
  it("destroys the connection if rollback fails and preserves the original operation error", async () => {
    const f = fixture();
    f.state.failOn = "proofstack_read_release_decision_input";
    f.state.rollbackFails = true;
    await expect(
      f.repository.findReleaseDecisionInput(
        graph.request.scope,
        graph.request.decisionInputRequestId,
      ),
    ).rejects.toBeInstanceOf(PostgresTransactionCleanupError);
    expect(f.released).toEqual([true]);
  });
  it("rejects invalid scope, ID or complete graph before publication", async () => {
    const f = fixture();
    await expect(
      readPostgresReleaseDecisionInputOnClient(f.client, graph.request.scope, "bad-id", meter()),
    ).rejects.toThrow();
    await expect(
      f.repository.publishReleaseDecisionInput({ ...graph, policies: [] }),
    ).rejects.toThrow();
    expect(f.state.connects).toBe(0);
    expect(f.calls).toEqual([]);
  });
});
