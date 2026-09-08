import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinition,
  RegressionDatasetVersion,
  RegressionDatasetVersionDefinition,
  RegressionFixtureVersion,
  RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import {
  type PolicyEvaluationDatasetRecord,
  type PolicyEvaluationDatasetSource,
  readPolicyEvaluationDataset,
} from "./policy-evaluation-dataset-reader.js";
import type { InteractionFixtureVersionRepository } from "./regression-version-repository.js";
import { MemoryRegressionVersionRepository } from "./testing/memory-regression-version-repository.js";

type Vector = {
  name: string;
  kind: "dataset" | "fixture" | "recorded_interaction_fixture";
  input:
    | RegressionDatasetVersionDefinition
    | RegressionFixtureVersionDefinition
    | RecordedInteractionFixtureVersionDefinition;
  sha256: string;
};
const vectors = ["regression-definition-v1.json", "interaction-fixture-definition-v2.json"].flatMap(
  (file) =>
    (
      JSON.parse(readFileSync(new URL(`../vectors/${file}`, import.meta.url), "utf8")) as {
        vectors: Vector[];
      }
    ).vectors,
);
const createdAt = "2026-09-08T00:00:00.123Z";
function version(vector: Vector): PolicyEvaluationDatasetRecord {
  const definition = structuredClone(vector.input);
  return {
    ...definition,
    createdAt,
    createdByPrincipalId: "usr_policy_source",
    definitionSha256: vector.sha256,
    ...("source" in definition
      ? { source: { ...definition.source, capturedAt: "2026-09-08T00:00:00.000Z" } }
      : {}),
  } as PolicyEvaluationDatasetRecord;
}
function input(record: PolicyEvaluationDatasetRecord) {
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
type ReadRepository = Pick<
  InteractionFixtureVersionRepository,
  "findDatasetVersion" | "findFixtureVersion" | "findRecordedInteractionFixtureVersion"
>;
function ports() {
  return {
    findDatasetVersion: vi.fn<ReadRepository["findDatasetVersion"]>(async () => null),
    findFixtureVersion: vi.fn<ReadRepository["findFixtureVersion"]>(async () => null),
    findRecordedInteractionFixtureVersion: vi.fn<
      ReadRepository["findRecordedInteractionFixtureVersion"]
    >(async () => null),
  };
}
function routed(vector: Vector, raw: unknown) {
  const repository = ports();
  if (vector.kind === "dataset")
    repository.findDatasetVersion.mockResolvedValue(raw as RegressionDatasetVersion);
  else if (vector.kind === "fixture")
    repository.findFixtureVersion.mockResolvedValue(raw as RegressionFixtureVersion);
  else
    repository.findRecordedInteractionFixtureVersion.mockResolvedValue({
      ownerships: [],
      version: raw as RecordedInteractionFixtureVersion,
    });
  return repository;
}
// Independent sorted JSON oracle over plain vector values; no production encoder/reader output.
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
const invalid = { reason: "record_invalid", status: "unavailable" };

describe.each(vectors)("dataset acquisition: $name", (vector) => {
  it("reads exact definitions including lineage and binds complete receipt-bearing bytes", async () => {
    const record = version(vector);
    const command = input(record);
    const repository = routed(vector, record);
    const result = await readPolicyEvaluationDataset(command, repository);
    expect(result).toEqual({
      observation: { recordSha256: hash(record), status: "verified" },
      record,
      source: command.source,
    });
    const id = "datasetVersionId" in record ? record.datasetVersionId : record.fixtureVersionId;
    if (vector.kind === "dataset") {
      expect(repository.findDatasetVersion).toHaveBeenCalledExactlyOnceWith(record.scope, id);
      expect(repository.findFixtureVersion).not.toHaveBeenCalled();
      expect(repository.findRecordedInteractionFixtureVersion).not.toHaveBeenCalled();
    } else {
      expect(repository.findFixtureVersion).toHaveBeenCalledExactlyOnceWith(record.scope, id);
      expect(repository.findRecordedInteractionFixtureVersion).toHaveBeenCalledExactlyOnceWith(
        record.scope,
        id,
      );
      expect(repository.findDatasetVersion).not.toHaveBeenCalled();
    }
    if (!result.record) throw new Error("expected record");
    result.record.scope.projectId = "prj_returned";
    expect(record).toEqual(version(vector));
  });
  it("preserves exact absence", async () => {
    expect(await readPolicyEvaluationDataset(input(version(vector)), ports())).toEqual({
      observation: { status: "missing" },
      record: null,
      source: input(version(vector)).source,
    });
  });
  it("propagates unexpected validation exceptions", async () => {
    const record = version(vector);
    const error = new Error("unexpected accessor failure");
    const raw = {
      ...record,
      get schemaVersion() {
        throw error;
      },
    };
    await expect(readPolicyEvaluationDataset(input(record), routed(vector, raw))).rejects.toBe(
      error,
    );
  });
  it("rejects semantic content changed without a matching definition digest", async () => {
    const record = version(vector);
    expect(
      (
        await readPolicyEvaluationDataset(
          input(record),
          routed(vector, { ...record, name: "Altered semantic name" }),
        )
      ).observation,
    ).toEqual(invalid);
  });
  for (const scopeKey of ["tenantId", "projectId", "environmentId"] as const) {
    it(`rejects a different requested ${scopeKey}`, async () => {
      const record = version(vector);
      const command = input(record);
      command.scope[scopeKey] = "different_scope";
      expect(await readPolicyEvaluationDataset(command, routed(vector, record))).toEqual({
        observation: { reason: "reference_mismatch", status: "unavailable" },
        record: null,
        source: command.source,
      });
    });
  }
  for (const key of Object.keys(input(version(vector)).source.reference)) {
    it(`checks every reference field: ${key}`, async () => {
      const record = version(vector);
      const command = input(record);
      Object.assign(command.source.reference, {
        [key]: key === "definitionSha256" ? "f".repeat(64) : "different_identity",
      });
      expect(
        (await readPolicyEvaluationDataset(command, routed(vector, record))).observation,
      ).toEqual({ reason: "reference_mismatch", status: "unavailable" });
    });
  }
  for (const change of [
    { definitionSha256: "f".repeat(64) },
    { schemaVersion: "999" },
    { approval: true },
    { createdAt: "bad" },
  ]) {
    it(`rejects invalid stored data: ${JSON.stringify(change)}`, async () => {
      const record = version(vector);
      expect(
        (await readPolicyEvaluationDataset(input(record), routed(vector, { ...record, ...change })))
          .observation,
      ).toEqual(invalid);
    });
  }
  for (const raw of [undefined, false, 0, "invalid", {}]) {
    it(`does not turn malformed ${String(raw)} into a missing version`, async () => {
      expect(
        (await readPolicyEvaluationDataset(input(version(vector)), routed(vector, raw)))
          .observation,
      ).toEqual(invalid);
    });
  }
  it("rejects publication after semantic evaluation time at full supported precision", async () => {
    const record = version(vector);
    const command = input(record);
    command.evaluationTime = "2026-09-08T00:00:00.122999999999999999999999999999Z";
    expect(
      (await readPolicyEvaluationDataset(command, routed(vector, record))).observation,
    ).toEqual({ reason: "not_yet_available", status: "unavailable" });
  });
  it("binds receipt-only changes independently from definition identity", async () => {
    const record = version(vector);
    const changed = { ...record, createdByPrincipalId: "usr_other_receipt" };
    const first = await readPolicyEvaluationDataset(input(record), routed(vector, record));
    const second = await readPolicyEvaluationDataset(input(record), routed(vector, changed));
    expect(second.observation).toEqual({ recordSha256: hash(changed), status: "verified" });
    expect(second.observation).not.toEqual(first.observation);
  });
});

describe("fixture format resolution and real immutable storage", () => {
  const fixtureVector = vectors.find((v) => v.kind === "fixture") as Vector;
  const interactionVector = vectors.find(
    (v) => v.kind === "recorded_interaction_fixture",
  ) as Vector;
  for (const evidence of [undefined, {}, false, version(fixtureVector)]) {
    it(`rejects simultaneous or malformed evidence-store responses: ${String(evidence)}`, async () => {
      const record = version(interactionVector);
      const repository = routed(interactionVector, record);
      repository.findFixtureVersion.mockResolvedValue(evidence as RegressionFixtureVersion);
      expect((await readPolicyEvaluationDataset(input(record), repository)).observation).toEqual(
        invalid,
      );
    });
  }
  for (const interaction of [
    undefined,
    false,
    0,
    "wrong",
    {},
    { version: null },
    { version: {} },
  ]) {
    it(`rejects an invalid interaction-store response: ${JSON.stringify(interaction)}`, async () => {
      const repository = ports();
      repository.findRecordedInteractionFixtureVersion.mockResolvedValue(interaction as never);
      expect(
        (await readPolicyEvaluationDataset(input(version(interactionVector)), repository))
          .observation,
      ).toEqual(invalid);
    });
  }
  it("does not accept a v2 record through the v1 store or v1 through the v2 store", async () => {
    expect(
      (
        await readPolicyEvaluationDataset(
          input(version(interactionVector)),
          routed(fixtureVector, version(interactionVector)),
        )
      ).observation,
    ).toEqual(invalid);
    expect(
      (
        await readPolicyEvaluationDataset(
          input(version(fixtureVector)),
          routed(interactionVector, version(fixtureVector)),
        )
      ).observation,
    ).toEqual(invalid);
  });
  for (const method of [
    "findDatasetVersion",
    "findFixtureVersion",
    "findRecordedInteractionFixtureVersion",
  ] as const) {
    it(`propagates ${method} failures instead of choosing the other store`, async () => {
      const vector =
        method === "findDatasetVersion"
          ? (vectors.find((v) => v.kind === "dataset") as Vector)
          : fixtureVector;
      const repository = routed(vector, version(vector));
      const failure = new Error("storage failure");
      repository[method].mockRejectedValue(failure);
      await expect(readPolicyEvaluationDataset(input(version(vector)), repository)).rejects.toBe(
        failure,
      );
    });
  }
  it("uses separate scope copies for both fixture queries", async () => {
    const record = version(interactionVector);
    const repository = routed(interactionVector, record);
    repository.findFixtureVersion.mockImplementation(async (scope) => {
      scope.projectId = "mutated_scope";
      return null;
    });
    expect((await readPolicyEvaluationDataset(input(record), repository)).observation.status).toBe(
      "verified",
    );
    expect(repository.findRecordedInteractionFixtureVersion).toHaveBeenCalledExactlyOnceWith(
      record.scope,
      "fixtureVersionId" in record ? record.fixtureVersionId : "unreachable",
    );
  });
  it("retains records published in dependency order and hides all three foreign scope dimensions", async () => {
    const repository = new MemoryRegressionVersionRepository();
    const fixture = version(fixtureVector) as RegressionFixtureVersion;
    await repository.publishFixtureVersion(fixture);
    const definition = structuredClone(
      interactionVector.input,
    ) as RecordedInteractionFixtureVersionDefinition;
    definition.predecessor = {
      fixtureVersionId: fixture.fixtureVersionId,
      definitionSha256: fixture.definitionSha256,
    };
    const interaction = version({
      ...interactionVector,
      input: definition,
      sha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    }) as RecordedInteractionFixtureVersion;
    for (const binding of interaction.interactionCapture.artifacts) {
      repository.seedInteractionArtifact({
        schemaVersion: "0.1",
        scope: interaction.scope,
        contentReference: binding.contentReference,
        redaction: binding.redaction,
        retention: binding.retention,
        state: "available",
        availableAt: "2026-09-08T00:00:00.000Z",
        createdAt: "2026-09-08T00:00:00.000Z",
      });
    }
    await repository.publishRecordedInteractionFixtureVersion(interaction);
    const datasetVector = vectors.find((v) => v.kind === "dataset") as Vector;
    const dataset = version(datasetVector) as RegressionDatasetVersion;
    await repository.publishDatasetVersion(dataset);
    for (const record of [fixture, interaction, dataset]) {
      expect((await readPolicyEvaluationDataset(input(record), repository)).record).toEqual(record);
      for (const key of ["tenantId", "projectId", "environmentId"] as const) {
        const command = input(record);
        command.scope[key] = "foreign_scope";
        expect((await readPolicyEvaluationDataset(command, repository)).observation).toEqual({
          status: "missing",
        });
      }
    }
  });
  it("does not accept a caller-selected source family or malformed context before repository reads", async () => {
    const repository = ports();
    const command = input(version(fixtureVector));
    for (const bad of [
      null,
      { ...command, evaluationTime: "invalid" },
      {
        ...command,
        source: {
          kind: "assessment",
          reference: { assessmentId: "ass_a", definitionSha256: "a".repeat(64) },
        },
      },
    ]) {
      await expect(
        readPolicyEvaluationDataset(bad as typeof command, repository),
      ).rejects.toMatchObject({ code: "policy_evaluation_definition_read_input_invalid" });
    }
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });
});
