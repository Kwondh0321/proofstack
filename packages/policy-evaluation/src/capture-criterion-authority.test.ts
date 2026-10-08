import { createHash } from "node:crypto";
import {
  type CriterionSet,
  type CriterionSetStatusRecord,
  type EvaluationRun,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationSourceReference,
} from "@proofstack/contracts";
import {
  digestEvaluationRecordDefinition,
  evaluationRecordDescriptors,
  inspectPolicyEvaluationEvidenceRecord,
  type PolicyEvaluationEvidenceRead,
} from "@proofstack/core";
import {
  createEvaluationRepositoryTestHarness,
  criterionStatusHistoryFixture,
} from "@proofstack/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  criterionAuthorityMaterialFingerprint,
  observeCapturedCriterionAuthority,
  type PolicyCriterionAuthorityObservation,
} from "./capture-criterion-authority.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import {
  inspectCriterionStatusSelection,
  projectCriterionHistory,
} from "./criterion-history-projection.js";
import * as publicApi from "./index.js";

const evaluationTime = "2026-10-01T00:00:00.0000004Z";
const completedAt = "2026-10-01T01:00:00.000Z";
const limits = { maxRecords: 1000, maxRecordBytes: 8_388_608 };
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing authority test fixture");
  return value;
}
const ref = (record: CriterionSetStatusRecord) => ({
  statusRecordId: record.statusRecordId,
  definitionSha256: record.definitionSha256,
});
const criterionRef = (record: CriterionSet) => ({
  criterionSetId: record.criterionSetId,
  criterionSetVersionId: record.criterionSetVersionId,
  definitionSha256: record.definitionSha256,
});
const sorted = (records: readonly CriterionSetStatusRecord[]) =>
  [...records].sort((a, b) =>
    a.statusRecordId < b.statusRecordId ? -1 : a.statusRecordId > b.statusRecordId ? 1 : 0,
  );
function redigest<T extends CriterionSet | EvaluationRun>(
  kind: "criterion_set" | "evaluation_run",
  record: T,
): T {
  const definition = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  for (const key of evaluationRecordDescriptors[kind].receiptKeys) delete definition[key];
  return {
    ...record,
    definitionSha256: digestEvaluationRecordDefinition(kind, record.scope, definition),
  };
}
function fixture() {
  const h = createEvaluationRepositoryTestHarness("criterion_authority");
  const criterion = h.records.find(({ kind }) => kind === "criterion_set")?.record as CriterionSet;
  const draft = h.records.find(
    (entry) => entry.kind === "criterion_set_status" && entry.record.status === "draft",
  )?.record as CriterionSetStatusRecord;
  const approved = h.records.find(
    (entry) => entry.kind === "criterion_set_status" && entry.record.status === "approved",
  )?.record as CriterionSetStatusRecord;
  const run = h.records.find(({ kind }) => kind === "evaluation_run")?.record as EvaluationRun;
  const inspect = (source: PolicyEvaluationEvidenceRead["source"], record: unknown) =>
    inspectPolicyEvaluationEvidenceRecord({ source, scope: h.scope, evaluationTime }, record);
  const reads = [
    inspect({ kind: "criterion_set", reference: criterionRef(criterion) }, criterion),
    ...[draft, approved].map((record) =>
      inspect({ kind: "criterion_set_status", reference: ref(record) }, record),
    ),
    inspect(
      {
        kind: "evaluation_run",
        reference: { evaluationRunId: run.evaluationRunId, definitionSha256: run.definitionSha256 },
      },
      run,
    ),
  ];
  const parent = reads[3];
  if (parent?.observation.status !== "verified") throw new Error("Invalid run fixture");
  const parentRecordSha256 = parent.observation.recordSha256;
  const graph: Pick<PolicyRecordGraph, "scope" | "evaluationTime" | "nodes" | "edges"> = {
    scope: h.scope,
    evaluationTime,
    nodes: reads.map((read) => ({ read, references: [] })),
    edges: [
      { path: "/criterion/criterionSet", source: reads[0]?.source },
      { path: "/criterionStatus", source: reads[2]?.source },
    ].map(({ path, source }) => ({
      parent: parent.source,
      parentRecordSha256,
      reference: { kind: "record", path, source: source as PolicyEvaluationSourceReference },
      target: source as PolicyEvaluationSourceReference,
    })),
  };
  const state = { history: sorted([draft, approved]) };
  const repository = {
    listCriterionSetStatuses: vi.fn(async () => structuredClone(state.history)),
    findCriterionSet: vi.fn(
      async (_scope: unknown, _id: string): Promise<CriterionSet | null> => null,
    ),
  };
  const clock = { now: vi.fn(() => new Date(completedAt)) };
  const observe = async (options = limits) => {
    const result = await observeCapturedCriterionAuthority(graph, repository, clock, options);
    if (result.status !== "observed") throw new Error("Expected complete authority observation");
    return result;
  };
  const append = (...records: CriterionSetStatusRecord[]) => {
    state.history = sorted([...state.history, ...records]);
  };
  const next = (changes: Partial<CriterionSetStatusRecord> = {}) =>
    criterionStatusHistoryFixture(approved, {
      statusRecordId: "csr_withdrawn",
      status: "withdrawn",
      previousStatus: ref(approved),
      expiresAt: undefined,
      recordedAt: "2026-09-30T00:00:00.000Z",
      effectiveAt: "2026-09-30T00:00:00Z",
      ...changes,
    });
  return {
    h,
    criterion,
    draft,
    approved,
    run,
    graph,
    reads,
    state,
    repository,
    clock,
    observe,
    append,
    next,
    inspect,
  };
}
function projection(report: Extract<PolicyCriterionAuthorityObservation, { status: "observed" }>) {
  const value = report.criteria[0];
  if (!value) throw new Error("Missing criterion projection");
  return value;
}

describe("request-owned complete criterion authority", () => {
  it("binds the original run, complete bodies, full receipt hashes and repeated selection provenance", async () => {
    const f = fixture();
    const report = await f.observe();
    expect(report.history.map(({ record }) => record)).toEqual(f.state.history);
    for (const { record, recordSha256 } of report.history)
      expect(recordSha256).toBe(
        createHash("sha256").update(encodeEvaluationCanonicalJson(record)).digest("hex"),
      );
    expect(projection(report).issues).toEqual([]);
    expect(projection(report).atEvaluation.status).toBe("head");
    expect(report.selections).toMatchObject([
      {
        parent: f.reads[3]?.source,
        criterionEdgeIndex: 0,
        statusEdgeIndex: 1,
        atEvaluation: "approved_head",
        atCapture: "approved_head",
      },
    ]);
    expect(f.repository.listCriterionSetStatuses).toHaveBeenCalledWith(f.h.scope, limits);
    expect(f.repository.findCriterionSet).not.toHaveBeenCalled();
    expect(report.history[0]?.record).not.toBe(f.state.history[0]);
    expect(report.criteria[0]?.source).not.toBe(f.reads[0]?.source);
    expect(publicApi).not.toHaveProperty("observeCapturedCriterionAuthority");
    expect(publicApi).not.toHaveProperty("projectCriterionHistory");
  });

  it("skips scope history I/O only when the request graph contains no criterion source", async () => {
    const f = fixture();
    expect(
      await observeCapturedCriterionAuthority(
        { ...f.graph, nodes: [], edges: [] },
        f.repository,
        f.clock,
        limits,
      ),
    ).toEqual({ status: "not_required" });
    expect(f.repository.listCriterionSetStatuses).not.toHaveBeenCalled();
  });

  it.each(["withdrawn", "contested", "qualified", "approved"] as const)(
    "retains a later %s without replacing the run's exact selection",
    async (status) => {
      const f = fixture();
      const terminal = f.next({ status });
      f.append(terminal);
      const report = await f.observe();
      expect(report.selections[0]).toMatchObject({
        status: { kind: "criterion_set_status", reference: ref(f.approved) },
        atEvaluation: "selected_status_not_head",
        atCapture: "selected_status_not_head",
      });
      expect(
        report.history[projection(report).atEvaluation.heads[0]?.historyIndex ?? -1]?.record,
      ).toEqual(terminal);
    },
  );

  it.each(["receipt", "effective"] as const)(
    "separates policy/capture cuts when the new status %s is later",
    async (kind) => {
      const f = fixture();
      f.append(
        f.next(
          kind === "receipt"
            ? { recordedAt: "2026-10-01T00:30:00.000Z" }
            : { effectiveAt: "2026-10-01T00:30:00Z" },
        ),
      );
      const report = await f.observe();
      expect(report.selections[0]).toMatchObject({
        atEvaluation: "approved_head",
        atCapture: "selected_status_not_head",
      });
      expect(report.history).toHaveLength(3);
    },
  );

  it("keeps a future effective withdrawal without backdating it or dropping it from the fingerprint", async () => {
    const f = fixture();
    const before = await f.observe();
    f.append(f.next({ effectiveAt: "2026-10-02T00:00:00Z" }));
    const after = await f.observe();
    expect(after.selections[0]).toMatchObject({
      atEvaluation: "approved_head",
      atCapture: "approved_head",
    });
    expect(criterionAuthorityMaterialFingerprint(after)).not.toBe(
      criterionAuthorityMaterialFingerprint(before),
    );
  });

  it.each(["branch", "root"] as const)(
    "retains %s ambiguity even when one head is expired",
    async (kind) => {
      const f = fixture();
      f.append(
        kind === "branch"
          ? f.next({ previousStatus: ref(f.draft), expiresAt: "2026-09-30T23:59:59Z" })
          : criterionStatusHistoryFixture(f.draft, {
              statusRecordId: "csr_other_root",
              expiresAt: "2026-09-30T23:59:59Z",
            }),
      );
      const report = await f.observe();
      expect(report.selections[0]?.atEvaluation).toBe("history_ambiguous");
      expect(projection(report).atEvaluation.heads).toHaveLength(2);
      expect(projection(report).atEvaluation.heads.some(({ expired }) => expired)).toBe(true);
    },
  );

  it("never falls back to approved after the terminal head expires", async () => {
    const f = fixture();
    f.append(f.next({ expiresAt: "2026-09-30T23:59:59Z" }));
    const report = await f.observe();
    expect(projection(report).atEvaluation.heads).toEqual([{ historyIndex: 2, expired: true }]);
    expect(report.selections[0]?.atEvaluation).toBe("selected_status_not_head");
  });

  it.each([
    "previous_missing",
    "previous_digest_mismatch",
    "previous_criterion_mismatch",
    "previous_receipt_order",
    "criterion_receipt_order",
  ] as const)("preserves unresolved logical lineage: %s", async (reason) => {
    const f = fixture();
    let changed = f.next();
    if (reason === "previous_missing")
      changed = f.next({
        previousStatus: { statusRecordId: "csr_absent", definitionSha256: "1".repeat(64) },
      });
    if (reason === "previous_digest_mismatch") {
      const previous = f.next({ statusRecordId: "csr_intermediate", status: "qualified" });
      f.append(previous);
      changed = f.next({ previousStatus: { ...ref(previous), definitionSha256: "1".repeat(64) } });
    }
    if (reason === "previous_criterion_mismatch") {
      const other = criterionStatusHistoryFixture(f.draft, {
        statusRecordId: "csr_other",
        criterionSet: { ...f.draft.criterionSet, criterionSetVersionId: "csv_other" },
      });
      f.append(other);
      changed = f.next({ previousStatus: ref(other) });
    }
    if (reason === "previous_receipt_order")
      changed = f.next({ recordedAt: "2026-09-01T23:59:59.000Z" });
    if (reason === "criterion_receipt_order")
      changed = criterionStatusHistoryFixture(f.draft, {
        statusRecordId: "csr_early",
        recordedAt: "2026-09-01T23:59:59.000Z",
      });
    f.append(changed);
    const report = await f.observe();
    expect(projection(report).issues).toContainEqual({
      historyIndex: f.state.history.findIndex((r) => r.statusRecordId === changed.statusRecordId),
      reason,
    });
    expect(report.selections[0]?.atEvaluation).toBe("history_unresolved");
  });

  it("retains a child effective before its parent as unresolved at that cut", async () => {
    const f = fixture();
    const parent = f.next({
      statusRecordId: "csr_future_parent",
      status: "approved",
      effectiveAt: "2026-10-01T00:30:00Z",
    });
    f.append(parent, f.next({ previousStatus: ref(parent) }));
    const report = await f.observe();
    expect(projection(report).atEvaluation.inactivePredecessors).toHaveLength(1);
    expect(report.selections[0]).toMatchObject({
      atEvaluation: "history_unresolved",
      atCapture: "selected_status_not_head",
    });
  });

  it("retains unrelated criterion history in the complete fingerprint without treating a new version as revocation", async () => {
    const f = fixture();
    const before = await f.observe();
    f.append(
      criterionStatusHistoryFixture(f.draft, {
        statusRecordId: "csr_other",
        criterionSet: { ...f.draft.criterionSet, criterionSetVersionId: "csv_other" },
      }),
    );
    const after = await f.observe();
    expect(after.history).toHaveLength(3);
    expect(projection(after).historyIndexes).toHaveLength(2);
    expect(criterionAuthorityMaterialFingerprint(after)).not.toBe(
      criterionAuthorityMaterialFingerprint(before),
    );
    expect(after.selections[0]?.atEvaluation).toBe("approved_head");
  });

  it.each([
    "valid",
    "missing",
    "wrong_digest",
    "wrong_scope",
    "receipt_after_status",
    "future_receipt",
  ] as const)(
    "retains exact superseding criterion content as control evidence: %s",
    async (kind) => {
      const f = fixture();
      const successor = redigest("criterion_set", {
        ...f.criterion,
        criterionSetVersionId: "csv_successor",
        publishedAt:
          kind === "receipt_after_status"
            ? "2026-10-01T00:45:00.000Z"
            : kind === "future_receipt"
              ? "2026-10-02T00:00:00.000Z"
              : "2026-10-01T00:15:00.000Z",
      });
      const event = f.next({
        status: "superseded",
        recordedAt: "2026-10-01T00:30:00.000Z",
        supersededBy: criterionRef(successor),
      });
      f.append(event);
      f.repository.findCriterionSet.mockResolvedValue(
        kind === "missing"
          ? null
          : kind === "wrong_digest"
            ? { ...successor, definitionSha256: "1".repeat(64) }
            : kind === "wrong_scope"
              ? { ...successor, scope: { ...successor.scope, tenantId: "other" } }
              : successor,
      );
      const report = await f.observe();
      expect(report.successors).toHaveLength(1);
      expect(f.repository.findCriterionSet).toHaveBeenCalledWith(f.h.scope, "csv_successor");
      if (kind === "valid") {
        expect(report.successors[0]?.observation.status).toBe("verified");
        expect(projection(report).issues).toEqual([]);
        expect(report.selections[0]).toMatchObject({
          atEvaluation: "approved_head",
          atCapture: "selected_status_not_head",
        });
        expect(f.graph.nodes).toHaveLength(4);
      } else {
        expect(projection(report).issues).toContainEqual({
          historyIndex: 2,
          reason:
            kind === "receipt_after_status" ? "successor_receipt_order" : "successor_unavailable",
        });
        expect(report.selections[0]?.atEvaluation).toBe("history_unresolved");
      }
    },
  );

  it("reads each successor once while retaining repeated status occurrences", async () => {
    const f = fixture();
    const successor = redigest("criterion_set", {
      ...f.criterion,
      criterionSetVersionId: "csv_successor",
    });
    f.append(
      f.next({ status: "superseded", supersededBy: criterionRef(successor) }),
      f.next({
        statusRecordId: "csr_other_supersession",
        status: "superseded",
        supersededBy: criterionRef(successor),
      }),
    );
    f.repository.findCriterionSet.mockResolvedValue(successor);
    const report = await f.observe();
    expect(f.repository.findCriterionSet).toHaveBeenCalledTimes(1);
    expect(report.successors).toHaveLength(1);
    expect(report.selections[0]?.atEvaluation).toBe("history_ambiguous");
  });

  it("includes successor receipt changes in the material fingerprint even when history is unchanged", async () => {
    const f = fixture();
    const successor = redigest("criterion_set", {
      ...f.criterion,
      criterionSetVersionId: "csv_successor",
    });
    f.append(f.next({ status: "superseded", supersededBy: criterionRef(successor) }));
    f.repository.findCriterionSet.mockResolvedValue(successor);
    const before = await f.observe();
    f.repository.findCriterionSet.mockResolvedValue({
      ...successor,
      publishedByPrincipalId: "other_author",
    });
    const after = await f.observe();
    expect(after.historySha256).toBe(before.historySha256);
    expect(criterionAuthorityMaterialFingerprint(after)).not.toBe(
      criterionAuthorityMaterialFingerprint(before),
    );
    expect(criterionAuthorityMaterialFingerprint({ status: "not_required" })).not.toBe(
      criterionAuthorityMaterialFingerprint(after),
    );
  });

  it.each(["missing", "newly_available", "receipt_change", "digest_change"] as const)(
    "rejects inconsistent exact versus complete status observations: %s",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") f.state.history = [f.draft];
      if (kind === "newly_available")
        Object.assign(required(f.graph.nodes[2]).read, {
          record: null,
          observation: { status: "missing" },
        });
      if (kind === "receipt_change")
        f.state.history = sorted([
          f.draft,
          { ...f.approved, recordedByPrincipalId: "other_recorder" },
        ]);
      if (kind === "digest_change")
        f.state.history = sorted([
          f.draft,
          criterionStatusHistoryFixture(f.approved, { rationale: "Changed retained record" }),
        ]);
      await expect(f.observe()).rejects.toMatchObject({ reason: "observation_conflict" });
    },
  );

  it.each([
    "criterion_hash",
    "run_hash",
    "duplicate_node",
    "duplicate_edge",
    "missing_edge",
    "parent_hash",
    "edge_reference",
    "edge_target",
    "missing_status_node",
    "unavailable_body",
  ] as const)("rejects retained graph provenance corruption: %s", async (kind) => {
    const f = fixture();
    const nodes = [...f.graph.nodes];
    const edges = [...f.graph.edges];
    if (kind === "criterion_hash" || kind === "run_hash")
      Object.assign(required(nodes[kind === "criterion_hash" ? 0 : 3]).read.observation, {
        recordSha256: "1".repeat(64),
      });
    if (kind === "duplicate_node") nodes.push(required(nodes[0]));
    if (kind === "duplicate_edge") edges.push(required(edges[0]));
    if (kind === "missing_edge") edges.pop();
    if (kind === "parent_hash")
      Object.assign(required(edges[0]), { parentRecordSha256: "1".repeat(64) });
    if (kind === "edge_reference")
      Object.assign(required(edges[0]).reference, { source: required(f.reads[2]).source });
    if (kind === "edge_target")
      Object.assign(required(edges[0]), { target: required(f.reads[2]).source });
    if (kind === "missing_status_node") nodes.splice(2, 1);
    if (kind === "unavailable_body")
      Object.assign(required(nodes[0]).read, { observation: { status: "missing" } });
    await expect(
      observeCapturedCriterionAuthority(
        { ...f.graph, nodes, edges },
        f.repository,
        f.clock,
        limits,
      ),
    ).rejects.toMatchObject({ reason: "observation_conflict" });
  });

  it("keeps unavailable criteria unresolved and consistent missing statuses empty", async () => {
    const f = fixture();
    Object.assign(required(f.graph.nodes[0]).read, {
      record: null,
      observation: { status: "missing" },
    });
    expect((await f.observe()).selections[0]?.atEvaluation).toBe("history_unresolved");
    const g = fixture();
    g.state.history = [];
    for (const node of g.graph.nodes)
      if (node.read.source.kind === "criterion_set_status")
        Object.assign(node.read, { record: null, observation: { status: "missing" } });
    expect((await g.observe()).selections[0]?.atEvaluation).toBe("history_empty");
  });

  it.each(["clock_before_evaluation", "clock_reversed", "future_receipt"] as const)(
    "rejects impossible observation chronology: %s",
    async (kind) => {
      const f = fixture();
      if (kind === "clock_before_evaluation")
        f.clock.now.mockReturnValue(new Date("2026-09-01T00:00:00.000Z"));
      if (kind === "clock_reversed")
        f.clock.now
          .mockReturnValueOnce(new Date(completedAt))
          .mockReturnValue(new Date("2026-10-01T00:30:00.000Z"));
      if (kind === "future_receipt") f.append(f.next({ recordedAt: "2026-10-02T00:00:00.000Z" }));
      await expect(f.observe()).rejects.toMatchObject({ reason: "observation_conflict" });
    },
  );

  it("hashes observations independently of advancing capture time, but reprojects natural expiry", async () => {
    const f = fixture();
    const before = await f.observe();
    f.clock.now.mockReturnValue(new Date("2027-01-01T00:00:00.000Z"));
    const after = await f.observe();
    expect(criterionAuthorityMaterialFingerprint(after)).toBe(
      criterionAuthorityMaterialFingerprint(before),
    );
    expect(after.selections[0]).toMatchObject({
      atEvaluation: "approved_head",
      atCapture: "head_expired",
    });
  });

  it("admits exact repeated reference/count/UTF-8 byte limits and rejects one below", async () => {
    const f = fixture();
    const report = await f.observe();
    const count = report.inspectionUsage.references;
    expect((await f.observe({ ...limits, maxRecords: count })).inspectionUsage.references).toBe(
      count,
    );
    await expect(f.observe({ ...limits, maxRecords: count - 1 })).rejects.toMatchObject({
      reason: "reference_limit_exceeded",
    });
    const bytes = encodeEvaluationCanonicalJson(f.state.history).byteLength;
    expect(bytes).toBeGreaterThan(report.inspectionUsage.referenceBytes);
    await expect(f.observe({ ...limits, maxRecordBytes: bytes })).resolves.toHaveProperty(
      "status",
      "observed",
    );
    await expect(f.observe({ ...limits, maxRecordBytes: bytes - 1 })).rejects.toMatchObject({
      limit: "bytes",
    });
    await expect(f.observe({ ...limits, maxRecords: 1 })).rejects.toMatchObject({
      limit: "records",
    });
  });
});

describe("criterion authority temporal projection", () => {
  it.each([
    ["2026-10-01T00:00:00.000000399999999999999999999999Z", "head_expired"],
    ["2026-10-01T00:00:00.0000004Z", "head_expired"],
    ["2026-10-01T00:00:00.000000400000000000000000000001Z", "approved_head"],
    ["2026-10-01T09:00:00.0000004+09:00", "head_expired"],
  ] as const)("compares expiry %s at the full precision cut", (expiresAt, expected) => {
    const f = fixture();
    const approved = criterionStatusHistoryFixture(f.approved, { expiresAt });
    const history = [f.draft, approved];
    const projected = projectCriterionHistory(history, [0, 1], evaluationTime, false);
    expect(inspectCriterionStatusSelection(history, 1, projected)).toBe(expected);
  });
  it.each(["draft", "qualified", "contested", "withdrawn", "superseded"] as const)(
    "does not treat a unique %s head as approval",
    (status) => {
      const f = fixture();
      // This isolated projection consumes admitted status semantics, not definition digests.
      const history = [{ ...f.draft, status }];
      expect(
        inspectCriterionStatusSelection(
          history,
          0,
          projectCriterionHistory(history, [0], evaluationTime, false),
        ),
      ).toBe("head_not_approved");
    },
  );
  it("reports a missing exact selection and a cycle without selecting a timestamp winner", () => {
    const f = fixture();
    const history = [f.draft, f.approved];
    expect(
      inspectCriterionStatusSelection(
        history,
        undefined,
        projectCriterionHistory(history, [0, 1], evaluationTime, false),
      ),
    ).toBe("selected_status_unavailable");
    const cycle = [{ ...f.draft, previousStatus: ref(f.approved) }, f.approved];
    expect(projectCriterionHistory(cycle, [0, 1], evaluationTime, false).status).toBe("unresolved");
  });
});
