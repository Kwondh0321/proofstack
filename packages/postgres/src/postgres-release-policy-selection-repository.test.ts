import { readFileSync } from "node:fs";
import type { EvidenceScope } from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  ReleasePolicySelectionRepositoryError,
  type OwnedReleasePolicySelectionTarget,
  type ReleasePolicySelectionTarget,
} from "@proofstack/core";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresReleasePolicySelectionRepository,
  readPostgresReleasePolicySelectionOnClient,
  readPostgresReleaseSelectionLifecycleOnClient,
  readPostgresReleaseSelectionTargetOnClient,
} from "./postgres-release-policy-selection-repository.js";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";

// Actual PostgreSQL 16.15 wire responses from the separate native conformance fixture.
// This is a transport fixture, not a substitute for native SQL/locking or an independent oracle.
const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/release-selection-native-wire-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  format: string;
  scope: EvidenceScope;
  target: ReleasePolicySelectionTarget;
  rootObservation: unknown;
  versions: Record<string, unknown>[];
  events: Record<string, unknown>[];
  census: OwnedReleasePolicySelectionTarget;
};
if (wire.format !== "proofstack.release-selection-native-wire.v1" || !wire.census.root)
  throw new Error("Invalid native fixture");
const original = wire.census.root;
const successor = wire.census.records.find((row) => row.predecessor);
const supersession = wire.census.lifecycle.find((row) => row.kind === "superseded");
const withdrawal = wire.census.lifecycle.find((row) => row.kind === "withdrawn");
if (!successor || !supersession || !withdrawal) throw new Error("Incomplete native fixture");
function get(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = (current as Record<string, unknown>)[key];
  return current;
}
function put(value: unknown, path: readonly string[], replacement: unknown) {
  const parent = get(value, path.slice(0, -1)) as Record<string, unknown>;
  const key = path.at(-1);
  if (!key) throw new Error("Missing fixture path");
  parent[key] = replacement;
}
const limits = {
  maxAcquisitionRecords: 100000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 4096,
};
const meter = () => new ReleaseDecisionVerificationBudget(limits);
function fixture() {
  const state = {
    rootRows: [{ value: structuredClone(wire.rootObservation) }] as { value: unknown }[],
    versions: new Map(
      wire.versions.map((row) => [
        String(get(row, ["version", "record", "selectionVersionId"])),
        structuredClone(row),
      ]),
    ),
    events: new Map(
      wire.events.map((row) => [
        String(get(row, ["event", "record", "eventId"])),
        structuredClone(row),
      ]),
    ),
    versionIds: wire.census.records.map((row) => row.selectionVersionId).sort(),
    eventIds: wire.census.lifecycle.map((row) => row.eventId).sort(),
    versionRows: undefined as unknown[] | undefined,
    eventRows: undefined as unknown[] | undefined,
    versionPage: undefined as { version_id: unknown }[] | undefined,
    eventPage: undefined as { event_id: unknown }[] | undefined,
    writeCreated: true as unknown,
    writeRecord: undefined as unknown,
    writeRows: undefined as unknown[] | undefined,
    failOn: "",
    failure: new Error("isolated native source unavailable"),
    failBegin: false,
    failCommit: false,
    failRollback: false,
  };
  const calls: { sql: string; values?: readonly unknown[] }[] = [],
    released: (boolean | undefined)[] = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, ...(values ? { values } : {}) });
      if (
        (state.failOn && sql.includes(state.failOn)) ||
        (state.failBegin && sql.startsWith("BEGIN")) ||
        (state.failCommit && sql === "COMMIT")
      )
        throw state.failure;
      if (sql === "ROLLBACK" && state.failRollback) throw new Error("rollback unavailable");
      if (
        sql.startsWith("BEGIN") ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.includes("set_config(")
      )
        return { rows: [] };
      if (sql.includes("proofstack_read_release_selection_root")) return { rows: state.rootRows };
      if (sql.includes("proofstack_store_release_policy_selection"))
        return {
          rows: state.writeRows ?? [
            { value: { created: state.writeCreated, record: state.writeRecord ?? original } },
          ],
        };
      if (sql.includes("proofstack_store_release_selection_lifecycle"))
        return {
          rows: state.writeRows ?? [
            { value: { created: state.writeCreated, record: state.writeRecord ?? supersession } },
          ],
        };
      if (sql.includes("SELECT version_id"))
        return {
          rows:
            state.versionPage ??
            state.versionIds
              .filter((id) => id > String(values?.[2]))
              .slice(0, 16)
              .map((version_id) => ({ version_id })),
        };
      if (sql.includes("SELECT e.event_id"))
        return {
          rows:
            state.eventPage ??
            state.eventIds
              .filter((id) => id > String(values?.[2]))
              .slice(0, 16)
              .map((event_id) => ({ event_id })),
        };
      if (sql.includes("AS root_version")) {
        const row = state.versions.get(String(values?.[3]));
        return { rows: state.versionRows ?? (row ? [row] : []) };
      }
      if (sql.includes("AS event")) {
        const row = state.events.get(String(values?.[3]));
        return { rows: state.eventRows ?? (row ? [row] : []) };
      }
      throw new Error("Unexpected owning native query");
    },
    release(destroyed?: boolean) {
      released.push(destroyed);
    },
  };
  const view = client as unknown as Pick<PoolClient, "query">;
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      return client;
    },
  } as unknown as Pick<Pool, "connect">;
  const repository = new PostgresReleasePolicySelectionRepository(pool);
  return { state, calls, released, view, repository, connections: () => connections };
}
function nativeView(f: ReturnType<typeof fixture>, id = original.selectionVersionId) {
  const value = f.state.versions.get(id);
  if (!value) throw new Error("Missing fixture view");
  return value;
}

describe("owning native selection wire integrity and original admission", () => {
  it("retains the entire original owner, competing/future versions and terminal history", async () => {
    const f = fixture(),
      budget = meter();
    expect(
      await readPostgresReleaseSelectionTargetOnClient(f.view, wire.scope, wire.target, budget),
    ).toEqual(wire.census);
    expect(budget.snapshot().approvalRecords).toBe(0);
    expect(f.calls[0]?.sql).toContain("proofstack_read_release_selection_root");
    expect(f.calls.some(({ sql }) => /\bBEGIN\b|\bCOMMIT\b|\bUPDATE\b|\bINSERT\b/.test(sql))).toBe(
      false,
    );
  });
  it("keeps missing owning selection distinct from an explicit empty observation-only declaration", async () => {
    const f = fixture(),
      budget = meter();
    f.state.rootRows = [{ value: { root: null, orphan: false } }];
    expect(
      await readPostgresReleaseSelectionTargetOnClient(f.view, wire.scope, wire.target, budget),
    ).toEqual({ root: null, records: [], lifecycle: [] });
    expect(budget.snapshot().records).toBe(1);
    expect(f.calls).toHaveLength(1);
  });
  it("validates exact version and both exact terminal kinds without starting a transaction", async () => {
    const f = fixture();
    expect(
      await readPostgresReleasePolicySelectionOnClient(
        f.view,
        wire.scope,
        original.selectionVersionId,
      ),
    ).toEqual(original);
    expect(
      await readPostgresReleasePolicySelectionOnClient(
        f.view,
        wire.scope,
        successor.selectionVersionId,
      ),
    ).toEqual(successor);
    expect(
      await readPostgresReleaseSelectionLifecycleOnClient(f.view, wire.scope, supersession.eventId),
    ).toEqual(supersession);
    expect(
      await readPostgresReleaseSelectionLifecycleOnClient(f.view, wire.scope, withdrawal.eventId),
    ).toEqual(withdrawal);
    expect(f.calls.some(({ sql }) => sql.includes("BEGIN"))).toBe(false);
  });
  it("retains absent exact versions/events and admits the version absence", async () => {
    const f = fixture(),
      budget = meter();
    expect(
      await readPostgresReleasePolicySelectionOnClient(
        f.view,
        wire.scope,
        "version_absent",
        budget,
      ),
    ).toBeNull();
    expect(budget.snapshot().records).toBe(1);
    expect(
      await readPostgresReleaseSelectionLifecycleOnClient(f.view, wire.scope, "event_absent"),
    ).toBeNull();
  });
  it.each([
    ["version", "tenant_id"],
    ["version", "project_id"],
    ["version", "environment_id"],
    ["version", "version_id"],
    ["version", "definition_sha256"],
    ["version", "published_at_key"],
    ["version", "canonical_utf8"],
    ["version", "policy_count"],
    ["version", "publisher_count"],
    ["root", "root_version_id"],
    ["root", "root_definition_sha256"],
    ["root_version", "canonical_utf8"],
    ["root_version", "record", "definitionSha256"],
    ["version", "record", "rationale"],
  ])("rejects changed normalized/original version field %j", async (...path) => {
    const f = fixture();
    put(nativeView(f), path, "forged_native_field");
    await expect(
      readPostgresReleasePolicySelectionOnClient(f.view, wire.scope, original.selectionVersionId),
    ).rejects.toThrow();
  });
  it.each(["policies", "publishers", "intents"])(
    "does not accept a missing/extra normalized %s projection",
    async (kind) => {
      for (const replacement of [[], [{}, {}]]) {
        const f = fixture();
        put(nativeView(f), [kind], replacement);
        await expect(
          readPostgresReleasePolicySelectionOnClient(
            f.view,
            wire.scope,
            original.selectionVersionId,
          ),
        ).rejects.toThrow();
      }
    },
  );
  it("rejects wrong publisher, child ownership and native intent time without changing definitions", async () => {
    for (const [path, value] of [
      [["publishers", "0", "principal_id"], "principal_other"],
      [["policies", "0", "project_id"], "project_other"],
      [["intents", "0", "timeMatches"], false],
    ] as const) {
      const f = fixture();
      put(nativeView(f), path, value);
      await expect(
        readPostgresReleasePolicySelectionOnClient(f.view, wire.scope, original.selectionVersionId),
      ).rejects.toThrow();
    }
  });
  it("rejects missing, wrong or unexpected original parent observations", async () => {
    for (const value of [null, {}, get(wire.versions[1], ["version"])]) {
      const f = fixture();
      put(nativeView(f, successor.selectionVersionId), ["predecessor"], structuredClone(value));
      await expect(
        readPostgresReleasePolicySelectionOnClient(
          f.view,
          wire.scope,
          successor.selectionVersionId,
        ),
      ).rejects.toThrow();
    }
    const f = fixture();
    put(nativeView(f), ["predecessor"], {});
    await expect(
      readPostgresReleasePolicySelectionOnClient(f.view, wire.scope, original.selectionVersionId),
    ).rejects.toThrow();
  });
  it.each([
    "event_id",
    "version_id",
    "definition_sha256",
    "occurred_at_key",
    "successor_version_id",
  ])("rejects changed normalized event %s", async (field) => {
    const f = fixture(),
      view = f.state.events.get(supersession.eventId);
    if (!view) throw new Error("Missing event");
    put(view, ["event", field], "forged_native_field");
    await expect(
      readPostgresReleaseSelectionLifecycleOnClient(f.view, wire.scope, supersession.eventId),
    ).rejects.toThrow();
  });
  it("rejects events whose original version/successor or canonical intent is unavailable", async () => {
    for (const id of [original.selectionVersionId, successor.selectionVersionId]) {
      const f = fixture();
      f.state.versions.delete(id);
      await expect(
        readPostgresReleaseSelectionLifecycleOnClient(f.view, wire.scope, supersession.eventId),
      ).rejects.toThrow();
    }
    const f = fixture(),
      view = f.state.events.get(supersession.eventId);
    if (!view) throw new Error("Missing event");
    put(view, ["intents"], []);
    await expect(
      readPostgresReleaseSelectionLifecycleOnClient(f.view, wire.scope, supersession.eventId),
    ).rejects.toThrow();
  });
  it("rejects duplicate native rows instead of choosing the first", async () => {
    const f = fixture();
    f.state.versionRows = [nativeView(f), nativeView(f)];
    await expect(
      readPostgresReleasePolicySelectionOnClient(f.view, wire.scope, original.selectionVersionId),
    ).rejects.toThrow();
    f.state.eventRows = [wire.events[0], wire.events[0]];
    await expect(
      readPostgresReleaseSelectionLifecycleOnClient(f.view, wire.scope, supersession.eventId),
    ).rejects.toThrow();
  });
  it.each([
    "empty_root",
    "orphan",
    "missing_root_body",
    "missing_inventory_root",
    "missing_version",
    "out_of_order",
    "too_many",
  ])("rejects incomplete/ambiguous census %s and taints its original meter", async (kind) => {
    const f = fixture(),
      budget = meter();
    if (kind === "empty_root") f.state.rootRows = [];
    if (kind === "orphan") f.state.rootRows = [{ value: { root: null, orphan: true } }];
    if (kind === "missing_root_body") f.state.versions.delete(original.selectionVersionId);
    if (kind === "missing_inventory_root") f.state.versionIds = [successor.selectionVersionId];
    if (kind === "missing_version") f.state.versionIds.push("version_unknown");
    if (kind === "out_of_order") f.state.versionIds.reverse();
    if (kind === "too_many")
      f.state.versionPage = Array.from({ length: 17 }, () => ({
        version_id: original.selectionVersionId,
      }));
    await expect(
      readPostgresReleaseSelectionTargetOnClient(f.view, wire.scope, wire.target, budget),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it.each(["missing", "out_of_order", "too_many"])(
    "rejects incomplete event inventory %s",
    async (kind) => {
      const f = fixture(),
        budget = meter();
      if (kind === "missing") f.state.events.clear();
      if (kind === "out_of_order") f.state.eventIds.reverse();
      if (kind === "too_many")
        f.state.eventPage = Array.from({ length: 17 }, () => ({ event_id: supersession.eventId }));
      await expect(
        readPostgresReleaseSelectionTargetOnClient(f.view, wire.scope, wire.target, budget),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it("admits exact aggregate source counts/UTF-8 bytes and refuses either one below", async () => {
    const f = fixture(),
      reference = meter();
    await readPostgresReleaseSelectionTargetOnClient(f.view, wire.scope, wire.target, reference);
    const usage = reference.snapshot();
    for (const [records, bytes, pass] of [
      [usage.records, usage.recordBytes, true],
      [usage.records - 1, usage.recordBytes, false],
      [usage.records, usage.recordBytes - 1, false],
    ] as const) {
      const v = fixture(),
        budget = new ReleaseDecisionVerificationBudget({
          ...limits,
          maxAcquisitionRecords: records,
          maxAcquisitionRecordBytes: bytes,
        });
      if (pass) {
        expect(
          await readPostgresReleaseSelectionTargetOnClient(v.view, wire.scope, wire.target, budget),
        ).toEqual(wire.census);
        expect(budget.snapshot()).toEqual(usage);
      } else {
        await expect(
          readPostgresReleaseSelectionTargetOnClient(v.view, wire.scope, wire.target, budget),
        ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
        expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      }
    }
  });
  it("admit raw bytes before deep interpretation and never reads again after a caught failure", async () => {
    const f = fixture(),
      budget = new ReleaseDecisionVerificationBudget({
        ...limits,
        maxAcquisitionRecordBytes: 8192,
      });
    put(nativeView(f), ["oversized_native_observation"], "x".repeat(1024 * 1024));
    await expect(
      readPostgresReleasePolicySelectionOnClient(
        f.view,
        wire.scope,
        original.selectionVersionId,
        budget,
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
    const calls = f.calls.length;
    await expect(
      readPostgresReleasePolicySelectionOnClient(
        f.view,
        wire.scope,
        original.selectionVersionId,
        budget,
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
    expect(f.calls).toHaveLength(calls);
  });
  it("rejects fake/tainted meters before source lookup or acquiring a new connection", async () => {
    const f = fixture();
    await expect(
      readPostgresReleasePolicySelectionOnClient(
        f.view,
        wire.scope,
        original.selectionVersionId,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ReleasePolicySelectionRepositoryError);
    await expect(
      readPostgresReleaseSelectionTargetOnClient(f.view, wire.scope, wire.target, {} as never),
    ).rejects.toBeInstanceOf(ReleasePolicySelectionRepositoryError);
    expect(() =>
      f.repository.readReleasePolicySelectionTarget(wire.scope, wire.target, {} as never),
    ).toThrow(ReleasePolicySelectionRepositoryError);
    const budget = meter();
    expect(() => budget.rejectSourceRead(f.state.failure)).toThrow();
    expect(() =>
      f.repository.readReleasePolicySelectionTarget(wire.scope, wire.target, budget),
    ).toThrow(ReleaseDecisionVerificationBudgetError);
    expect(f.connections()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    "read_release_selection_root",
    "AS root_version",
    "SELECT version_id",
    "SELECT e.event_id",
    "AS event",
  ])("preserves owning read failure %s instead of reporting an absent source", async (sql) => {
    const f = fixture(),
      budget = meter();
    f.state.failOn = sql;
    await expect(
      readPostgresReleaseSelectionTargetOnClient(f.view, wire.scope, wire.target, budget),
    ).rejects.toMatchObject({ cause: f.state.failure });
    expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it("returns independent public records and full owning inventory through exact scoped transactions", async () => {
    const f = fixture();
    expect(
      await f.repository.findReleasePolicySelection(wire.scope, original.selectionVersionId),
    ).toEqual(original);
    expect(
      await f.repository.findReleasePolicySelectionLifecycleEvent(wire.scope, supersession.eventId),
    ).toEqual(supersession);
    expect(
      await f.repository.readReleasePolicySelectionTarget(wire.scope, wire.target, meter()),
    ).toEqual(wire.census);
    expect(f.calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(3);
    expect(f.released).toEqual([undefined, undefined, undefined]);
  });
  it.each(["failBegin", "failCommit"] as const)(
    "taints the original meter when the owning transaction fails at %s",
    async (point) => {
      const f = fixture(),
        budget = meter();
      f.state[point] = true;
      await expect(
        f.repository.readReleasePolicySelectionTarget(wire.scope, wire.target, budget),
      ).rejects.toMatchObject({ cause: f.state.failure });
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      expect(f.calls.at(-1)?.sql).toBe(
        point === "failBegin" ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "ROLLBACK",
      );
      expect(f.released).toEqual([point === "failBegin" ? true : undefined]);
    },
  );
  it("taints a failed pool acquisition without inventing a source observation", async () => {
    const failure = new Error("fixture pool unavailable"),
      budget = meter();
    const repository = new PostgresReleasePolicySelectionRepository({
      connect: async () => {
        throw failure;
      },
    } as never);
    await expect(
      repository.readReleasePolicySelectionTarget(wire.scope, wire.target, budget),
    ).rejects.toMatchObject({ cause: failure });
    expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it.each([true, false])(
    "preserves native publication receipts and actual created=%s",
    async (created) => {
      const f = fixture();
      f.state.writeCreated = created;
      expect(await f.repository.publishReleasePolicySelection(original)).toEqual({
        created,
        selection: original,
      });
      expect(f.calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(f.calls.at(-1)?.sql).toBe("COMMIT");
      expect(f.released).toEqual([undefined]);
      const event = fixture();
      event.state.writeCreated = created;
      expect(
        await event.repository.publishReleasePolicySelectionLifecycleEvent(supersession),
      ).toEqual({ created, event: supersession });
    },
  );
  it.each([
    "version_conflict",
    "target_conflict",
    "lineage_invalid",
    "event_conflict",
    "terminal_conflict",
    "receipt_invalid",
  ])("keeps native %s without partial commit", async (reason) => {
    const f = fixture();
    f.state.failOn = "proofstack_store";
    Object.assign(f.state.failure, { code: "P0001", message: `release_selection:${reason}` });
    await expect(f.repository.publishReleasePolicySelection(original)).rejects.toMatchObject({
      reason,
    });
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.released).toEqual([undefined]);
  });
  it.each(["23514", "23503", "23505", "22023", "22P02", "P0002"])(
    "maps native projection rejection %s to storage integrity failure",
    async (code) => {
      const f = fixture();
      f.state.failOn = "proofstack_store";
      Object.assign(f.state.failure, { code });
      await expect(
        f.repository.publishReleasePolicySelectionLifecycleEvent(supersession),
      ).rejects.toMatchObject({ reason: "storage_invalid" });
      expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    },
  );
  it.each(["version", "event"])(
    "rejects malformed %s write acknowledgement and rolls back wholly",
    async (kind) => {
      for (const rows of [
        [],
        [{ value: { created: "true", record: original } }],
        [{ value: { created: true, record: null } }],
      ]) {
        const f = fixture();
        f.state.writeRows = rows;
        const promise =
          kind === "version"
            ? f.repository.publishReleasePolicySelection(original)
            : f.repository.publishReleasePolicySelectionLifecycleEvent(supersession);
        await expect(promise).rejects.toThrow();
        expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
      }
    },
  );
  it("destroys a connection on failed begin or rollback, preserving the actual operation failure", async () => {
    const a = fixture();
    a.state.failBegin = true;
    await expect(a.repository.publishReleasePolicySelection(original)).rejects.toBe(
      a.state.failure,
    );
    expect(a.released).toEqual([true]);
    const b = fixture();
    b.state.failOn = "proofstack_store";
    b.state.failRollback = true;
    await expect(
      b.repository.publishReleasePolicySelectionLifecycleEvent(supersession),
    ).rejects.toBeInstanceOf(PostgresTransactionCleanupError);
    expect(b.released).toEqual([true]);
    const c = fixture();
    c.state.failOn = "proofstack_store";
    Object.assign(c.state.failure, { code: "P0001", message: "unrecognized native failure" });
    await expect(c.repository.publishReleasePolicySelection(original)).rejects.toBe(
      c.state.failure,
    );
  });
});
