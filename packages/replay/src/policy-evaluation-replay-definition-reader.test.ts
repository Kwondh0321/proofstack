import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ReplayPlan,
  ReplayPlanDefinition,
  TargetRelease,
  TargetReleaseDefinition,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type PolicyEvaluationReplayDefinitionSource,
  readPolicyEvaluationReplayDefinition,
} from "./policy-evaluation-replay-definition-reader.js";
import type { ReplayDefinitionRepository } from "./replay-definition-repository.js";
import { MemoryReplayDefinitionRepository } from "./testing/memory-replay-definition-repository.js";

interface Vector {
  readonly name: string;
  readonly kind: "replay_plan" | "target_release";
  readonly input: ReplayPlanDefinition | TargetReleaseDefinition;
  readonly sha256: string;
}
const { vectors } = JSON.parse(
  readFileSync(new URL("../vectors/replay-definition-v1.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };
const createdAt = "2026-09-08T00:00:00.123Z";
function record(vector: Vector): ReplayPlan | TargetRelease {
  return {
    ...structuredClone(vector.input),
    createdAt,
    createdByPrincipalId: "usr_replay_author",
    definitionSha256: vector.sha256,
  };
}
function input(value: ReplayPlan | TargetRelease) {
  const source: PolicyEvaluationReplayDefinitionSource =
    "planVersionId" in value
      ? {
          kind: "replay_plan",
          reference: {
            planId: value.planId,
            planVersionId: value.planVersionId,
            definitionSha256: value.definitionSha256,
          },
        }
      : {
          kind: "target_release",
          reference: {
            targetId: value.targetId,
            targetReleaseId: value.targetReleaseId,
            definitionSha256: value.definitionSha256,
            targetAdapter: structuredClone(value.targetAdapter),
            workerProtocol: structuredClone(value.workerProtocol),
          },
        };
  return { evaluationTime: createdAt, scope: structuredClone(value.scope), source };
}
function ports() {
  return {
    findReplayPlan: vi.fn<ReplayDefinitionRepository["findReplayPlan"]>(async () => null),
    findTargetRelease: vi.fn<ReplayDefinitionRepository["findTargetRelease"]>(async () => null),
  };
}
function routed(vector: Vector, raw: unknown) {
  const repository = ports();
  if (vector.kind === "replay_plan") repository.findReplayPlan.mockResolvedValue(raw as ReplayPlan);
  else repository.findTargetRelease.mockResolvedValue(raw as TargetRelease);
  return repository;
}
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

describe.each(vectors)("replay definition acquisition: $name", (vector) => {
  it("reads one exact immutable version with a full canonical record hash", async () => {
    const value = record(vector);
    const repository = routed(vector, value);
    const command = input(value);
    const result = await readPolicyEvaluationReplayDefinition(command, repository);
    expect(result).toEqual({
      observation: { recordSha256: hash(value), status: "verified" },
      record: value,
      source: command.source,
    });
    if ("planVersionId" in value) {
      expect(repository.findReplayPlan).toHaveBeenCalledExactlyOnceWith(
        value.scope,
        value.planVersionId,
      );
      expect(repository.findTargetRelease).not.toHaveBeenCalled();
    } else {
      expect(repository.findTargetRelease).toHaveBeenCalledExactlyOnceWith(
        value.scope,
        value.targetReleaseId,
      );
      expect(repository.findReplayPlan).not.toHaveBeenCalled();
    }
    if (!result.record) throw new Error("expected retained definition");
    result.record.scope.projectId = "prj_changed";
    expect(value).toEqual(record(vector));
  });
  it("returns missing only for null", async () => {
    const command = input(record(vector));
    expect(await readPolicyEvaluationReplayDefinition(command, ports())).toEqual({
      observation: { status: "missing" },
      record: null,
      source: command.source,
    });
  });
  for (const raw of [undefined, false, 0, "invalid", {}]) {
    it(`rejects malformed ${String(raw)} without fabricating absence`, async () => {
      expect(
        (await readPolicyEvaluationReplayDefinition(input(record(vector)), routed(vector, raw)))
          .observation,
      ).toEqual(invalid);
    });
  }
  for (const change of [
    { definitionSha256: "f".repeat(64) },
    { schemaVersion: "999" },
    { approved: true },
    { createdAt: "bad" },
  ]) {
    it(`rejects schema or digest corruption: ${JSON.stringify(change)}`, async () => {
      const value = record(vector);
      expect(
        (
          await readPolicyEvaluationReplayDefinition(
            input(value),
            routed(vector, { ...value, ...change }),
          )
        ).observation,
      ).toEqual(invalid);
    });
  }
  const fields = Object.entries(input(record(vector)).source.reference).flatMap<{
    key: string;
    child: string | null;
  }>(([key, value]) =>
    typeof value === "object"
      ? Object.keys(value).map((child) => ({ key, child }))
      : [{ key, child: null }],
  );
  for (const { key, child } of fields) {
    it(`checks exact ${key}${child ? `.${child}` : ""}, not only the lookup ID`, async () => {
      const value = record(vector);
      const command = input(value);
      if (child) {
        const nested = Reflect.get(command.source.reference, key);
        Object.assign(nested, { [child]: child === "name" ? "different_protocol" : "99.0.0" });
      } else {
        Object.assign(command.source.reference, {
          [key]: key === "definitionSha256" ? "f".repeat(64) : "different_identity",
        });
      }
      expect(
        (await readPolicyEvaluationReplayDefinition(command, routed(vector, value))).observation,
      ).toEqual({ reason: "reference_mismatch", status: "unavailable" });
    });
  }
  for (const key of ["tenantId", "projectId", "environmentId"] as const) {
    it(`rejects substitution from another ${key}`, async () => {
      const value = record(vector);
      const command = input(value);
      command.scope[key] = "different_scope";
      expect(await readPolicyEvaluationReplayDefinition(command, routed(vector, value))).toEqual({
        observation: { reason: "reference_mismatch", status: "unavailable" },
        record: null,
        source: command.source,
      });
    });
  }
  it("preserves sub-millisecond evaluation cut precision", async () => {
    const value = record(vector);
    const command = input(value);
    command.evaluationTime = "2026-09-08T00:00:00.122999999999999999999999999999Z";
    expect(
      (await readPolicyEvaluationReplayDefinition(command, routed(vector, value))).observation,
    ).toEqual({ reason: "not_yet_available", status: "unavailable" });
  });
  it("hashes receipt-only changes rather than only the definition", async () => {
    const value = record(vector);
    const changed = { ...value, createdByPrincipalId: "usr_changed_receipt" };
    const observed = await readPolicyEvaluationReplayDefinition(
      input(value),
      routed(vector, changed),
    );
    expect(observed.observation).toEqual({ recordSha256: hash(changed), status: "verified" });
    expect(hash(changed)).not.toBe(hash(value));
  });
  it("propagates repository exceptions without turning them into missing or unavailable", async () => {
    const value = record(vector);
    const repository = routed(vector, value);
    const error = new Error("storage offline");
    if (vector.kind === "replay_plan") repository.findReplayPlan.mockRejectedValue(error);
    else repository.findTargetRelease.mockRejectedValue(error);
    await expect(readPolicyEvaluationReplayDefinition(input(value), repository)).rejects.toBe(
      error,
    );
  });
  it("propagates unexpected validation exceptions", async () => {
    const value = record(vector);
    const error = new Error("unexpected accessor failure");
    const raw = {
      ...value,
      get schemaVersion() {
        throw error;
      },
    };
    await expect(
      readPolicyEvaluationReplayDefinition(input(value), routed(vector, raw)),
    ).rejects.toBe(error);
  });
  it("rejects semantic content changed without a matching definition digest", async () => {
    const value = record(vector);
    const raw =
      "planVersionId" in value
        ? { ...value, planId: "plan_changed" }
        : { ...value, targetId: "target_changed" };
    expect(
      (await readPolicyEvaluationReplayDefinition(input(value), routed(vector, raw))).observation,
    ).toEqual(invalid);
  });
  it("compares nested identities by value rather than object key order", async () => {
    const value = record(vector);
    const command = input(value);
    if (command.source.kind === "target_release") {
      const { name, protocolVersion, version } = command.source.reference.targetAdapter;
      command.source.reference.targetAdapter = { version, protocolVersion, name };
      const protocol = command.source.reference.workerProtocol;
      command.source.reference.workerProtocol = { version: protocol.version, name: protocol.name };
    }
    expect(
      (await readPolicyEvaluationReplayDefinition(command, routed(vector, value))).observation
        .status,
    ).toBe("verified");
  });
  it("owns the input context before the read callback runs", async () => {
    const value = record(vector);
    const command = input(value);
    const repository = routed(vector, value);
    const original = structuredClone(command.source);
    const mutate = () => {
      command.evaluationTime = "2000-01-01T00:00:00Z";
      command.scope.tenantId = "ten_changed";
      command.source.reference.definitionSha256 = "f".repeat(64);
    };
    if (vector.kind === "replay_plan")
      repository.findReplayPlan.mockImplementation(async (scope) => {
        scope.projectId = "prj_changed";
        mutate();
        return value as ReplayPlan;
      });
    else
      repository.findTargetRelease.mockImplementation(async (scope) => {
        scope.projectId = "prj_changed";
        mutate();
        return value as TargetRelease;
      });
    expect(await readPolicyEvaluationReplayDefinition(command, repository)).toEqual({
      observation: { recordSha256: hash(value), status: "verified" },
      record: value,
      source: original,
    });
  });
});

describe("replay definition authority boundary", () => {
  it("reads real memory publications and hides all foreign scope dimensions", async () => {
    const repository = new MemoryReplayDefinitionRepository();
    const release = record(
      vectors.find((vector) => vector.kind === "target_release") as Vector,
    ) as TargetRelease;
    const plan = record(
      vectors.find((vector) => vector.kind === "replay_plan") as Vector,
    ) as ReplayPlan;
    await repository.publishTargetRelease(release);
    await repository.publishReplayPlan(plan);
    for (const value of [release, plan]) {
      expect((await readPolicyEvaluationReplayDefinition(input(value), repository)).record).toEqual(
        value,
      );
      for (const key of ["tenantId", "projectId", "environmentId"] as const) {
        const command = input(value);
        command.scope[key] = "foreign_scope";
        expect(
          (await readPolicyEvaluationReplayDefinition(command, repository)).observation,
        ).toEqual({ status: "missing" });
      }
    }
  });
  it("does not mistake a target release for a replay plan or vice versa", async () => {
    for (const vector of vectors) {
      const other = vectors.find((value) => value.kind !== vector.kind) as Vector;
      expect(
        (
          await readPolicyEvaluationReplayDefinition(
            input(record(vector)),
            routed(vector, record(other)),
          )
        ).observation,
      ).toEqual(invalid);
    }
  });
  it("rejects malformed or unsupported input before any lookup", async () => {
    const repository = ports();
    const command = input(record(vectors[0] as Vector));
    for (const malformed of [
      null,
      {
        ...command,
        source: {
          kind: "dataset_version",
          reference: {
            datasetId: "dat_a",
            datasetVersionId: "datv_a",
            definitionSha256: "a".repeat(64),
          },
        },
      },
      { ...command, scope: {} },
    ]) {
      await expect(
        readPolicyEvaluationReplayDefinition(malformed as typeof command, repository),
      ).rejects.toMatchObject({ code: "policy_evaluation_definition_read_input_invalid" });
    }
    expect(repository.findReplayPlan).not.toHaveBeenCalled();
    expect(repository.findTargetRelease).not.toHaveBeenCalled();
  });
});
