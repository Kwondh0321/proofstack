import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ModelInteraction,
  RecordedInteractionFixtureVersion,
  RegressionDatasetVersion,
  RegressionFixtureVersion,
  ToolInteraction,
} from "@proofstack/contracts";
import { PolicyEvaluationReferenceCollector } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import * as datasetReader from "./policy-evaluation-dataset-reader.js";
import {
  inspectPolicyEvaluationDataset,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
  type PolicyEvaluationDatasetSource,
  readPolicyEvaluationDataset,
} from "./policy-evaluation-dataset-reader.js";
import { enumeratePolicyEvaluationDatasetReferences as enumerate } from "./policy-evaluation-dataset-references.js";
import { digestRegressionDatasetVersionDefinition } from "./regression-definition-digest.js";
import { MemoryRegressionVersionRepository } from "./testing/memory-regression-version-repository.js";

type Fields = Record<string, unknown>;
const limits = { maxReferences: 10_000, maxReferenceBytes: 4_000_000 };
const createdAt = "2026-09-08T00:00:00.123Z";
type Vector = { name: string; input: Fields; sha256: string };
const vectors = ["regression-definition-v1.json", "interaction-fixture-definition-v2.json"].flatMap(
  (file) =>
    (
      JSON.parse(readFileSync(new URL(`../vectors/${file}`, import.meta.url), "utf8")) as {
        vectors: Vector[];
      }
    ).vectors,
);
const records = vectors.map(
  (vector) =>
    ({
      ...structuredClone(vector.input),
      createdAt,
      createdByPrincipalId: "usr_capture",
      definitionSha256: vector.sha256,
      ...(vector.input["source"]
        ? {
            source: {
              ...(vector.input["source"] as Fields),
              capturedAt: "2026-09-08T00:00:00.000Z",
            },
          }
        : {}),
    }) as PolicyEvaluationDatasetRecord,
);
const interactionRecord = () =>
  structuredClone(
    records.find((r) => r.schemaVersion === "0.2") as RecordedInteractionFixtureVersion,
  );
const datasetRecord = () =>
  structuredClone(records.find((r) => "datasetVersionId" in r) as RegressionDatasetVersion);
function context(record: PolicyEvaluationDatasetRecord) {
  const source: PolicyEvaluationDatasetSource =
    "datasetVersionId" in record
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
  return { evaluationTime: createdAt, scope: structuredClone(record.scope), source };
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sorted(child)]),
    );
  return value;
}
const json = (value: unknown) => JSON.stringify(sorted(value));
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
function observe(record: PolicyEvaluationDatasetRecord) {
  const input = context(record);
  const evidence = inspectPolicyEvaluationDataset(input, record);
  expect(evidence.observation).toEqual({ status: "verified", recordSha256: hash(record) });
  if (evidence.observation.status !== "verified" || evidence.record === null) {
    throw new Error("Expected independently verified fixture");
  }
  return {
    input,
    evidence: {
      observation: evidence.observation,
      record: evidence.record,
      source: evidence.source,
    },
  };
}
function redigest(record: RecordedInteractionFixtureVersion): RecordedInteractionFixtureVersion {
  const {
    createdAt: _time,
    createdByPrincipalId: _author,
    definitionSha256: _sha,
    source,
    ...definition
  } = record;
  const { capturedAt: _capture, ...sourceDefinition } = source;
  record.definitionSha256 = digestRecordedInteractionFixtureVersionDefinition({
    ...definition,
    source: sourceDefinition,
  });
  return record;
}
function richRecord(): RecordedInteractionFixtureVersion {
  const record = interactionRecord();
  const model = record.interactionCapture.interactions[0] as ModelInteraction;
  const attempt = model.attempts[0] as ModelInteraction["attempts"][number];
  const extras = [
    ["art_prompt_vars", "prompt.variables"],
    ["art_stream", "model.streaming_frames"],
    ["art_system", "model.system_instructions"],
    ["art_tool_arguments", "tool.arguments"],
    ["art_tool_contract", "tool.contract"],
    ["art_tool_normalized", "tool.normalized_request"],
    ["art_tool_result", "tool.result"],
  ] as const;
  record.interactionCapture.artifacts.push(
    ...extras.map(([artifactId, role]) => ({
      contentReference: {
        artifactId,
        classification: "confidential" as const,
        mediaType: "application/json",
        sha256: "b".repeat(64),
        sizeBytes: 20,
      },
      redaction: { status: "not_required" as const },
      retention: { mode: "retain" as const },
      role,
    })),
  );
  record.interactionCapture.artifacts.sort((a, b) =>
    a.contentReference.artifactId < b.contentReference.artifactId ? -1 : 1,
  );
  attempt.streaming = true;
  Object.assign(attempt.artifacts, {
    promptVariablesArtifactId: "art_prompt_vars",
    streamingFramesArtifactId: "art_stream",
    systemInstructionsArtifactId: "art_system",
  });
  const failed = structuredClone(attempt);
  failed.attemptId = "att_failed";
  failed.outcome = "timed_out";
  failed.errorType = "timeout";
  failed.artifacts = {
    inputMessagesArtifactId: "art_model_input",
    providerConfigurationArtifactId: "art_model_config",
    providerRequestArtifactId: "art_model_request",
  };
  failed.streaming = false;
  attempt.sequence = 1;
  model.attempts.unshift(failed);
  const tool = {
    artifactId: "art_tool_contract",
    definitionSha256: "b".repeat(64),
    toolId: "tool_charge",
    toolVersion: "1.0.0",
  };
  model.toolContracts = [tool];
  const toolInteraction: ToolInteraction = {
    kind: "tool",
    interactionId: "int_tool",
    callId: "call_tool",
    sequence: 1,
    terminalOutcome: "succeeded",
    tool,
    attempts: [
      {
        attemptId: "att_tool_failed",
        endedAt: attempt.endedAt,
        startedAt: attempt.startedAt,
        errorType: "timeout",
        outcome: "timed_out",
        sequence: 0,
        normalizedRequest: {
          adapterName: "tool.json",
          adapterVersion: "1.0.0",
          artifactId: "art_tool_normalized",
          sha256: "b".repeat(64),
        },
        artifacts: { argumentsArtifactId: "art_tool_arguments" },
        sideEffect: "unknown",
        effectMayHaveOccurred: true,
      },
      {
        attemptId: "att_tool_ok",
        endedAt: attempt.endedAt,
        startedAt: attempt.startedAt,
        outcome: "succeeded",
        sequence: 1,
        normalizedRequest: {
          adapterName: "tool.json",
          adapterVersion: "1.0.0",
          artifactId: "art_tool_normalized",
          sha256: "b".repeat(64),
        },
        artifacts: {
          argumentsArtifactId: "art_tool_arguments",
          resultArtifactId: "art_tool_result",
        },
        sideEffect: "idempotent_write",
        effectMayHaveOccurred: true,
      },
    ],
  };
  record.interactionCapture.interactions.push(toolInteraction);
  return redigest(record);
}

// Independent structural inventory: no production enumerator, collector, or field map is used.
// It detects every artifact ID occurrence, including aliases, and separately projects declarations.
function expectedReferences(record: PolicyEvaluationDatasetRecord): Fields[] {
  const bindings = new Map(
    "interactionCapture" in record
      ? record.interactionCapture.artifacts.map((b) => [
          b.contentReference.artifactId,
          b.contentReference,
        ])
      : [],
  );
  const result: Fields[] = [];
  const recordRef = (path: string, kind: string, reference: unknown) =>
    result.push({ kind: "record", path, source: { kind, reference } });
  const walk = (value: unknown, path: string, key = ""): void => {
    if (typeof value === "string" && (key === "artifactId" || key.endsWith("ArtifactId"))) {
      const reference = bindings.get(value);
      if (!reference) throw new Error(`Missing independent binding: ${path}`);
      result.push({ kind: "artifact", path, reference });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        walk(item, `${path}/${i}`);
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Fields;
    if ("artifactId" in obj && "sizeBytes" in obj) {
      result.push({ kind: "artifact", path, reference: obj });
      return;
    }
    if (key === "predecessor") {
      if ("datasetVersionId" in obj)
        recordRef(path, "dataset_version", {
          ...obj,
          datasetId: (record as RegressionDatasetVersion).datasetId,
        });
      else
        recordRef(path, "regression_fixture_version", {
          ...obj,
          fixtureId: (record as RegressionFixtureVersion).fixtureId,
        });
      return;
    }
    if (path.startsWith("/fixtureVersions/")) {
      recordRef(path, "regression_fixture_version", obj);
      return;
    }
    if (obj["kind"] === "trace_snapshot") {
      result.push({ kind: "trace_snapshot_selector", path, selector: obj });
      return;
    }
    if ("promptId" in obj) result.push({ kind: "interaction_prompt", path, reference: obj });
    if ("toolId" in obj) result.push({ kind: "interaction_tool_contract", path, reference: obj });
    if ("endpointProfileId" in obj)
      result.push({
        kind: "endpoint_profile_selector",
        path,
        selector: {
          endpointProfileId: obj["endpointProfileId"],
          endpointProfileVersion: obj["endpointProfileVersion"],
        },
      });
    if ("adapterName" in obj)
      result.push({
        kind: "protocol_declaration",
        path,
        reference: { name: obj["adapterName"], version: obj["adapterVersion"] },
      });
    if (key === "captureAdapter" || key === "sourceFormat")
      result.push({ kind: "protocol_declaration", path, reference: obj });
    for (const [child, item] of Object.entries(obj)) walk(item, `${path}/${child}`, child);
  };
  walk(record, "");
  return result.sort((a, b) => {
    const left = (a["path"] as string).split("/");
    const right = (b["path"] as string).split("/");
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const x = left[i] as string;
      const y = right[i] as string;
      if (x === y) continue;
      if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
      return x < y ? -1 : 1;
    }
    return left.length - right.length;
  });
}
function verify(record: PolicyEvaluationDatasetRecord) {
  const { input, evidence } = observe(record);
  const result = enumerate(input, evidence, limits);
  const expected = expectedReferences(record);
  expect(result.references).toEqual(expected);
  expect(result.referenceBytes).toBe(
    expected.reduce((total, entry) => total + Buffer.byteLength(json(entry), "utf8"), 0),
  );
  expect(result.recordSha256).toBe(hash(record));
  expect(result.source).toEqual(input.source);
  return result;
}

describe.each(records.map((record, index) => ({ record, name: vectors[index]?.name })))(
  "dataset references: $name",
  ({ record }) => {
    it("preserves every independently identified dependency and exact canonical bytes", () => {
      verify(record);
    });
    it("allows exact limits and rejects a truncated inventory", () => {
      const { input, evidence } = observe(record);
      const result = verify(record);
      expect(
        enumerate(input, evidence, {
          maxReferences: result.references.length,
          maxReferenceBytes: result.referenceBytes,
        }),
      ).toEqual(result);
      for (const budget of [
        { ...limits, maxReferences: result.references.length - 1 },
        { ...limits, maxReferenceBytes: result.referenceBytes - 1 },
      ]) {
        expect(() => enumerate(input, evidence, budget)).toThrowError(
          expect.objectContaining({ code: "policy_evaluation_evidence_references_invalid" }),
        );
      }
    });
    it("rejects semantic tampering before traversing references", () => {
      const { input, evidence } = observe(record);
      expect(() =>
        enumerate(input, { ...evidence, record: { ...record, name: "Tampered" } }, limits),
      ).toThrowError(expect.objectContaining({ reason: "evidence_unverified" }));
    });
    it("rejects a receipt-only replacement even with an unchanged definition digest", () => {
      const { input, evidence } = observe(record);
      expect(() =>
        enumerate(
          input,
          { ...evidence, record: { ...record, createdByPrincipalId: "usr_replaced" } },
          limits,
        ),
      ).toThrowError(expect.objectContaining({ reason: "observation_mismatch" }));
    });
    it("rejects substituted observation hashes and source identities", () => {
      const { input, evidence } = observe(record);
      expect(() =>
        enumerate(
          input,
          { ...evidence, observation: { status: "verified", recordSha256: "f".repeat(64) } },
          limits,
        ),
      ).toThrowError(expect.objectContaining({ reason: "observation_mismatch" }));
      const source = structuredClone(evidence.source);
      source.reference.definitionSha256 = "f".repeat(64);
      expect(() => enumerate(input, { ...evidence, source }, limits)).toThrowError(
        expect.objectContaining({ reason: "observation_mismatch" }),
      );
    });
    for (const key of ["tenantId", "projectId", "environmentId"] as const) {
      it(`rejects another ${key}`, () => {
        const { input, evidence } = observe(record);
        input.scope[key] = "foreign_scope";
        expect(() => enumerate(input, evidence, limits)).toThrowError(
          expect.objectContaining({ reason: "evidence_unverified" }),
        );
      });
    }
    it("rejects a record later than the exact semantic cut", () => {
      const { input, evidence } = observe(record);
      input.evaluationTime = "2026-09-08T00:00:00.122999999999999999999Z";
      expect(() => enumerate(input, evidence, limits)).toThrowError(
        expect.objectContaining({ reason: "evidence_unverified" }),
      );
    });
    it("does not alias returned values to input or observed records", () => {
      const { input, evidence } = observe(record);
      const original = structuredClone({ input, evidence });
      const result = enumerate(input, evidence, limits);
      Object.assign(result.references[0] as object, { path: "mutated" });
      result.source.reference.definitionSha256 = "f".repeat(64);
      expect({ input, evidence }).toEqual(original);
      expect(enumerate(input, evidence, limits)).toEqual(verify(record));
    });
  },
);

describe("interaction dependency integrity", () => {
  it("fails closed if a trusted inspector regresses and returns an unbound artifact alias", () => {
    const record = interactionRecord();
    const { input } = observe(record);
    record.interactionCapture.artifacts = record.interactionCapture.artifacts.filter(
      (binding) => binding.contentReference.artifactId !== "art_model_input",
    );
    // Deliberate internal fault injection, not an admitted input. Real domain validation rejects
    // this body; the traversal must also fail rather than silently omit its broken join.
    const corrupted = {
      source: input.source,
      record,
      observation: { status: "verified" as const, recordSha256: hash(record) },
    };
    const spy = vi
      .spyOn(datasetReader, "inspectPolicyEvaluationDataset")
      .mockReturnValue(corrupted);
    try {
      expect(() => enumerate(input, corrupted, limits)).toThrowError(
        expect.objectContaining({ reason: "evidence_unverified" }),
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("preserves unexpected traversal failures without fabricating an empty inventory", () => {
    const { input, evidence } = observe(interactionRecord());
    const failure = new Error("collector unavailable");
    const spy = vi
      .spyOn(PolicyEvaluationReferenceCollector.prototype, "artifact")
      .mockImplementation(() => {
        throw failure;
      });
    try {
      expect(() => enumerate(input, evidence, limits)).toThrowError(
        expect.objectContaining({ reason: "input_invalid", cause: failure }),
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("preserves all model and tool artifacts, optional inputs, failed attempts and repeated references", () => {
    const record = richRecord();
    const result = verify(record);
    expect(
      result.references.some(
        (ref) =>
          ref.path ===
          "/interactionCapture/interactions/0/attempts/0/artifacts/providerRequestArtifactId",
      ),
    ).toBe(true);
    expect(
      result.references.some(
        (ref) =>
          ref.path ===
          "/interactionCapture/interactions/1/attempts/0/artifacts/argumentsArtifactId",
      ),
    ).toBe(true);
    const artifacts = result.references.filter((ref) => ref.kind === "artifact");
    expect(artifacts.length).toBeGreaterThan(
      new Set(artifacts.map((ref) => ref.reference.artifactId)).size,
    );
  });
  it("preserves numeric order beyond index nine for interactions and dataset members", () => {
    const record = richRecord();
    const model = record.interactionCapture.interactions[0] as ModelInteraction;
    const tool = record.interactionCapture.interactions[1] as ToolInteraction;
    tool.sequence = 12;
    record.interactionCapture.interactions = [
      ...Array.from({ length: 12 }, (_, i) => ({
        ...structuredClone(model),
        interactionId: `int_order_${i}`,
        sequence: i,
        attempts: model.attempts.map((attempt, j) => ({
          ...structuredClone(attempt),
          attemptId: `att_order_${i}_${j}`,
        })),
      })),
      tool,
    ];
    verify(redigest(record));
    const dataset = datasetRecord();
    const first = dataset.fixtureVersions[0] as RegressionDatasetVersion["fixtureVersions"][number];
    dataset.fixtureVersions = Array.from({ length: 12 }, (_, i) => ({
      ...first,
      fixtureId: `fix_order_${i}`,
      fixtureVersionId: `fiv_order_${i}`,
    }));
    const {
      createdAt: _time,
      createdByPrincipalId: _by,
      definitionSha256: _sha,
      ...definition
    } = dataset;
    dataset.definitionSha256 = digestRegressionDatasetVersionDefinition(definition);
    verify(dataset);
  });
  it("reads a changing wrapper body once and captures root context before getters run", () => {
    const record = richRecord();
    const { input, evidence } = observe(record);
    const body = vi.fn(() => record);
    const wrapper = {
      ...evidence,
      get record() {
        return body();
      },
      get observation() {
        input.scope.tenantId = "ten_changed";
        input.evaluationTime = "2000-01-01T00:00:00Z";
        return evidence.observation;
      },
    } as PolicyEvaluationDatasetRead;
    expect(enumerate(input, wrapper, limits)).toEqual(verify(record));
    expect(body).toHaveBeenCalledTimes(1);
  });
  it("rejects missing, unavailable, malformed and unknown-field wrappers", () => {
    const record = richRecord();
    const { input, evidence } = observe(record);
    for (const bad of [
      null,
      {},
      { ...evidence, injected: undefined },
      { ...evidence, observation: { status: "missing" }, record: null },
      { ...evidence, record: null },
      { ...evidence, record: undefined },
    ]) {
      expect(() => enumerate(input, bad as PolicyEvaluationDatasetRead, limits)).toThrowError(
        expect.objectContaining({ code: "policy_evaluation_evidence_references_invalid" }),
      );
    }
  });
  it("does not confuse a locally inspected body with retained repository authority", async () => {
    const record = records[0] as RegressionFixtureVersion;
    const repository = new MemoryRegressionVersionRepository();
    await repository.publishFixtureVersion(structuredClone(record));
    const input = context(record);
    const evidence = await readPolicyEvaluationDataset(input, repository);
    expect(enumerate(input, evidence, limits)).toEqual(verify(record));
    const dataset = datasetRecord();
    await repository.publishDatasetVersion(dataset);
    expect(
      enumerate(
        context(dataset),
        await readPolicyEvaluationDataset(context(dataset), repository),
        limits,
      ),
    ).toEqual(verify(dataset));
  });
  for (const kind of ["prompt", "tool"] as const) {
    for (const conflicting of [false, true]) {
      it(`checks ${kind} semantic conflicts through a real parent with multiple locations: ${conflicting}`, () => {
        const record = richRecord();
        const original = record.interactionCapture.interactions[kind === "prompt" ? 0 : 1] as
          | ModelInteraction
          | ToolInteraction;
        const cloned = structuredClone(original);
        cloned.sequence = 2;
        cloned.interactionId = "int_semantic_copy";
        cloned.attempts.forEach((attempt, i) => {
          attempt.attemptId = `att_semantic_copy_${i}`;
        });
        let originalArtifactId: string;
        let definitionSha256: string;
        if (cloned.kind === "model") {
          originalArtifactId = cloned.prompt.artifactId;
          definitionSha256 = conflicting ? "c".repeat(64) : cloned.prompt.definitionSha256;
          cloned.prompt = { ...cloned.prompt, artifactId: "art_semantic_copy", definitionSha256 };
        } else {
          cloned.callId = "call_semantic_copy";
          originalArtifactId = cloned.tool.artifactId;
          definitionSha256 = conflicting ? "c".repeat(64) : cloned.tool.definitionSha256;
          cloned.tool = { ...cloned.tool, artifactId: "art_semantic_copy", definitionSha256 };
        }
        const binding = record.interactionCapture.artifacts.find(
          (b) => b.contentReference.artifactId === originalArtifactId,
        );
        if (!binding) throw new Error("Expected semantic fixture binding");
        record.interactionCapture.artifacts.push({
          ...structuredClone(binding),
          contentReference: {
            ...binding.contentReference,
            artifactId: "art_semantic_copy",
            sha256: definitionSha256,
          },
        });
        record.interactionCapture.artifacts.sort((a, b) =>
          a.contentReference.artifactId < b.contentReference.artifactId ? -1 : 1,
        );
        record.interactionCapture.interactions.push(cloned);
        redigest(record);
        const { input, evidence } = observe(record);
        if (conflicting)
          expect(() => enumerate(input, evidence, limits)).toThrowError(
            expect.objectContaining({ reason: "reference_conflict" }),
          );
        else verify(record);
      });
    }
    it(`rejects contradictory ${kind} version digests while retaining duplicate content locations`, () => {
      const out = new PolicyEvaluationReferenceCollector(limits);
      if (kind === "prompt") {
        const original = (
          interactionRecord().interactionCapture.interactions[0] as ModelInteraction
        ).prompt;
        out.prompt("/first", original);
        out.prompt("/copy", { ...original, artifactId: "art_other_location" });
        expect(() =>
          out.prompt("/conflict", { ...original, definitionSha256: "f".repeat(64) }),
        ).toThrowError(expect.objectContaining({ reason: "reference_conflict" }));
      } else {
        const original = (richRecord().interactionCapture.interactions[1] as ToolInteraction).tool;
        out.toolContract("/first", original);
        out.toolContract("/copy", { ...original, artifactId: "art_other_location" });
        expect(() =>
          out.toolContract("/conflict", { ...original, definitionSha256: "f".repeat(64) }),
        ).toThrowError(expect.objectContaining({ reason: "reference_conflict" }));
      }
      expect(out.result().references).toHaveLength(2);
    });
  }
  it("does not read an unverified body and preserves operational failure causes", () => {
    const record = interactionRecord();
    const { input, evidence } = observe(record);
    const failure = new Error("accessor failed");
    const body = vi.fn(() => {
      throw failure;
    });
    const wrapper = {
      ...evidence,
      get record() {
        return body();
      },
    } as PolicyEvaluationDatasetRead;
    expect(() =>
      enumerate(
        input,
        {
          ...evidence,
          observation: { status: "missing" },
          get record() {
            return body();
          },
        } as PolicyEvaluationDatasetRead,
        limits,
      ),
    ).toThrowError(expect.objectContaining({ reason: "evidence_unverified" }));
    expect(body).not.toHaveBeenCalled();
    expect(() => enumerate(input, wrapper, limits)).toThrowError(
      expect.objectContaining({ reason: "input_invalid", cause: failure }),
    );
  });
  it("rejects malformed budgets before reading the wrapper", () => {
    const record = interactionRecord();
    const { input, evidence } = observe(record);
    const body = vi.fn(() => record);
    const wrapper = {
      ...evidence,
      get record() {
        return body();
      },
    } as PolicyEvaluationDatasetRead;
    for (const budget of [
      null,
      { ...limits, maxReferences: -1 },
      { ...limits, maxReferenceBytes: Infinity },
      { ...limits, injected: true },
    ]) {
      expect(() => enumerate(input, wrapper, budget as typeof limits)).toThrowError(
        expect.objectContaining({ reason: "input_invalid" }),
      );
    }
    expect(body).not.toHaveBeenCalled();
  });
});
