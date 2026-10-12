import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  encodeEvaluationCanonicalJson,
  type RecordedInteractionFixtureVersion,
  type RecordedInteractionFixtureVersionDefinition,
  type RegressionDatasetVersion,
  type RegressionDatasetVersionDefinition,
  type RegressionFixtureVersion,
  type RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import {
  inspectPolicyEvaluationDataset,
  inspectPolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
  type PolicyEvaluationDatasetSource,
} from "./policy-evaluation-dataset-reader.js";
import {
  inspectPolicyEvaluationDatasetRelations as inspect,
  inspectPolicyEvaluationStoredDatasetRelations as inspectStored,
} from "./policy-evaluation-dataset-relations.js";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "./regression-definition-digest.js";

const context = {
  scope: {
    tenantId: "tenant_relations",
    projectId: "project_relations",
    environmentId: "environment_relations",
  },
  evaluationTime: "2026-09-09T00:00:00.000Z",
};
const limits = { maxReferences: 1000, maxReferenceBytes: 1_000_000 };
const receipt = {
  createdAt: "2026-09-08T00:00:00.123Z",
  createdByPrincipalId: "principal_publisher",
};
type Fixture = RegressionFixtureVersion | RecordedInteractionFixtureVersion;
type Mutable<T> = { -readonly [Key in keyof T]: Mutable<T[Key]> };

function fixture(
  versionId: string,
  predecessor?: Fixture,
  fixtureId = "fixture_main",
): RegressionFixtureVersion {
  const definition: RegressionFixtureVersionDefinition = {
    fixtureId,
    fixtureVersionId: versionId,
    name: "Evidence fixture",
    scope: context.scope,
    schemaVersion: "0.1",
    replayability: "evidence_only",
    ...(predecessor
      ? {
          predecessor: {
            fixtureVersionId: predecessor.fixtureVersionId,
            definitionSha256: predecessor.definitionSha256,
          },
        }
      : {}),
    source: {
      kind: "trace_snapshot",
      traceId: "0123456789abcdef0123456789abcdef",
      eventIds: ["event_first", "event_second"],
      observedEventCount: 2,
      sourceCompleteness: "observed_snapshot",
    },
  };
  return {
    ...definition,
    ...receipt,
    source: { ...definition.source, capturedAt: "2026-09-08T00:00:00.000Z" },
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
  };
}

const vector = JSON.parse(
  readFileSync(
    new URL("../vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { input: RecordedInteractionFixtureVersionDefinition }[] };
function recorded(
  predecessor: Fixture,
  versionId = "fixture_recorded",
  changeSource?: (source: Fixture["source"]) => void,
): RecordedInteractionFixtureVersion {
  const definition = structuredClone(
    vector.vectors[0]?.input,
  ) as RecordedInteractionFixtureVersionDefinition;
  definition.scope = context.scope;
  definition.fixtureId = predecessor.fixtureId;
  definition.fixtureVersionId = versionId;
  definition.predecessor = {
    fixtureVersionId: predecessor.fixtureVersionId,
    definitionSha256: predecessor.definitionSha256,
  };
  const source = structuredClone(predecessor.source);
  changeSource?.(source);
  const { capturedAt: _captured, ...sourceDefinition } = source;
  definition.source = sourceDefinition;
  return {
    ...definition,
    ...receipt,
    source,
    definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
  };
}

function dataset(
  versionId: string,
  fixtures: Fixture[],
  predecessor?: RegressionDatasetVersion,
): RegressionDatasetVersion {
  const definition: RegressionDatasetVersionDefinition = {
    datasetId: "dataset_main",
    datasetVersionId: versionId,
    name: "Dataset",
    schemaVersion: "0.1",
    scope: context.scope,
    fixtureVersions: fixtures.map(({ fixtureId, fixtureVersionId, definitionSha256 }) => ({
      fixtureId,
      fixtureVersionId,
      definitionSha256,
    })),
    ...(predecessor
      ? {
          predecessor: {
            datasetVersionId: predecessor.datasetVersionId,
            definitionSha256: predecessor.definitionSha256,
          },
        }
      : {}),
  };
  return {
    ...definition,
    ...receipt,
    definitionSha256: digestRegressionDatasetVersionDefinition(definition),
  };
}

function source(record: PolicyEvaluationDatasetRecord): PolicyEvaluationDatasetSource {
  return "datasetVersionId" in record
    ? {
        kind: "dataset_version",
        reference: {
          datasetId: record.datasetId,
          datasetVersionId: record.datasetVersionId,
          definitionSha256: record.definitionSha256,
        },
      }
    : {
        kind: "regression_fixture_version",
        reference: {
          fixtureId: record.fixtureId,
          fixtureVersionId: record.fixtureVersionId,
          definitionSha256: record.definitionSha256,
        },
      };
}
function observe(record: PolicyEvaluationDatasetRecord): PolicyEvaluationDatasetRead {
  const read = inspectPolicyEvaluationDataset({ ...context, source: source(record) }, record);
  expect(read.observation.status).toBe("verified");
  return read;
}
function harness() {
  const base = fixture("fixture_base");
  const next = fixture("fixture_next", base);
  // An evidence-only successor may capture a new snapshot; promotion may not.
  next.source.capturedAt = "2026-09-08T00:00:00.001Z";
  const promoted = recorded(next);
  const other = fixture("fixture_other_v1", undefined, "fixture_other");
  const previousDataset = dataset("dataset_base", [next, other]);
  const currentDataset = dataset("dataset_next", [other, promoted], previousDataset);
  const records: PolicyEvaluationDatasetRecord[] = [
    base,
    next,
    promoted,
    other,
    previousDataset,
    currentDataset,
  ];
  const evidence = records.map(observe);
  return {
    base,
    next,
    promoted,
    other,
    previousDataset,
    currentDataset,
    records,
    evidence,
    execute: () => inspect(context, evidence, limits),
  };
}

function storedHarness(future = false) {
  const h = harness();
  const records = h.records.map((record) => ({
    ...structuredClone(record),
    ...(future ? { createdAt: "2099-01-01T00:00:00.123Z" } : {}),
  }));
  const captures = records.map((record) =>
    inspectPolicyEvaluationDatasetCapture({ ...context, source: source(record) }, record),
  ) as Mutable<PolicyEvaluationDatasetCapture>[];
  return { ...h, records, captures, execute: () => inspectStored(context, captures, limits) };
}

describe("original stored dataset relationships", () => {
  it.each([false, true])(
    "checks every original relationship with future=%s without changing the cut",
    (future) => {
      const h = storedHarness(future);
      const report = h.execute();
      expect(report.authorityBoundary).toBe("stored_relationships_only");
      expect(report.evaluationTime).toBe(context.evaluationTime);
      expect(report.parents).toHaveLength(6);
      expect(report.unavailableParents).toEqual([]);
      expect(report.parents.flatMap(({ relations }) => relations)).toHaveLength(7);
      for (const parent of report.parents) {
        const record = h.records.find(
          (value) =>
            source(value).reference.definitionSha256 === parent.source.reference.definitionSha256,
        );
        expect(record).toBeDefined();
        // Native JSON is an independent byte/hash oracle for these ASCII fixture records.
        const canonical = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(canonical)
            : value !== null && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value)
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .map(([key, child]) => [key, canonical(child)]),
                )
              : value;
        expect(parent.recordSha256).toBe(
          createHash("sha256")
            .update(JSON.stringify(canonical(record)), "utf8")
            .digest("hex"),
        );
        expect(parent.receiptTime).toBe(record?.createdAt);
        expect(parent.recordObservation).toEqual(
          future
            ? { status: "unavailable", reason: "not_yet_available" }
            : { status: "verified", recordSha256: parent.recordSha256 },
        );
        for (const relation of parent.relations) {
          expect(relation.observation).toEqual({ status: "matched" });
          expect(relation.storage).not.toBeNull();
          if (future)
            expect(relation.recordObservation).toEqual({
              status: "unavailable",
              reason: "not_yet_available",
            });
        }
      }
      expect(inspectStored(context, [...h.captures].reverse(), limits)).toEqual(report);
      expect(
        h.captures.every(
          ({ read }) => read.observation.status === (future ? "unavailable" : "verified"),
        ),
      ).toBe(true);
      expect(report).not.toHaveProperty("sealed");
      expect(report).not.toHaveProperty("eligible");
    },
  );

  it("retains mixed original availability and detached receipts", () => {
    const h = storedHarness();
    const index = h.records.findIndex(
      (value) => value.definitionSha256 === h.currentDataset.definitionSha256,
    );
    const future = { ...h.records[index]!, createdAt: "2099-01-01T00:00:00.123Z" };
    h.captures[index] = inspectPolicyEvaluationDatasetCapture(
      { ...context, source: source(future) },
      future,
    );
    const report = h.execute();
    const parent = report.parents.find(
      (value) => value.source.reference.definitionSha256 === future.definitionSha256,
    )!;
    expect(parent.recordObservation).toEqual({
      status: "unavailable",
      reason: "not_yet_available",
    });
    expect(
      parent.relations.every(
        (value) =>
          value.recordObservation.status === "verified" && value.observation.status === "matched",
      ),
    ).toBe(true);
    Object.assign(parent.source.reference, { definitionSha256: "f".repeat(64) });
    expect(h.execute()).not.toEqual(report);
  });

  it.each(["missing", "record_invalid", "reference_mismatch"])(
    "keeps %s storage as an explicit unavailable relationship",
    (reason) => {
      const h = storedHarness(true);
      const index = h.records.findIndex(
        (value) => value.definitionSha256 === h.promoted.definitionSha256,
      );
      const observation =
        reason === "missing"
          ? { status: "missing" as const }
          : {
              status: "unavailable" as const,
              reason: reason as "record_invalid" | "reference_mismatch",
            };
      h.captures[index] = {
        read: { source: source(h.promoted), record: null, observation },
        storage: null,
      };
      const report = h.execute();
      expect(report.unavailableParents).toEqual([{ source: source(h.promoted), observation }]);
      const relation = report.parents
        .find(
          (value) => value.source.reference.definitionSha256 === h.currentDataset.definitionSha256,
        )
        ?.relations.find(
          (value) => value.source.reference.definitionSha256 === h.promoted.definitionSha256,
        );
      expect(relation).toMatchObject({
        recordObservation: observation,
        storage: null,
        observation: { status: "unavailable" },
      });
    },
  );

  it.each(["trace", "format"])(
    "detects %s disagreement even when every original record is future",
    (kind) => {
      const base = fixture("fixture_base");
      const predecessor = kind === "format" ? recorded(base) : base;
      const successor = recorded(
        predecessor,
        "fixture_future",
        kind === "trace"
          ? (snapshot) => {
              snapshot.eventIds.reverse();
            }
          : undefined,
      );
      const values = kind === "format" ? [base, predecessor, successor] : [base, successor];
      const captures = values.map((value) => {
        const record = { ...value, createdAt: "2099-01-01T00:00:00.123Z" };
        return inspectPolicyEvaluationDatasetCapture(
          { ...context, source: source(record) },
          record,
        );
      });
      const report = inspectStored(context, captures, limits);
      expect(
        report.parents.find(
          (value) => value.source.reference.definitionSha256 === successor.definitionSha256,
        )?.relations[0],
      ).toMatchObject({
        recordObservation: { status: "unavailable", reason: "not_yet_available" },
        observation: {
          status: "mismatch",
          reason: kind === "trace" ? "trace_snapshot_mismatch" : "predecessor_format_mismatch",
        },
      });
    },
  );

  it("admits complete parents, repeated references and report bytes at exact limits", () => {
    const h = storedHarness(true);
    const report = h.execute();
    const exact = {
      maxReferences: report.inspectionUsage.references,
      maxReferenceBytes: report.inspectionUsage.referenceBytes,
    };
    expect(inspectStored(context, h.captures, exact)).toEqual(report);
    expect(() =>
      inspectStored(context, h.captures, { ...exact, maxReferences: exact.maxReferences - 1 }),
    ).toThrow("reference_limit_exceeded");
    expect(() =>
      inspectStored(context, h.captures, {
        ...exact,
        maxReferenceBytes: exact.maxReferenceBytes - 1,
      }),
    ).toThrow("reference_bytes_exceeded");
    expect(report.inspectionUsage.references).toBe(1 + 6 + 7);
  });

  it.each([
    "hash",
    "receipt",
    "body",
    "scope",
    "promotion",
    "reference",
    "duplicate",
    "omission",
    "null_verified",
    "null_future",
    "null_record",
  ])("rejects original capture substitution: %s", (kind) => {
    const h = storedHarness(true);
    const capture = h.captures[0]!;
    if (kind === "hash") capture.storage!.recordSha256 = "f".repeat(64);
    if (kind === "receipt") capture.storage!.receiptTime = "2099-01-01T00:00:00.124Z";
    if (kind === "body") capture.storage!.record.createdByPrincipalId = "another_publisher";
    if (kind === "scope") capture.storage!.record.scope.tenantId = "another_tenant";
    if (kind === "promotion")
      capture.read = {
        source: capture.read.source,
        record: capture.storage!.record,
        observation: { status: "verified", recordSha256: capture.storage!.recordSha256 },
      };
    if (kind === "reference") capture.read.source.reference.definitionSha256 = "f".repeat(64);
    if (kind === "duplicate") h.captures.push(structuredClone(capture));
    if (kind === "omission") h.captures.shift();
    if (kind === "null_verified") {
      capture.read = {
        source: capture.read.source,
        record: null as never,
        observation: { status: "verified", recordSha256: capture.storage!.recordSha256 },
      };
      capture.storage = null;
    }
    if (kind === "null_future") capture.storage = null;
    if (kind === "null_record") {
      capture.read = {
        ...capture.read,
        observation: { status: "missing" },
        record: capture.storage!.record as never,
      };
      capture.storage = null;
    }
    expect(() => h.execute()).toThrow();
  });

  it.each(["zero_references", "parent_references", "zero_bytes", "parent_bytes"])(
    "rejects %s before admitting unbounded parent material",
    (kind) => {
      const h = storedHarness();
      const bounded = { ...limits };
      if (kind === "zero_references") bounded.maxReferences = 0;
      if (kind === "parent_references") bounded.maxReferences = h.captures.length;
      if (kind === "zero_bytes") bounded.maxReferenceBytes = 0;
      if (kind === "parent_bytes")
        bounded.maxReferenceBytes = Buffer.byteLength(
          JSON.stringify({
            evaluationTime: context.evaluationTime,
            scope: {
              environmentId: context.scope.environmentId,
              projectId: context.scope.projectId,
              tenantId: context.scope.tenantId,
            },
          }),
          "utf8",
        );
      expect(() => inspectStored(context, h.captures, bounded)).toThrow(
        kind.endsWith("references") ? "reference_limit_exceeded" : "reference_bytes_exceeded",
      );
    },
  );

  it.each([
    "context_null",
    "context_extra",
    "scope",
    "time",
    "array",
    "sparse",
    "accessor",
    "capture_null",
    "capture_extra",
    "capture_read_missing",
    "read_extra",
    "unsupported",
    "undefined_storage",
  ])("rejects malformed stored relation input: %s", (kind) => {
    const h = storedHarness();
    let input: unknown = structuredClone(context);
    let evidence: unknown = h.captures;
    if (kind === "context_null") input = null;
    if (kind === "context_extra") input = { ...context, selected: true };
    if (kind === "scope") input = { ...context, scope: {} };
    if (kind === "time") input = { ...context, evaluationTime: "yesterday" };
    if (kind === "array") evidence = {};
    if (kind === "sparse") evidence = new Array(1);
    if (kind === "accessor")
      Object.defineProperty(h.captures, "0", { enumerable: true, get: () => h.captures[1] });
    if (kind === "capture_null") evidence = [null];
    if (kind === "capture_extra") evidence = [{ ...h.captures[0], selected: true }];
    if (kind === "capture_read_missing") evidence = [{ read: null, storage: null }];
    if (kind === "read_extra")
      evidence = [{ ...h.captures[0], read: { ...h.captures[0]!.read, selected: true } }];
    if (kind === "unsupported")
      evidence = [
        {
          read: {
            source: {
              kind: "source_snapshot",
              reference: { sourceSnapshotId: "source_other", definitionSha256: "f".repeat(64) },
            },
            observation: { status: "missing" },
            record: null,
          },
          storage: null,
        },
      ];
    if (kind === "undefined_storage")
      evidence = [{ read: h.captures[0]!.read, storage: undefined }];
    expect(() =>
      inspectStored(input as typeof context, evidence as PolicyEvaluationDatasetCapture[], limits),
    ).toThrow();
  });

  it("represents an admitted empty domain without inventing a source", () => {
    const report = inspectStored(context, [], limits);
    expect(report.parents).toEqual([]);
    expect(report.unavailableParents).toEqual([]);
    expect(report.inspectionUsage.references).toBe(1);
  });
});

describe("captured dataset membership and fixture predecessor semantics", () => {
  it("joins each exact record once, preserves membership order and every shared relation", () => {
    const h = harness();
    const result = h.execute();
    expect(result.parents).toHaveLength(6);
    expect(result.unavailableParents).toEqual([]);
    expect(result.parents.flatMap((parent) => parent.relations)).toHaveLength(7);
    expect(
      result.parents
        .flatMap((parent) => parent.relations)
        .every((relation) => relation.observation.status === "matched"),
    ).toBe(true);
    const current = result.parents.find(
      (parent) => parent.source.reference.definitionSha256 === h.currentDataset.definitionSha256,
    );
    expect(
      current?.relations.map(({ path, kind, source: target }) => ({ path, kind, source: target })),
    ).toEqual([
      { path: "/fixtureVersions/0", kind: "dataset_member", source: source(h.other) },
      { path: "/fixtureVersions/1", kind: "dataset_member", source: source(h.promoted) },
      { path: "/predecessor", kind: "dataset_predecessor", source: source(h.previousDataset) },
    ]);
    for (const parent of result.parents) {
      const original = h.evidence.find(
        (read) =>
          read.source.reference.definitionSha256 === parent.source.reference.definitionSha256,
      );
      expect(original?.observation).toEqual({
        status: "verified",
        recordSha256: parent.recordSha256,
      });
      for (const relation of parent.relations)
        expect(relation.recordObservation).toEqual(
          h.evidence.find(
            (read) =>
              read.source.reference.definitionSha256 === relation.source.reference.definitionSha256,
          )?.observation,
        );
    }
    expect(inspect(context, [...h.evidence].reverse(), limits)).toEqual(result);
    expect(result).not.toHaveProperty("sealed");
    expect(result).not.toHaveProperty("eligible");
  });

  it.each([
    "traceId",
    "event_order",
    "event_added",
    "event_missing",
    "capture_time",
    "capture_precision",
    "capture_representation",
  ])("rejects promotion snapshot substitution: %s", (field) => {
    const predecessor = fixture("fixture_base");
    const promoted = recorded(predecessor, "fixture_recorded", (snapshot) => {
      if (field === "traceId") snapshot.traceId = "f".repeat(32);
      if (field === "event_order") snapshot.eventIds.reverse();
      if (field === "event_added") snapshot.eventIds.push("event_extra");
      if (field === "event_missing") snapshot.eventIds.pop();
      snapshot.observedEventCount = snapshot.eventIds.length;
      if (field === "capture_time") snapshot.capturedAt = "2026-09-08T00:00:00.001Z";
      if (field === "capture_precision")
        snapshot.capturedAt = "2026-09-08T00:00:00.000000000000000000000000000001Z";
      if (field === "capture_representation") snapshot.capturedAt = "2026-09-08T00:00:00.0000Z";
    });
    const result = inspect(context, [observe(promoted), observe(predecessor)], limits);
    expect(
      result.parents.find(
        (parent) => parent.source.reference.definitionSha256 === promoted.definitionSha256,
      )?.relations[0]?.observation,
    ).toEqual({ status: "mismatch", reason: "trace_snapshot_mismatch" });
  });

  it.each(["recorded", "evidence"])(
    "does not allow a %s fixture to name a recorded predecessor",
    (kind) => {
      const base = fixture("fixture_base");
      const first = recorded(base);
      const second =
        kind === "recorded" ? recorded(first, "fixture_later") : fixture("fixture_later", first);
      const member = dataset("dataset_bad_lineage", [second]);
      const result = inspect(context, [base, first, second, member].map(observe), limits);
      expect(
        result.parents.find(
          (parent) => parent.source.reference.definitionSha256 === second.definitionSha256,
        )?.relations[0]?.observation,
      ).toEqual({ status: "mismatch", reason: "predecessor_format_mismatch" });
      // The immediate membership is exact, but cannot erase the target's separately reported defect.
      expect(
        result.parents.find(
          (parent) => parent.source.reference.definitionSha256 === member.definitionSha256,
        )?.relations[0]?.observation,
      ).toEqual({ status: "matched" });
    },
  );

  it.each(["missing", "record_invalid", "reference_mismatch", "not_yet_available"])(
    "preserves %s without converting it to valid lineage or an empty root",
    (reason) => {
      const h = harness();
      const observation =
        reason === "missing" ? { status: "missing" } : { status: "unavailable", reason };
      Object.assign(h.evidence[1] as object, { record: null, observation });
      const result = h.execute();
      expect(result.unavailableParents).toEqual([{ source: source(h.next), observation }]);
      expect(
        result.parents.some(
          (parent) => parent.source.reference.definitionSha256 === h.next.definitionSha256,
        ),
      ).toBe(false);
      const dependencies = result.parents
        .flatMap((parent) => parent.relations)
        .filter(
          (relation) => relation.source.reference.definitionSha256 === h.next.definitionSha256,
        );
      expect(dependencies).toHaveLength(2);
      for (const relation of dependencies) {
        expect(relation.observation).toEqual({ status: "unavailable" });
        expect(relation.recordObservation).toEqual(observation);
      }
    },
  );

  it("rejects omitted dependency observations instead of fabricating a missing record", () => {
    const h = harness();
    h.evidence.splice(1, 1);
    expect(h.execute).toThrowError(expect.objectContaining({ reason: "observation_mismatch" }));
  });

  it("rejects a different full reference under the same version identity", () => {
    const h = harness();
    const changed = structuredClone(h.base);
    changed.name = "Another definition";
    const {
      createdAt: _at,
      createdByPrincipalId: _by,
      definitionSha256: _hash,
      source: snapshot,
      ...definition
    } = changed;
    const { capturedAt: _capture, ...snapshotDefinition } = snapshot;
    changed.definitionSha256 = digestRegressionFixtureVersionDefinition({
      ...definition,
      source: snapshotDefinition,
    });
    h.evidence[0] = observe(changed);
    expect(h.execute).toThrowError(expect.objectContaining({ reason: "observation_mismatch" }));
  });

  it.each(["definition", "receipt", "hash", "scope", "future", "null_body", "unverified_body"])(
    "revalidates original captured bodies: %s",
    (field) => {
      const h = harness();
      const read = h.evidence[0] as PolicyEvaluationDatasetRead;
      if (field === "definition" && read.record) read.record.name = "changed";
      if (field === "receipt" && read.record)
        read.record.createdByPrincipalId = "principal_changed";
      if (field === "hash")
        Object.assign(read, { observation: { status: "verified", recordSha256: "f".repeat(64) } });
      if (field === "scope" && read.record) read.record.scope.projectId = "project_other";
      if (field === "future" && read.record) read.record.createdAt = "2026-09-10T00:00:00.000Z";
      if (field === "null_body") Object.assign(read, { record: null });
      if (field === "unverified_body") Object.assign(read, { observation: { status: "missing" } });
      expect(h.execute).toThrow();
    },
  );

  it.each([
    "duplicate",
    "conflicting_duplicate",
    "extra",
    "hidden",
    "missing_key",
    "getter",
    "null",
    "hole",
    "other_kind",
    "observation",
  ])("rejects malformed node inventory: %s", (kind) => {
    const h = harness();
    const read = h.evidence[0] as PolicyEvaluationDatasetRead;
    const getter = vi.fn(() => h.base);
    if (kind === "duplicate") h.evidence.push(read);
    if (kind === "conflicting_duplicate")
      h.evidence.push({ source: read.source, observation: { status: "missing" }, record: null });
    if (kind === "extra") Object.assign(read, { extra: true });
    if (kind === "hidden") Object.defineProperty(read, "record", { enumerable: false });
    if (kind === "missing_key") {
      Reflect.deleteProperty(read, "record");
      Object.assign(read, { other: true });
    }
    if (kind === "getter") Object.defineProperty(read, "record", { enumerable: true, get: getter });
    if (kind === "null") h.evidence[0] = null as never;
    if (kind === "hole") delete h.evidence[0];
    if (kind === "other_kind")
      Object.assign(read, {
        source: {
          kind: "release_candidate",
          reference: {
            candidateId: "candidate",
            candidateVersionId: "candidate_v1",
            definitionSha256: "a".repeat(64),
          },
        },
      });
    if (kind === "observation") Object.assign(read, { observation: { status: "approved" } });
    expect(h.execute).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    "null_context",
    "extra_context",
    "invalid_scope",
    "invalid_time",
    "not_array",
    "invalid_limits",
  ])("rejects invalid inspection input: %s", (kind) => {
    const h = harness();
    let input = structuredClone(context);
    let evidence = h.evidence;
    let budget = { ...limits };
    if (kind === "null_context") input = null as never;
    if (kind === "extra_context") Object.assign(input, { source: "caller_selected" });
    if (kind === "invalid_scope") input.scope.tenantId = "";
    if (kind === "invalid_time") input.evaluationTime = "yesterday";
    if (kind === "not_array") evidence = {} as never;
    if (kind === "invalid_limits") budget = { ...limits, maxReferences: -1 };
    expect(() => inspect(input, evidence, budget)).toThrowError(
      expect.objectContaining({ reason: "input_invalid" }),
    );
  });

  it("enforces cumulative relation count and byte bounds without returning partial reports", () => {
    const h = harness();
    const baseline = h.execute();
    const relations = baseline.parents.flatMap((parent) => parent.relations);
    const bytes = relations.reduce(
      (sum, { path, source }) =>
        sum + encodeEvaluationCanonicalJson({ kind: "record", path, source }).byteLength,
      0,
    );
    expect(baseline.inspectionUsage).toEqual({
      references: relations.length,
      referenceBytes: bytes,
    });
    expect(
      inspect(context, h.evidence, { maxReferences: relations.length, maxReferenceBytes: bytes }),
    ).toEqual(baseline);
    expect(() =>
      inspect(context, h.evidence, { ...limits, maxReferences: h.evidence.length - 1 }),
    ).toThrowError(expect.objectContaining({ reason: "reference_limit_exceeded" }));
    expect(() =>
      inspect(context, h.evidence, { ...limits, maxReferences: relations.length - 1 }),
    ).toThrowError(expect.objectContaining({ reason: "reference_limit_exceeded" }));
    expect(() =>
      inspect(context, h.evidence, {
        maxReferences: relations.length,
        maxReferenceBytes: bytes - 1,
      }),
    ).toThrowError(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
  });

  it("keeps zero-member roots distinct from unreadable parents and returns detached observations", () => {
    expect(inspect(context, [], { maxReferences: 0, maxReferenceBytes: 0 })).toEqual({
      parents: [],
      unavailableParents: [],
      inspectionUsage: { references: 0, referenceBytes: 0 },
    });
    const base = fixture("fixture_base");
    const root = observe(base);
    const unavailable: PolicyEvaluationDatasetRead = {
      source: {
        kind: "dataset_version",
        reference: {
          datasetId: "dataset_unreadable",
          datasetVersionId: "dataset_unreadable_v1",
          definitionSha256: "a".repeat(64),
        },
      },
      observation: { status: "missing" },
      record: null,
    };
    const input = [root, unavailable];
    const before = structuredClone(input);
    const result = inspect(context, input, limits);
    expect(result.parents[0]?.relations).toEqual([]);
    expect(result.unavailableParents).toHaveLength(1);
    const known = result.parents[0];
    const unknown = result.unavailableParents[0];
    if (!known || !unknown) throw new Error("Expected both parent observations");
    known.source.reference.definitionSha256 = "f".repeat(64);
    unknown.source.reference.definitionSha256 = "e".repeat(64);
    expect(input).toEqual(before);
    const h = harness();
    const original = structuredClone(h.evidence);
    const report = h.execute();
    Object.assign(
      report.parents.flatMap((parent) => parent.relations)[0]?.recordObservation as object,
      { recordSha256: "f".repeat(64) },
    );
    expect(h.evidence).toEqual(original);
  });
});
