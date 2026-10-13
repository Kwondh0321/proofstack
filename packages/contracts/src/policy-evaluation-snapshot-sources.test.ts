import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationSnapshotSourceInputsSchema,
  type PolicyEvaluationSnapshotSourceInputs,
} from "./policy-evaluation-snapshot-sources.js";

const sha = "a".repeat(64);
const cut = "2026-10-03T00:00:00.000000000000000000000000000001Z";
function input(): PolicyEvaluationSnapshotSourceInputs {
  const parent = {
    kind: "criterion_set" as const,
    reference: {
      criterionSetId: "criteria_sources",
      criterionSetVersionId: "criteria_sources_v1",
      definitionSha256: sha,
    },
  };
  const target = {
    kind: "protocol_definition" as const,
    reference: { protocolDefinitionId: "protocol_sources", definitionSha256: sha },
  };
  return PolicyEvaluationSnapshotSourceInputsSchema.parse({
    records: {
      schemaVersion: "0.1",
      request: { evaluationRequestId: "request_sources", definitionSha256: sha },
      scope: {
        tenantId: "tenant_sources",
        projectId: "project_sources",
        environmentId: "env_sources",
      },
      evaluationTime: cut,
      records: [
        {
          entry: { source: parent, observation: { status: "verified", recordSha256: sha } },
          storage: { recordSha256: sha, receiptTime: cut },
          origins: [
            { kind: "semantic_edge_parent", edgeIndex: 0 },
            { kind: "stored_edge_parent", edgeIndex: 0 },
            { kind: "logical_root_parent", bindingIndex: 0 },
            { kind: "logical_root", bindingIndex: 0 },
          ],
        },
        {
          entry: { source: target, observation: { status: "verified", recordSha256: sha } },
          storage: { recordSha256: sha, receiptTime: cut },
          origins: [{ kind: "stored_edge", edgeIndex: 0, targetIndex: 0 }],
        },
      ],
    },
    semanticFrontier: [
      {
        parent,
        parentRecordSha256: sha,
        edgeIndex: 0,
        kind: "artifact",
        reference: {
          kind: "artifact",
          path: "/content",
          reference: {
            artifactId: "artifact_sources",
            sha256: sha,
            classification: "internal",
            mediaType: "application/json",
            sizeBytes: 1,
          },
        },
        target: null,
      },
    ],
    storedMappings: [
      {
        parent,
        parentRecordSha256: sha,
        edgeIndex: 0,
        reference: {
          kind: "protocol_declaration",
          path: "/source/captureAdapter",
          reference: { name: "capture_adapter", version: "1.0.0" },
        },
        targets: [target],
        cardinality: "unique",
        resolutionSha256: sha,
      },
    ],
    logicalRoots: {
      configuration: "configured",
      mappings: [
        {
          parent,
          parentRecordSha256: sha,
          bindingIndex: 0,
          state: { status: "retained", root: parent },
        },
      ],
    },
  });
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (!value) throw new Error("Missing retained source fixture");
  return value;
}

describe("snapshot source relationships", () => {
  it("retains separate original/semantic positions and exact body identity without source bodies", () => {
    const value = input();
    const parsed = PolicyEvaluationSnapshotSourceInputsSchema.parse(value);
    expect(parsed).toEqual(value);
    expect(parsed.records.records).toHaveLength(2);
    expect(parsed.storedMappings[0]?.cardinality).toBe("unique");
    expect(parsed).not.toHaveProperty("sealed");
    expect(parsed).not.toHaveProperty("workerId");
    first(parsed.records.records).origins = [];
    expect(first(value.records.records).origins).toHaveLength(4);
  });

  it.each([
    "parent",
    "parent_digest",
    "parent_body",
    "parent_origin",
    "target",
    "target_digest",
    "target_origin",
    "root_origin",
    "binding_index",
    "configuration",
    "frontier_category",
    "frontier_target",
    "mapping_record",
    "cardinality",
  ] as const)("rejects substituted or omitted relationship evidence: %s", (fault) => {
    const value = input();
    const frontier = first(value.semanticFrontier);
    const mapping = first(value.storedMappings);
    const logical = first(value.logicalRoots.mappings);
    const parent = first(value.records.records);
    const target = value.records.records[1];
    if (!target) throw new Error("Missing target source");
    if (fault === "parent") frontier.parent = target.entry.source;
    else if (fault === "parent_digest")
      Reflect.set(frontier.parent.reference, "definitionSha256", "b".repeat(64));
    else if (fault === "parent_body") mapping.parentRecordSha256 = "b".repeat(64);
    else if (fault === "parent_origin")
      parent.origins = parent.origins.filter(({ kind }) => kind !== "semantic_edge_parent");
    else if (fault === "target")
      target.entry.source = {
        kind: "protocol_definition",
        reference: { protocolDefinitionId: "protocol_other", definitionSha256: sha },
      };
    else if (fault === "target_digest")
      Reflect.set(first(mapping.targets).reference, "definitionSha256", "b".repeat(64));
    else if (fault === "target_origin") target.origins = [{ kind: "stored_node", nodeIndex: 1 }];
    else if (fault === "root_origin")
      parent.origins = parent.origins.filter(({ kind }) => kind !== "logical_root");
    else if (fault === "binding_index") logical.bindingIndex = 1;
    else if (fault === "configuration") value.logicalRoots.configuration = "unconfigured";
    else if (fault === "frontier_category") frontier.kind = "trace";
    else if (fault === "frontier_target") frontier.target = target.entry.source;
    else if (fault === "mapping_record")
      mapping.reference = { kind: "record", path: "/source", source: target.entry.source };
    else mapping.cardinality = "multiple";
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
  });

  it.each(["semantic", "stored"] as const)(
    "rejects duplicate original %s edge coordinates",
    (kind) => {
      const value = input();
      if (kind === "semantic")
        value.semanticFrontier.push(structuredClone(first(value.semanticFrontier)));
      else value.storedMappings.push(structuredClone(first(value.storedMappings)));
      expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it("preserves original future parent witnesses without promoting semantic availability", () => {
    const value = input();
    const parent = first(value.records.records);
    parent.storage = { recordSha256: sha, receiptTime: "2026-10-04T00:00:00.000Z" };
    parent.entry.observation = { status: "unavailable", reason: "not_yet_available" };
    value.semanticFrontier = [];
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(true);
    const original = input();
    value.semanticFrontier = original.semanticFrontier;
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
  });

  it("retains unconfigured logical roots separately from missing root bodies", () => {
    const value = input();
    first(value.records.records).origins = first(value.records.records).origins.filter(
      ({ kind }) => kind !== "logical_root",
    );
    value.logicalRoots.configuration = "unconfigured";
    first(value.logicalRoots.mappings).state = {
      status: "unresolved",
      reason: "root_port_unconfigured",
    };
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(true);
    value.logicalRoots.configuration = "configured";
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
  });

  it("retains zero/multiple mapping cardinality and every original repeated target position", () => {
    const value = input();
    const mapping = first(value.storedMappings);
    const target = value.records.records[1];
    if (!target) throw new Error("Missing target source");
    mapping.targets.push(structuredClone(first(mapping.targets)));
    mapping.cardinality = "multiple";
    target.origins.push({ kind: "stored_edge", edgeIndex: 0, targetIndex: 1 });
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(true);
    mapping.targets = [];
    mapping.cardinality = "zero";
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
    target.origins = [{ kind: "stored_node", nodeIndex: 1 }];
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(true);
  });

  it("rejects discarded logical-root bindings and fabricated unresolved root uses", () => {
    const value = input();
    value.logicalRoots.mappings = [];
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
    const unresolved = input();
    unresolved.logicalRoots.configuration = "unconfigured";
    first(unresolved.logicalRoots.mappings).state = {
      status: "unresolved",
      reason: "root_port_unconfigured",
    };
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(unresolved).success).toBe(false);
  });

  it("rejects combined output overflow before inspecting source material", () => {
    const value = input();
    value.semanticFrontier = Array.from({ length: 100000 }, () => first(value.semanticFrontier));
    Object.defineProperty(first(value.records.records), "entry", {
      get() {
        throw new Error("Material read before total admission");
      },
    });
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
  });

  it.each(["selector", "predecessor", "trace", "resolved_declaration"] as const)(
    "preserves owning frontier semantics for %s",
    (kind) => {
      const value = input();
      const frontier = first(value.semanticFrontier);
      if (kind === "selector") {
        frontier.kind = "unresolved_selector";
        frontier.reference = {
          kind: "evaluation_run_identity",
          path: "/evaluationRunId",
          evaluationRunId: "run_sources",
        };
      } else if (kind === "predecessor") {
        frontier.kind = "unresolved_selector";
        frontier.reference = {
          kind: "control_declaration",
          path: "/predecessor",
          declaration: {
            kind: "comparison_predecessor",
            reference: {
              comparisonVersionId: "comparison_sources_v1",
              definitionSha256: sha,
            },
          },
        };
      } else if (kind === "trace") {
        frontier.kind = "trace";
        frontier.reference = {
          kind: "trace_snapshot_selector",
          path: "/source",
          selector: {
            capturedAt: "2026-10-03T00:00:00.000Z",
            kind: "trace_snapshot",
            eventIds: ["event_sources"],
            observedEventCount: 1,
            sourceCompleteness: "observed_snapshot",
            traceId: "a".repeat(32),
          },
        };
      } else {
        frontier.kind = "retained_declaration";
        frontier.reference = first(value.storedMappings).reference;
        frontier.target = value.records.records[1]!.entry.source;
        value.records.records[1]!.origins.push({ kind: "semantic_edge", edgeIndex: 0 });
      }
      expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(true);
      if (kind === "resolved_declaration")
        frontier.reference = {
          kind: "record",
          path: "/source",
          source: frontier.target!,
        };
      else frontier.target = value.records.records[1]!.entry.source;
      expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects mapping target overflow before reading target material", () => {
    const value = input();
    const mapping = first(value.storedMappings);
    mapping.targets = Array.from({ length: 100001 }, () => first(mapping.targets));
    Object.defineProperty(first(mapping.targets), "reference", {
      get() {
        throw new Error("Target material read before admission");
      },
    });
    expect(PolicyEvaluationSnapshotSourceInputsSchema.safeParse(value).success).toBe(false);
  });
});
