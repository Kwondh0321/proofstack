import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  encodeEvaluationCanonicalJson,
  policyEvaluationTimestampOrderKey,
  type EvidenceScope,
} from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  type ReleaseDecisionInputGraph,
} from "@proofstack/core";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { readPostgresReleaseDecisionReservationsOnClient } from "./postgres-release-decision-reservations.js";

// Actual PostgreSQL 16.15 responses for synthetic original graphs. Not an authority oracle.
const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/decision-reservations-native-wire-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  format: string;
  nativeTimes: { input: string; lexical: string; key: string }[];
  cases: {
    name: string;
    graph: ReleaseDecisionInputGraph;
    queries: { sql: string; values?: unknown[]; rows: Record<string, unknown>[] }[];
  }[];
};
if (wire.format !== "proofstack.release-decision-reservations-native-wire.v1")
  throw new Error("Invalid native reservation fixture");
const limits = {
  maxAcquisitionRecords: 100000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 0,
};
const meter = () => new ReleaseDecisionVerificationBudget(limits);
function fixture(name = "reserved") {
  const captured = wire.cases.find((c) => c.name === name);
  if (!captured) throw new Error("Missing actual native reservation case");
  const graph = structuredClone(captured.graph),
    observations = structuredClone(captured.queries);
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const state = { failAt: "", failure: new Error("Native source unavailable") };
  const occurrences = new Map<string, number>();
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (state.failAt && sql.includes(state.failAt)) throw state.failure;
      const matching = observations.filter(
        (row) => row.sql === sql && isDeepStrictEqual(row.values, values),
      );
      const key = JSON.stringify([sql, values]),
        seen = occurrences.get(key) ?? 0;
      occurrences.set(key, seen + 1);
      const response = matching[seen % matching.length];
      if (!response) throw new Error("Unexpected reservation source query");
      return { rows: structuredClone(response.rows) };
    },
  } as unknown as Pick<PoolClient, "query">;
  const proof = observations.find((q) => q.sql.includes("reservation_profile"));
  if (!proof?.sql.includes("reservation_profile"))
    throw new Error("Missing native reservation inventory query");
  const contexts = observations.filter((q) => q.sql.includes("transaction_id"));
  if (contexts.length !== 2) throw new Error("Missing native transaction envelope");
  return { graph, observations, calls, state, client, proof, contexts };
}
type Fixture = ReturnType<typeof fixture>;
const reference = (f: Fixture) => ({
  decisionInputRequestId: f.graph.request.decisionInputRequestId,
  definitionSha256: f.graph.request.definitionSha256,
});
const read = (f: Fixture, budget = meter()) =>
  readPostgresReleaseDecisionReservationsOnClient(
    f.client,
    f.graph.request.scope,
    reference(f),
    budget,
  );
function first(f: Fixture) {
  const row = f.proof.rows[0];
  if (!row) throw new Error("Missing native reservation row");
  return row;
}
async function rejectedCut(f: Fixture) {
  const budget = meter();
  const error = await read(f, budget).then(
    () => {
      throw new Error("Expected failed original reservation cut");
    },
    (error) => error,
  );
  expect(error).toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
  const calls = f.calls.length;
  await expect(read(f, budget)).rejects.toBe(error);
  expect(f.calls).toHaveLength(calls);
  expect(() => budget.snapshot()).toThrow(error);
  return error;
}
function rawObservations(f: Fixture) {
  return f.observations.flatMap((q) => {
    if (q.sql.includes("proofstack_read_release_decision_input(")) return [q.rows[0]?.["value"]];
    if (q.rows.length) return q.rows;
    if (q.sql.includes("reservation_profile"))
      return [{ scope: f.graph.request.scope, reference: reference(f), reservations: [] }];
    if (q.sql.includes("input_plans"))
      return [
        {
          scope: f.graph.request.scope,
          inputId: f.graph.request.decisionInputRequestId,
          plans: [],
        },
      ];
    throw new Error("Unexpected empty actual native source");
  });
}

describe("owning native decision reservation observations", () => {
  it.each(wire.nativeTimes)(
    "preserves the actual native formatter cut $lexical without padding or rounding",
    async (stamp) => {
      const f = fixture();
      Object.assign(first(f), { reserved_at_lexical: stamp.lexical, reserved_at_key: stamp.key });
      const observed = await read(f);
      expect(observed?.reservations[0]?.reservedAt).toBe(stamp.lexical);
      expect(observed?.reservations[0]?.reservedAtKey).toBe(stamp.key);
    },
  );
  it.each([
    "2026-10-19T00:00:00.0000001Z",
    "2026-10-19T00:00:00.10Z",
    "2026-10-19T00:00:00.0000Z",
    "2026-10-19T00:00:00.0Z",
  ])("rejects non-native lexical form %s even with an exact matching order key", async (at) => {
    const f = fixture();
    Object.assign(first(f), {
      reserved_at_lexical: at,
      reserved_at_key: policyEvaluationTimestampOrderKey(at).toString(),
    });
    await rejectedCut(f);
  });
  it.each(["reserved", "empty"])(
    "retains a complete original %s graph and exact native receipt inventory",
    async (name) => {
      const f = fixture(name),
        budget = meter();
      const result = await read(f, budget);
      expect(result?.state).toBe("reservations_observed");
      expect(result?.graph).toEqual(f.graph);
      expect(result?.reservations).toEqual(
        f.proof.rows.map((row, ordinal) => ({
          ordinal,
          request: {
            evaluationRequestId: row["request_id"],
            definitionSha256: row["request_sha256"],
          },
          reservedAt: row["reserved_at_lexical"],
          reservedAtKey: row["reserved_at_key"],
        })),
      );
      expect(f.calls.map((c) => c.sql)).toEqual(f.observations.map((q) => q.sql));
      expect(f.calls.every((c) => c.sql.startsWith("SELECT"))).toBe(true);
      const raw = rawObservations(f),
        bytes = raw.reduce<number>(
          (sum, row) => sum + encodeEvaluationCanonicalJson(row).byteLength,
          0,
        );
      expect(budget.snapshot()).toEqual({
        records: name === "reserved" ? 16 : 10,
        recordBytes: bytes,
        approvalRecords: 0,
      });
      await read(f, budget);
      expect(budget.snapshot()).toEqual({
        records: raw.length * 2,
        recordBytes: bytes * 2,
        approvalRecords: 0,
      });
    },
  );
  it("retains legacy original data without inventing native reservation evidence", async () => {
    const f = fixture();
    for (const row of f.proof.rows)
      Object.assign(row, {
        reservation_profile: null,
        reserved_at_lexical: null,
        reserved_at_key: null,
      });
    const result = await read(f);
    expect(result?.state).toBe("legacy_unreserved");
    expect(result?.graph).toEqual(f.graph);
    expect(result?.reservations.map((r) => [r.reservedAt, r.reservedAtKey])).toEqual([
      [null, null],
      [null, null],
    ]);
  });
  it("observes exact root absence without looking for orphaned detached proof", async () => {
    const f = fixture(),
      header = f.observations.find((q) =>
        q.sql.includes("proofstack_read_release_decision_input("),
      );
    if (!header) throw new Error("Missing root query");
    header.rows = [{ value: null }];
    const budget = meter();
    expect(await read(f, budget)).toBeNull();
    expect(f.calls).toHaveLength(3);
    expect(budget.snapshot().records).toBe(3);
  });
  it("rejects a substituted original input digest before reservation acquisition", async () => {
    const f = fixture(),
      budget = meter();
    await expect(
      readPostgresReleaseDecisionReservationsOnClient(
        f.client,
        f.graph.request.scope,
        { ...reference(f), definitionSha256: "f".repeat(64) },
        budget,
      ),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(f.calls.some((c) => c.sql.includes("reservation_profile"))).toBe(false);
    expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it.each(["record", "byte"])(
    "admits exactly the cumulative %s boundary and fails one below",
    async (kind) => {
      const f = fixture(),
        raw = rawObservations(f),
        bytes = raw.reduce<number>(
          (sum, row) => sum + encodeEvaluationCanonicalJson(row).byteLength,
          0,
        );
      const exact = {
        ...limits,
        maxAcquisitionRecords: raw.length,
        maxAcquisitionRecordBytes: bytes,
      };
      expect((await read(f, new ReleaseDecisionVerificationBudget(exact)))?.state).toBe(
        "reservations_observed",
      );
      const budget = new ReleaseDecisionVerificationBudget({
        ...exact,
        ...(kind === "record"
          ? { maxAcquisitionRecords: raw.length - 1 }
          : { maxAcquisitionRecordBytes: bytes - 1 }),
      });
      await expect(read(f, budget)).rejects.toMatchObject({
        reason: kind === "record" ? "record_limit" : "byte_limit",
      });
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it.each([
    ["tenant_id", "tenant_other"],
    ["project_id", "project_other"],
    ["environment_id", "env_other"],
    ["input_id", "input_other"],
    ["input_sha256", "a".repeat(64)],
    ["ordinal", 1],
    ["ordinal", "0"],
    ["request_id", "request_other"],
    ["request_sha256", "b".repeat(64)],
    ["reservation_profile", 0],
    ["reservation_profile", 2],
    ["reservation_profile", "1"],
    ["reservation_profile", null],
    ["reserved_at_lexical", null],
    ["reserved_at_key", null],
    ["reserved_at_key", 0],
    ["reserved_at_key", "0"],
    ["reserved_at_key", "1e42"],
    ["reserved_at_key", "+123"],
    ["reserved_at_lexical", "2026-10-19T00:00:00.0000001Z"],
    ["reserved_at_lexical", "2026-10-19T00:00:00.000001+00:00"],
    ["reserved_at_lexical", "2026-02-30T00:00:00.000001Z"],
    ["extra", true],
  ])("rejects changed normalized %s = %s and taints the original meter", async (field, value) => {
    const f = fixture();
    first(f)[field as string] = value;
    await rejectedCut(f);
  });
  it.each([
    "missing",
    "extra",
    "duplicate",
    "reordered",
    "partial_legacy",
    "half_null",
    "missing_field",
  ])("rejects incomplete native reservation inventory: %s", async (kind) => {
    const f = fixture();
    if (kind === "missing") f.proof.rows = [];
    if (kind === "extra") f.proof.rows.push({ ...first(f), ordinal: 2 });
    if (kind === "duplicate") f.proof.rows[1] = structuredClone(first(f));
    if (kind === "reordered") f.proof.rows.reverse();
    if (kind === "partial_legacy")
      Object.assign(first(f), {
        reservation_profile: null,
        reserved_at_lexical: null,
        reserved_at_key: null,
      });
    if (kind === "half_null")
      Object.assign(first(f), { reservation_profile: null, reserved_at_lexical: null });
    if (kind === "missing_field") delete first(f)["reserved_at_key"];
    await rejectedCut(f);
  });
  it("preserves an owning source failure and prevents caught-failure reuse without further I/O", async () => {
    const f = fixture();
    f.state.failAt = "reservation_profile";
    expect((await rejectedCut(f)).cause).toBe(f.state.failure);
  });
  it.each([
    ["backend_pid", null],
    ["backend_pid", 0],
    ["backend_pid", "123"],
    ["transaction_id", null],
    ["transaction_id", 123],
    ["transaction_id", "0"],
    ["transaction_id", "01"],
    ["transaction_id", "-1"],
    ["extra", true],
  ])("rejects malformed native transaction context %s = %s", async (field, value) => {
    const f = fixture(),
      row = f.contexts[0]?.rows[0];
    if (!row) throw new Error("Missing first transaction context");
    row[field as string] = value;
    await rejectedCut(f);
    expect(f.calls).toHaveLength(1);
  });
  it.each(["backend_pid", "transaction_id"])(
    "rejects a changed native %s after otherwise valid source reads",
    async (field) => {
      const f = fixture(),
        row = f.contexts[1]?.rows[0];
      if (!row) throw new Error("Missing final transaction context");
      row[field] =
        field === "backend_pid"
          ? Number(row[field]) + 1
          : (BigInt(row[field] as string) + 1n).toString();
      await rejectedCut(f);
      expect(f.calls.some((c) => c.sql.includes("reservation_profile"))).toBe(true);
    },
  );
  it.each(["first_missing", "first_duplicate", "last_missing", "last_duplicate"])(
    "rejects an incomplete native transaction envelope: %s",
    async (kind) => {
      const f = fixture(),
        context = f.contexts[kind.startsWith("first") ? 0 : 1];
      if (!context) throw new Error("Missing transaction envelope");
      if (kind.endsWith("missing")) context.rows = [];
      else context.rows.push({ ...context.rows[0] });
      await rejectedCut(f);
    },
  );
  it("fails wholly when original source validation rejects before any reservation query", async () => {
    const f = fixture(),
      header = f.observations.find((q) => q.sql.includes("proofstack_read_release_decision_input("))
        ?.rows[0]?.["value"] as Record<string, unknown>;
    header["definition_sha256"] = "0".repeat(64);
    await rejectedCut(f);
    expect(f.calls.some((c) => c.sql.includes("reservation_profile"))).toBe(false);
  });
  it("requires the actual original meter before I/O and preserves a previously exhausted meter", async () => {
    const f = fixture();
    await expect(read(f, {} as ReleaseDecisionVerificationBudget)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    const budget = meter();
    const failure = new Error("Earlier domain failed");
    let original: unknown;
    try {
      budget.rejectSourceRead(failure);
    } catch (error) {
      original = error;
    }
    await expect(read(f, budget)).rejects.toBe(original);
    expect(f.calls).toEqual([]);
  });
  it("validates exact scope and reference before any source query", async () => {
    const f = fixture();
    await expect(
      readPostgresReleaseDecisionReservationsOnClient(
        f.client,
        { tenantId: "bad" } as EvidenceScope,
        reference(f),
        meter(),
      ),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    await expect(
      readPostgresReleaseDecisionReservationsOnClient(
        f.client,
        f.graph.request.scope,
        { ...reference(f), decisionInputRequestId: "bad-id" },
        meter(),
      ),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(f.calls).toEqual([]);
  });
});
