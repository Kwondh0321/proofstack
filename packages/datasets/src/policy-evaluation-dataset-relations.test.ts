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
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
  type PolicyEvaluationDatasetSource,
} from "./policy-evaluation-dataset-reader.js";
import { inspectPolicyEvaluationDatasetRelations as inspect } from "./policy-evaluation-dataset-relations.js";
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
