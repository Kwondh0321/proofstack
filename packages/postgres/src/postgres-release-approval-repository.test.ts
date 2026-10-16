import { readFileSync } from "node:fs";
import type { EvidenceScope, ReleaseApprovalSubject, ReleaseApproval } from "@proofstack/contracts";
import {
  ReleaseApprovalRepositoryError,
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  type OwnedReleaseApprovalSubject,
} from "@proofstack/core";
import { approvalVersion, approvalRevocation } from "@proofstack/core/testing";
import type { Pool, PoolClient } from "pg";
import { describe, it, expect } from "vitest";
import {
  PostgresReleaseApprovalRepository,
  readPostgresReleaseApprovalOnClient,
  readPostgresReleaseApprovalRevocationOnClient,
  readPostgresReleaseApprovalSubjectOnClient,
} from "./postgres-release-approval-repository.js";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";

// Actual synthetic PostgreSQL 16.15 observations. Transport corruption tests complement required
// native SQL/locking/conformance/recovery gates; this fixture is not an independent SQL oracle.
const wire = JSON.parse(
  readFileSync(new URL("./fixtures/approval-native-wire-v1.json", import.meta.url), "utf8"),
) as {
  format: string;
  scope: EvidenceScope;
  subject: ReleaseApprovalSubject;
  probes: Record<ReleaseApproval["kind"], unknown>;
  views: Record<string, unknown>[];
  events: Record<string, unknown>[];
  censuses: Record<ReleaseApproval["kind"], OwnedReleaseApprovalSubject>;
};
if (wire.format !== "proofstack.release-approval-native-wire.v1")
  throw new Error("Invalid wire fixture");
const original = wire.censuses.normal_approval.records.find((row) => !row.supersedes),
  successor = wire.censuses.normal_approval.records.find((row) => row.supersedes),
  exception = wire.censuses.rule_exception.records[0],
  revocation = wire.censuses.normal_approval.revocations[0];
if (!original || !successor || !exception || !revocation)
  throw new Error("Incomplete native wire fixture");
const originalId = original.approvalId;
function get(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = (current as Record<string, unknown>)[key];
  return current;
}
function put(value: unknown, path: readonly string[], replacement: unknown) {
  const parent = get(value, path.slice(0, -1)) as Record<string, unknown>,
    key = path.at(-1);
  if (!key) throw new Error("Missing fixture key");
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
    probes: structuredClone(wire.probes),
    probeRows: undefined as unknown[] | undefined,
    views: new Map(
      wire.views.map((row) => [
        String(get(row, ["approval", "record", "approvalId"])),
        structuredClone(row),
      ]),
    ),
    events: new Map(
      wire.events.map((row) => [
        String(get(row, ["event", "record", "eventId"])),
        structuredClone(row),
      ]),
    ),
    approvalIds: {
      normal_approval: wire.censuses.normal_approval.records.map((row) => row.approvalId).sort(),
      rule_exception: wire.censuses.rule_exception.records.map((row) => row.approvalId).sort(),
    },
    eventIds: {
      normal_approval: wire.censuses.normal_approval.revocations.map((row) => row.eventId).sort(),
      rule_exception: [] as string[],
    },
    approvalPage: undefined as { approval_id: unknown }[] | undefined,
    eventPage: undefined as { event_id: unknown }[] | undefined,
    viewRows: undefined as unknown[] | undefined,
    eventRows: undefined as unknown[] | undefined,
    writeCreated: true as unknown,
    writeRecord: undefined as unknown,
    writeRows: undefined as unknown[] | undefined,
    failOn: "",
    failure: new Error("synthetic native source unavailable"),
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
      if (sql === "ROLLBACK" && state.failRollback)
        throw new Error("synthetic rollback unavailable");
      if (
        sql.startsWith("BEGIN") ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.includes("set_config(")
      )
        return { rows: [] };
      if (sql.includes("proofstack_read_release_approval_subject"))
        return {
          rows: state.probeRows ?? [
            { value: state.probes[String(values?.[1]) as ReleaseApproval["kind"]] },
          ],
        };
      if (sql.includes("proofstack_store_release_approval_revocation("))
        return {
          rows: state.writeRows ?? [
            { value: { created: state.writeCreated, record: state.writeRecord ?? revocation } },
          ],
        };
      if (sql.includes("proofstack_store_release_approval("))
        return {
          rows: state.writeRows ?? [
            { value: { created: state.writeCreated, record: state.writeRecord ?? original } },
          ],
        };
      if (sql.startsWith("SELECT approval_id"))
        return {
          rows:
            state.approvalPage ??
            state.approvalIds[String(values?.[3]) as ReleaseApproval["kind"]]
              .filter((id) => id > String(values?.[5]))
              .slice(0, 16)
              .map((approval_id) => ({ approval_id })),
        };
      if (sql.startsWith("SELECT e.event_id"))
        return {
          rows:
            state.eventPage ??
            state.eventIds[String(values?.[3]) as ReleaseApproval["kind"]]
              .filter((id) => id > String(values?.[5]))
              .slice(0, 16)
              .map((event_id) => ({ event_id })),
        };
      if (sql.includes("AS approval")) {
        const row = state.views.get(String(values?.[3]));
        return { rows: state.viewRows ?? (row ? [row] : []) };
      }
      if (sql.includes("AS event")) {
        const row = state.events.get(String(values?.[3]));
        return { rows: state.eventRows ?? (row ? [row] : []) };
      }
      throw new Error("Unexpected native query");
    },
    release(destroy?: boolean) {
      released.push(destroy);
    },
  };
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      return client;
    },
  } as unknown as Pick<Pool, "connect">;
  return {
    state,
    calls,
    released,
    view: client as unknown as Pick<PoolClient, "query">,
    repository: new PostgresReleaseApprovalRepository(pool),
    connections: () => connections,
  };
}
function native(f: ReturnType<typeof fixture>, id = originalId) {
  const row = f.state.views.get(id);
  if (!row) throw new Error("Missing fixture view");
  return row;
}
async function census(
  f: ReturnType<typeof fixture>,
  budget = meter(),
  kind: ReleaseApproval["kind"] = "normal_approval",
) {
  return readPostgresReleaseApprovalSubjectOnClient(f.view, wire.scope, kind, wire.subject, budget);
}

describe("owning native approval originals, normalized lineage and first receipts", () => {
  it.each(["normal_approval", "rule_exception"] as const)(
    "retains the entire %s subject without selecting favorable actions",
    async (kind) => {
      const f = fixture();
      expect(await census(f, meter(), kind)).toEqual(wire.censuses[kind]);
      expect(
        f.calls.some(({ sql }) => /\bBEGIN\b|\bCOMMIT\b|\bINSERT\b|\bUPDATE\b/.test(sql)),
      ).toBe(false);
    },
  );
  it("keeps exact subject absence one observation without inventing approval actors", async () => {
    const f = fixture(),
      budget = meter();
    f.state.probes.normal_approval = {
      kind: "normal_approval",
      subject: wire.subject,
      present: false,
    };
    expect(await census(f, budget)).toEqual({ records: [], revocations: [] });
    expect(budget.snapshot().records).toBe(1);
    expect(budget.snapshot().approvalRecords).toBe(0);
    expect(f.calls).toHaveLength(1);
  });
  it("reads original/successor/exception/revocation and retains absent exact identities", async () => {
    const f = fixture();
    for (const row of [original, successor, exception])
      expect(await readPostgresReleaseApprovalOnClient(f.view, wire.scope, row.approvalId)).toEqual(
        row,
      );
    expect(
      await readPostgresReleaseApprovalRevocationOnClient(f.view, wire.scope, revocation.eventId),
    ).toEqual(revocation);
    const budget = meter();
    expect(
      await readPostgresReleaseApprovalOnClient(f.view, wire.scope, "approval_absent", budget),
    ).toBeNull();
    expect(budget.snapshot().approvalRecords).toBe(1);
    expect(
      await readPostgresReleaseApprovalRevocationOnClient(
        f.view,
        wire.scope,
        "event_absent",
        meter(),
      ),
    ).toBeNull();
  });
  it.each([
    ["approval", "tenant_id"],
    ["approval", "project_id"],
    ["approval", "environment_id"],
    ["approval", "approval_id"],
    ["approval", "definition_sha256"],
    ["approval", "kind"],
    ["approval", "action"],
    ["approval", "job_id"],
    ["approval", "rule_id"],
    ["approval", "reviewer_principal_id"],
    ["approval", "credential_id"],
    ["approval", "authentication_request_id"],
    ["approval", "authenticated_at_key"],
    ["approval", "recorded_at_key"],
    ["approval", "expires_at_key"],
    ["approval", "condition_count"],
    ["approval", "conflict_count"],
    ["approval", "control_count"],
    ["approval", "canonical_utf8"],
    ["approval", "record", "rationale"],
    ["approval", "record", "definitionSha256"],
  ])("rejects changed original/normalized field %j", async (...path) => {
    const f = fixture();
    put(native(f), path, "forged_native_field");
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, original.approvalId),
    ).rejects.toThrow();
  });
  it.each(["sources", "declarations", "controls", "intents"])(
    "rejects missing/extra normalized %s",
    async (key) => {
      for (const replacement of [[], [{}, {}]]) {
        const f = fixture();
        put(native(f, exception.approvalId), [key], replacement);
        await expect(
          readPostgresReleaseApprovalOnClient(f.view, wire.scope, exception.approvalId),
        ).rejects.toThrow();
      }
    },
  );
  it.each([
    ["sources", "0", "source_id"],
    ["sources", "0", "source_definition_sha256"],
    ["sources", "0", "project_id"],
    ["declarations", "0", "ordinal"],
    ["declarations", "0", "kind"],
    ["controls", "0", "artifact_id"],
    ["controls", "0", "ordinal"],
  ])("rejects original source/declaration/control slot substitution %j", async (...path) => {
    const f = fixture();
    put(native(f, exception.approvalId), path, "forged_projection");
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, exception.approvalId),
    ).rejects.toThrow();
  });
  it("rejects changed native intent time and preserves a caught failure on the original meter", async () => {
    const f = fixture(),
      budget = meter();
    put(native(f), ["intents", "0", "timeMatches"], false);
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, original.approvalId, budget),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(() => budget.snapshot()).toThrow();
  });
  it("checks full original parent/successor provenance instead of trusting an exact-looking ID", async () => {
    for (const [id, key] of [
      [successor.approvalId, "parent"],
      [original.approvalId, "successor"],
    ] as const) {
      const f = fixture();
      put(native(f, id), [key], {});
      await expect(readPostgresReleaseApprovalOnClient(f.view, wire.scope, id)).rejects.toThrow();
    }
    const f = fixture();
    put(native(f, successor.approvalId), ["parent"], null);
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, successor.approvalId),
    ).rejects.toThrow();
    put(native(f), ["parent"], {});
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, original.approvalId),
    ).rejects.toThrow();
  });
  it.each([
    "event_id",
    "approval_id",
    "approval_definition_sha256",
    "reviewer_principal_id",
    "occurred_at_key",
  ])("rejects changed native revocation %s", async (key) => {
    const f = fixture(),
      row = f.state.events.get(revocation.eventId);
    if (!row) throw new Error("Missing event");
    put(row, ["event", key], "forged_event");
    await expect(
      readPostgresReleaseApprovalRevocationOnClient(f.view, wire.scope, revocation.eventId),
    ).rejects.toThrow();
  });
  it("rejects missing original and noncanonical revocation intent", async () => {
    const f = fixture();
    f.state.views.delete(original.approvalId);
    await expect(
      readPostgresReleaseApprovalRevocationOnClient(
        f.view,
        wire.scope,
        revocation.eventId,
        meter(),
      ),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    const v = fixture(),
      row = v.state.events.get(revocation.eventId);
    if (!row) throw new Error("Missing event");
    put(row, ["intents"], []);
    await expect(
      readPostgresReleaseApprovalRevocationOnClient(v.view, wire.scope, revocation.eventId),
    ).rejects.toThrow();
  });
  it("rejects duplicate raw source rows before choosing the first", async () => {
    const f = fixture();
    f.state.viewRows = [native(f), native(f)];
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, original.approvalId),
    ).rejects.toThrow();
    const v = fixture();
    v.state.eventRows = [wire.events[0], wire.events[0]];
    await expect(
      readPostgresReleaseApprovalRevocationOnClient(v.view, wire.scope, revocation.eventId),
    ).rejects.toThrow();
  });
  it.each([
    "empty_probe",
    "wrong_kind",
    "wrong_subject",
    "nonboolean",
    "empty_records",
    "missing_record",
    "out_of_order",
    "too_many",
  ])("rejects incomplete subject observation %s without a favorable prefix", async (kind) => {
    const f = fixture(),
      budget = meter();
    if (kind === "empty_probe") f.state.probeRows = [];
    if (kind === "wrong_kind")
      f.state.probes.normal_approval = {
        kind: "rule_exception",
        subject: wire.subject,
        present: true,
      };
    if (kind === "wrong_subject")
      f.state.probes.normal_approval = {
        kind: "normal_approval",
        subject: { ...wire.subject, ruleId: "rule_other" },
        present: true,
      };
    if (kind === "nonboolean")
      f.state.probes.normal_approval = {
        kind: "normal_approval",
        subject: wire.subject,
        present: "true",
      };
    if (kind === "empty_records") f.state.approvalIds.normal_approval = [];
    if (kind === "missing_record") f.state.approvalIds.normal_approval.push("approval_unknown");
    if (kind === "out_of_order") f.state.approvalIds.normal_approval.reverse();
    if (kind === "too_many")
      f.state.approvalPage = Array.from({ length: 17 }, () => ({
        approval_id: original.approvalId,
      }));
    await expect(census(f, budget)).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(() => budget.snapshot()).toThrow();
  });
  it.each(["missing", "out_of_order", "too_many"])(
    "rejects incomplete revocation pages %s",
    async (kind) => {
      const f = fixture(),
        budget = meter();
      if (kind === "missing") f.state.events.clear();
      if (kind === "out_of_order")
        f.state.eventPage = [{ event_id: revocation.eventId }, { event_id: revocation.eventId }];
      if (kind === "too_many")
        f.state.eventPage = Array.from({ length: 17 }, () => ({ event_id: revocation.eventId }));
      await expect(census(f, budget)).rejects.toBeInstanceOf(
        ReleaseDecisionVerificationBudgetError,
      );
      expect(() => budget.snapshot()).toThrow();
    },
  );
  it("admits exact records/UTF-8 bytes/approval observations and rejects each one below", async () => {
    const reference = meter();
    await census(fixture(), reference);
    const usage = reference.snapshot();
    for (const patch of [
      {},
      { maxAcquisitionRecords: usage.records - 1 },
      { maxAcquisitionRecordBytes: usage.recordBytes - 1 },
      { maxApprovalRecords: usage.approvalRecords - 1 },
    ]) {
      const budget = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: usage.records,
        maxAcquisitionRecordBytes: usage.recordBytes,
        maxApprovalRecords: usage.approvalRecords,
        ...patch,
      });
      if (Object.keys(patch).length) {
        await expect(census(fixture(), budget)).rejects.toBeInstanceOf(
          ReleaseDecisionVerificationBudgetError,
        );
        expect(() => budget.snapshot()).toThrow();
      } else {
        expect(await census(fixture(), budget)).toEqual(wire.censuses.normal_approval);
        expect(budget.snapshot()).toEqual(usage);
      }
    }
  });
  it("admits raw data before deep parsing and never looks up another source after a caught failure", async () => {
    const f = fixture(),
      budget = new ReleaseDecisionVerificationBudget({
        ...limits,
        maxAcquisitionRecordBytes: 8192,
      });
    put(native(f), ["approval", "unparsed_oversize"], "x".repeat(1024 * 1024));
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, original.approvalId, budget),
    ).rejects.toMatchObject({ reason: "byte_limit" });
    const count = f.calls.length;
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, original.approvalId, budget),
    ).rejects.toMatchObject({ reason: "byte_limit" });
    expect(f.calls).toHaveLength(count);
  });
  it("rejects fake/tainted meters and subject scope/kind mismatch before connection/source I/O", async () => {
    const f = fixture();
    await expect(
      readPostgresReleaseApprovalOnClient(f.view, wire.scope, original.approvalId, {} as never),
    ).rejects.toBeInstanceOf(ReleaseApprovalRepositoryError);
    await expect(
      readPostgresReleaseApprovalRevocationOnClient(
        f.view,
        wire.scope,
        revocation.eventId,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ReleaseApprovalRepositoryError);
    await expect(census(f, {} as never)).rejects.toBeInstanceOf(ReleaseApprovalRepositoryError);
    expect(() =>
      f.repository.readReleaseApprovalSubject(
        wire.scope,
        "normal_approval",
        wire.subject,
        {} as never,
      ),
    ).toThrow();
    const budget = meter();
    expect(() => budget.rejectSourceRead(f.state.failure)).toThrow();
    expect(() =>
      f.repository.readReleaseApprovalSubject(wire.scope, "normal_approval", wire.subject, budget),
    ).toThrow();
    expect(f.connections()).toBe(0);
    expect(f.calls).toHaveLength(0);
    await expect(
      readPostgresReleaseApprovalSubjectOnClient(
        f.view,
        { ...wire.scope, projectId: "project_other" },
        "normal_approval",
        wire.subject,
        meter(),
      ),
    ).rejects.toMatchObject({ reason: "source_read_failed" });
    await expect(census(f, meter(), "unsupported" as never)).rejects.toMatchObject({
      reason: "source_read_failed",
    });
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    "read_release_approval_subject",
    "AS approval",
    "SELECT approval_id",
    "SELECT e.event_id",
    "AS event",
  ])("preserves source failure %s and taints the cut", async (sql) => {
    const f = fixture(),
      budget = meter();
    f.state.failOn = sql;
    await expect(census(f, budget)).rejects.toMatchObject({ cause: f.state.failure });
    expect(() => budget.snapshot()).toThrow();
  });
  it("runs convenience exact/census methods in owning transactions and returns stored originals", async () => {
    const f = fixture();
    expect(await f.repository.findReleaseApproval(wire.scope, original.approvalId)).toEqual(
      original,
    );
    expect(
      await f.repository.findReleaseApprovalRevocation(wire.scope, revocation.eventId),
    ).toEqual(revocation);
    expect(
      await f.repository.readReleaseApprovalSubject(
        wire.scope,
        "normal_approval",
        wire.subject,
        meter(),
      ),
    ).toEqual(wire.censuses.normal_approval);
    expect(f.calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(3);
    expect(f.released).toEqual([undefined, undefined, undefined]);
  });
  it.each([true, false])("preserves native acknowledgement created=%s", async (created) => {
    const f = fixture();
    f.state.writeCreated = created;
    expect(await f.repository.publishReleaseApproval(original)).toEqual({
      created,
      approval: original,
    });
    expect(f.calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(f.calls.at(-1)?.sql).toBe("COMMIT");
    const v = fixture();
    v.state.writeCreated = created;
    expect(await v.repository.publishReleaseApprovalRevocation(revocation)).toEqual({
      created,
      event: revocation,
    });
  });
  it("keeps first approval and revocation receipts across new actual-login/authority/native-cut inputs", async () => {
    const f = fixture();
    f.state.writeCreated = false;
    const retry = approvalVersion(original, {
      reviewer: {
        ...original.reviewer,
        credentialId: "session_retry",
        requestId: "request_retry",
        authenticatedAt: "2026-10-15T10:10:00.000Z",
      },
      authority: {
        ...original.authority,
        authorityVersionId: "authority_retry",
        definitionSha256: "1".repeat(64),
      },
      recordedAt: "2026-10-15T10:15:00.000001Z",
    });
    expect(retry.definitionSha256).not.toBe(original.definitionSha256);
    expect(await f.repository.publishReleaseApproval(retry)).toEqual({
      created: false,
      approval: original,
    });
    const v = fixture();
    v.state.writeCreated = false;
    const event = approvalRevocation(revocation, {
      reviewer: {
        ...revocation.reviewer,
        credentialId: "session_retry",
        requestId: "request_retry",
        authenticatedAt: "2026-10-15T10:15:00.000Z",
      },
      occurredAt: "2026-10-15T10:30:00.000001Z",
    });
    expect(await v.repository.publishReleaseApprovalRevocation(event)).toEqual({
      created: false,
      event: revocation,
    });
    const created = fixture();
    await expect(created.repository.publishReleaseApproval(retry)).rejects.toThrow();
  });
  it.each([
    "approval_conflict",
    "supersession_conflict",
    "revocation_conflict",
    "revocation_state_conflict",
    "lineage_invalid",
    "receipt_invalid",
    "scope_mismatch",
  ])("preserves typed native %s and rolls back wholly", async (reason) => {
    const f = fixture();
    f.state.failOn = "proofstack_store";
    Object.assign(f.state.failure, { code: "P0001", message: `release_approval:${reason}` });
    await expect(f.repository.publishReleaseApproval(original)).rejects.toMatchObject({ reason });
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it.each(["23514", "23503", "23505", "22023", "22P02", "P0002"])(
    "maps native integrity failure %s without a partial commit",
    async (code) => {
      const f = fixture();
      f.state.failOn = "proofstack_store";
      Object.assign(f.state.failure, { code });
      await expect(f.repository.publishReleaseApprovalRevocation(revocation)).rejects.toMatchObject(
        { reason: "storage_invalid" },
      );
      expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    },
  );
  it.each(["approval", "revocation"])("rejects malformed %s acknowledgement", async (kind) => {
    for (const rows of [
      [],
      [{ value: { created: "true", record: original } }],
      [{ value: { created: true, record: null } }],
    ]) {
      const f = fixture();
      f.state.writeRows = rows;
      await expect(
        kind === "approval"
          ? f.repository.publishReleaseApproval(original)
          : f.repository.publishReleaseApprovalRevocation(revocation),
      ).rejects.toThrow();
      expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    }
  });
  it.each(["failBegin", "failCommit"] as const)(
    "taints transaction failure %s and preserves cleanup semantics",
    async (point) => {
      const f = fixture(),
        budget = meter();
      f.state[point] = true;
      await expect(
        f.repository.readReleaseApprovalSubject(
          wire.scope,
          "normal_approval",
          wire.subject,
          budget,
        ),
      ).rejects.toMatchObject({ cause: f.state.failure });
      expect(() => budget.snapshot()).toThrow();
      expect(f.released).toEqual([point === "failBegin" ? true : undefined]);
    },
  );
  it("taints failed pool/invalid scope admission without starting source I/O", async () => {
    const failure = new Error("synthetic pool unavailable"),
      budget = meter(),
      repository = new PostgresReleaseApprovalRepository({
        connect: async () => {
          throw failure;
        },
      } as never);
    await expect(
      repository.readReleaseApprovalSubject(wire.scope, "normal_approval", wire.subject, budget),
    ).rejects.toMatchObject({ cause: failure });
    expect(() => budget.snapshot()).toThrow();
    const f = fixture(),
      invalid = meter();
    expect(() =>
      f.repository.readReleaseApprovalSubject(
        { ...wire.scope, projectId: "!" },
        "normal_approval",
        wire.subject,
        invalid,
      ),
    ).toThrow();
    expect(() => invalid.snapshot()).toThrow();
    expect(f.connections()).toBe(0);
  });
  it("destroys failed begin/rollback connections while preserving the actual operation failure", async () => {
    const f = fixture();
    f.state.failBegin = true;
    await expect(f.repository.publishReleaseApproval(original)).rejects.toBe(f.state.failure);
    expect(f.released).toEqual([true]);
    const v = fixture();
    v.state.failOn = "proofstack_store";
    v.state.failRollback = true;
    await expect(v.repository.publishReleaseApprovalRevocation(revocation)).rejects.toBeInstanceOf(
      PostgresTransactionCleanupError,
    );
    expect(v.released).toEqual([true]);
    const w = fixture();
    w.state.failOn = "proofstack_store";
    Object.assign(w.state.failure, { code: "P0001", message: "unknown native rejection" });
    await expect(w.repository.publishReleaseApproval(original)).rejects.toBe(w.state.failure);
  });
});
