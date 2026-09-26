import { readFileSync } from "node:fs";
import {
  encodeEvaluationCanonicalJson,
  type RecordedInteractionFixtureVersionDefinition,
  type RegressionDatasetVersionDefinition,
  type ReplayPlanDefinition,
  type RuntimeDefinition,
  type TargetReleaseDefinition,
} from "@proofstack/contracts";
import { digestRuntimeDefinition, inspectPolicyEvaluationRuntimeRecord } from "@proofstack/core";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
  inspectPolicyEvaluationDataset,
} from "@proofstack/datasets";
import { describe, expect, it, vi } from "vitest";
import { inspectPolicyEvaluationReplayDefinition } from "./policy-evaluation-replay-definition-reader.js";
import {
  inspectPolicyEvaluationReplayPlanBindings as inspect,
  type PolicyReplayPlanBindingRead,
} from "./policy-evaluation-replay-plan-bindings.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "./replay-definition-digest.js";
import { digestRecordedBoundaryReplayInvocationDefinition } from "./replay-digest.js";

const replayVectors = JSON.parse(
  readFileSync(new URL("../vectors/replay-definition-v1.json", import.meta.url), "utf8"),
) as {
  vectors: { kind: string; input: ReplayPlanDefinition | TargetReleaseDefinition }[];
};
const runtimeVectors = JSON.parse(
  readFileSync(
    new URL("../../contracts/vectors/runtime-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: { input: { definition: RuntimeDefinition } }[];
};
const fixtureVectors = JSON.parse(
  readFileSync(
    new URL("../../datasets/vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: { input: RecordedInteractionFixtureVersionDefinition }[];
};
const time = "2026-09-09T00:00:00.000Z";
const receipt = { createdAt: time, createdByPrincipalId: "principal_plan" };
const limits = { maxReferences: 1000, maxReferenceBytes: 1_000_000 };
interface Changes {
  plan?: (value: ReplayPlanDefinition) => void;
  target?: (value: TargetReleaseDefinition) => void;
  runtime?: (value: Extract<RuntimeDefinition, { recordKind: "replay_runtime_profile" }>) => void;
  dataset?: (value: RegressionDatasetVersionDefinition) => void;
  evidenceOnly?: boolean;
}

function harness(changes: Changes = {}) {
  const planDefinition = structuredClone(
    replayVectors.vectors.find((v) => v.kind === "replay_plan")?.input,
  ) as ReplayPlanDefinition;
  const targetDefinition = structuredClone(
    replayVectors.vectors.find((v) => v.kind === "target_release")?.input,
  ) as TargetReleaseDefinition;
  changes.target?.(targetDefinition);
  const scope = planDefinition.scope;
  const context = { scope, evaluationTime: time };
  const target = {
    ...targetDefinition,
    ...receipt,
    definitionSha256: digestTargetReleaseDefinition(targetDefinition),
  };
  planDefinition.targetRelease = {
    targetId: target.targetId,
    targetReleaseId: target.targetReleaseId,
    definitionSha256: target.definitionSha256,
    targetAdapter: target.targetAdapter,
    workerProtocol: target.workerProtocol,
  };
  const recorded = structuredClone(
    fixtureVectors.vectors[0]?.input,
  ) as RecordedInteractionFixtureVersionDefinition;
  recorded.scope = scope;
  const first = planDefinition.boundaries[0];
  if (first?.mode !== "recorded_stub") throw new Error("Expected recorded vector");
  recorded.fixtureId = first.invocation.fixture.fixtureId;
  recorded.fixtureVersionId = first.invocation.fixture.fixtureVersionId;
  const evidence = {
    schemaVersion: "0.1" as const,
    scope,
    name: recorded.name,
    fixtureId: recorded.fixtureId,
    fixtureVersionId: recorded.fixtureVersionId,
    source: recorded.source,
    replayability: "evidence_only" as const,
  };
  const fixtureDefinition = changes.evidenceOnly ? evidence : recorded;
  const fixture = {
    ...fixtureDefinition,
    ...receipt,
    source: { ...fixtureDefinition.source, capturedAt: time },
    definitionSha256: changes.evidenceOnly
      ? digestRegressionFixtureVersionDefinition(evidence)
      : digestRecordedInteractionFixtureVersionDefinition(recorded),
  };
  const fixtureReference = {
    fixtureId: fixture.fixtureId,
    fixtureVersionId: fixture.fixtureVersionId,
    definitionSha256: fixture.definitionSha256,
  };
  first.invocation.fixture = fixtureReference;
  first.invocation.targetAdapter = {
    name: target.targetAdapter.name,
    version: target.targetAdapter.version,
  };
  first.invocationDefinitionSha256 = digestRecordedBoundaryReplayInvocationDefinition(
    first.invocation,
  );
  const datasetDefinition: RegressionDatasetVersionDefinition = {
    schemaVersion: "0.1",
    scope,
    datasetId: planDefinition.dataset.datasetId,
    datasetVersionId: planDefinition.dataset.datasetVersionId,
    name: "Plan dataset",
    fixtureVersions: [fixtureReference],
  };
  changes.dataset?.(datasetDefinition);
  const dataset = {
    ...datasetDefinition,
    ...receipt,
    definitionSha256: digestRegressionDatasetVersionDefinition(datasetDefinition),
  };
  planDefinition.dataset = {
    datasetId: dataset.datasetId,
    datasetVersionId: dataset.datasetVersionId,
    definitionSha256: dataset.definitionSha256,
  };
  const runtime = structuredClone(
    runtimeVectors.vectors.find((v) => v.input.definition.recordKind === "replay_runtime_profile")
      ?.input.definition,
  ) as Extract<RuntimeDefinition, { recordKind: "replay_runtime_profile" }>;
  runtime.family = "node";
  runtime.runtime = { architecture: "x64", platform: "linux", version: "24.7.0" };
  changes.runtime?.(runtime);
  const isolation = structuredClone(
    runtimeVectors.vectors.find((v) => v.input.definition.recordKind === "replay_isolation_profile")
      ?.input.definition,
  ) as Extract<RuntimeDefinition, { recordKind: "replay_isolation_profile" }>;
  const register = (definition: RuntimeDefinition) => ({
    ...definition,
    schemaVersion: "0.1" as const,
    scope,
    registeredAt: time,
    registeredByPrincipalId: "principal_runtime",
    definitionSha256: digestRuntimeDefinition(scope, definition),
  });
  const runtimeRecord = register(runtime);
  const isolationRecord = register(isolation);
  planDefinition.runtimeProfile = {
    id: runtime.id,
    version: runtime.version,
    family: runtime.family,
    definitionSha256: runtimeRecord.definitionSha256,
  };
  planDefinition.isolationProfile = {
    id: isolation.id,
    version: isolation.version,
    kind: isolation.kind,
    definitionSha256: isolationRecord.definitionSha256,
  };
  changes.plan?.(planDefinition);
  const plan = {
    ...planDefinition,
    ...receipt,
    definitionSha256: digestReplayPlanDefinition(planDefinition),
  };
  const planRead = inspectPolicyEvaluationReplayDefinition(
    {
      ...context,
      source: {
        kind: "replay_plan",
        reference: {
          planId: plan.planId,
          planVersionId: plan.planVersionId,
          definitionSha256: plan.definitionSha256,
        },
      },
    },
    plan,
  );
  const reads: PolicyReplayPlanBindingRead[] = [
    planRead,
    inspectPolicyEvaluationReplayDefinition(
      { ...context, source: { kind: "target_release", reference: plan.targetRelease } },
      target,
    ),
    inspectPolicyEvaluationDataset(
      { ...context, source: { kind: "dataset_version", reference: plan.dataset } },
      dataset,
    ),
    inspectPolicyEvaluationDataset(
      { ...context, source: { kind: "regression_fixture_version", reference: fixtureReference } },
      fixture,
    ),
    inspectPolicyEvaluationRuntimeRecord(
      { ...context, source: { kind: "replay_runtime_profile", reference: plan.runtimeProfile } },
      runtimeRecord,
    ),
    inspectPolicyEvaluationRuntimeRecord(
      {
        ...context,
        source: { kind: "replay_isolation_profile", reference: plan.isolationProfile },
      },
      isolationRecord,
    ),
  ];
  for (const read of reads) expect(read.observation.status).toBe("verified");
  return {
    context,
    reads,
    plan,
    target,
    dataset,
    fixture,
    execute: () => inspect(context, reads, limits),
  };
}

describe("captured replay plan bindings", () => {
  it("preserves exact dependencies and original hashes, with stable sorted detached output", () => {
    const h = harness();
    const result = h.execute();
    expect(result.unavailablePlans).toEqual([]);
    const plan = result.plans[0];
    expect(result.plans).toHaveLength(1);
    expect(plan?.dependencies.map((d) => d.path)).toEqual([
      "/dataset",
      "/runtimeProfile",
      "/isolationProfile",
      "/targetRelease",
      "/boundaries/0/invocation/fixture",
    ]);
    expect(plan?.checks.map((c) => c.kind)).toEqual([
      "runtime_family",
      "runtime_configuration",
      "boundary_kind",
      "boundary_mode",
      "invocation_digest",
      "fixture_membership",
      "fixture_format",
    ]);
    expect(plan?.checks.every((c) => c.observation.status === "matched")).toBe(true);
    expect(h.reads[0]?.observation).toEqual({
      status: "verified",
      recordSha256: plan?.recordSha256,
    });
    for (const dependency of plan?.dependencies ?? [])
      expect(dependency.recordObservation).toEqual(
        h.reads.find(
          (r) =>
            r.source.reference.definitionSha256 === dependency.source.reference.definitionSha256,
        )?.observation,
      );
    expect(inspect(h.context, [...h.reads].reverse(), limits)).toEqual(result);
    const original = structuredClone(h.reads);
    if (!plan) throw new Error("Expected report");
    plan.source.reference.planVersionId = "plan_changed";
    Object.assign(plan.dependencies[0]?.recordObservation as object, {
      recordSha256: "f".repeat(64),
    });
    expect(h.reads).toEqual(original);
    expect(result).not.toHaveProperty("eligible");
    expect(result).not.toHaveProperty("sealed");
  });

  it.each([
    "family",
    "architecture",
    "platform",
    "version",
    "kind",
    "mode",
    "digest",
    "membership",
    "format",
  ])("detects semantic mismatch despite valid record hashes: %s", (kind) => {
    const changes: Changes = {};
    if (kind === "family")
      changes.runtime = (r) => {
        r.family = "other";
      };
    if (kind === "architecture")
      changes.runtime = (r) => {
        r.runtime.architecture = "arm64";
      };
    if (kind === "platform")
      changes.runtime = (r) => {
        r.runtime.platform = "darwin";
      };
    if (kind === "version")
      changes.runtime = (r) => {
        r.runtime.version = "25.0.0";
      };
    if (kind === "kind")
      changes.target = (r) => {
        r.supportedBoundaryKinds = ["tool"];
      };
    if (kind === "mode")
      changes.target = (r) => {
        r.supportedBoundaryModes = ["simulation"];
      };
    if (kind === "digest")
      changes.plan = (r) => {
        const b = r.boundaries[0];
        if (b?.mode === "recorded_stub") b.invocationDefinitionSha256 = "f".repeat(64);
      };
    if (kind === "membership")
      changes.dataset = (r) => {
        r.fixtureVersions[0] = {
          fixtureId: "another_fixture",
          fixtureVersionId: "another_version",
          definitionSha256: "f".repeat(64),
        };
      };
    if (kind === "format") changes.evidenceOnly = true;
    const report = harness(changes).execute();
    const expected =
      kind === "family"
        ? "runtime_family"
        : ["architecture", "platform", "version"].includes(kind)
          ? "runtime_configuration"
          : kind === "kind"
            ? "boundary_kind"
            : kind === "mode"
              ? "boundary_mode"
              : kind === "digest"
                ? "invocation_digest"
                : kind === "membership"
                  ? "fixture_membership"
                  : "fixture_format";
    expect(
      report.plans[0]?.checks.filter((c) => c.observation.status === "mismatch").map((c) => c.kind),
    ).toEqual([expected]);
  });

  it("preserves shared simulation targets and live declarations without resolving external authority", () => {
    const h = harness({
      target: (r) => {
        r.supportedBoundaryModes = ["live_provider", "recorded_stub", "simulation"];
      },
      plan: (p) => {
        const recorded = p.boundaries[0];
        if (!recorded) throw new Error("Expected boundary");
        recorded.boundaryId = "boundary_0";
        p.boundaries.push({
          boundaryId: "boundary_1",
          mode: "simulation",
          kind: "model",
          configurationSha256: "a".repeat(64),
          qualification: {
            artifactId: "qualification",
            sha256: "b".repeat(64),
            sizeBytes: 1,
            mediaType: "application/json",
            classification: "internal",
          },
          seedHex: "c".repeat(64),
          simulatorRelease: p.targetRelease,
        });
        p.boundaries.push({
          boundaryId: "boundary_2",
          mode: "live_provider",
          kind: "model",
          credential: { credentialId: "credential", credentialVersionId: "credential_v1" },
          destination: { scheme: "https", hostname: "provider.example", port: 443 },
          endpointProfile: {
            endpointProfileId: "endpoint",
            endpointProfileVersion: "1.0.0",
            definitionSha256: "d".repeat(64),
          },
          operation: "complete",
          requestLimits: { requestBytes: 100, responseBytes: 100 },
          sideEffect: { kind: "read_only" },
          usageSource: "unavailable",
        });
      },
    });
    const plan = h.execute().plans[0];
    expect(plan?.dependencies).toHaveLength(6);
    expect(plan?.checks).toHaveLength(11);
    expect(plan?.checks.every((c) => c.observation.status === "matched")).toBe(true);
    expect(
      plan?.dependencies.filter((d) => d.source.kind === "target_release").map((d) => d.path),
    ).toEqual(["/targetRelease", "/boundaries/1/simulatorRelease"]);
  });

  it.each(["missing", "record_invalid", "reference_mismatch", "not_yet_available"])(
    "retains unavailable children and original %s observations",
    (reason) => {
      const h = harness();
      const observation =
        reason === "missing" ? { status: "missing" } : { status: "unavailable", reason };
      for (const read of h.reads.slice(1)) Object.assign(read, { record: null, observation });
      const plan = h.execute().plans[0];
      expect(plan?.dependencies).toHaveLength(5);
      for (const d of plan?.dependencies ?? []) expect(d.recordObservation).toEqual(observation);
      expect(
        plan?.checks.filter((c) => c.observation.status === "matched").map((c) => c.kind),
      ).toEqual(["invocation_digest"]);
      expect(plan?.checks.filter((c) => c.observation.status === "unavailable")).toHaveLength(6);
    },
  );

  it("keeps a missing runtime configuration unknown even with a matching retained target family", () => {
    const h = harness();
    Object.assign(h.reads[4] as object, { record: null, observation: { status: "missing" } });
    expect(
      h
        .execute()
        .plans[0]?.checks.slice(0, 2)
        .map((c) => c.observation),
    ).toEqual([{ status: "matched" }, { status: "unavailable" }]);
  });

  it("distinguishes an unreadable plan from an empty successful check inventory", () => {
    const h = harness();
    Object.assign(h.reads[0] as object, { record: null, observation: { status: "missing" } });
    expect(h.execute()).toEqual({
      plans: [],
      unavailablePlans: [{ source: h.reads[0]?.source, observation: { status: "missing" } }],
    });
    expect(inspect(h.context, [], { maxReferences: 0, maxReferenceBytes: 0 })).toEqual({
      plans: [],
      unavailablePlans: [],
    });
  });

  it.each([
    "omitted",
    "wrong_reference",
    "duplicate",
    "extra",
    "hidden",
    "getter",
    "null",
    "hole",
    "missing_key",
    "other_kind",
    "malformed_observation",
    "unverified_body",
    "changed_receipt",
    "changed_digest",
    "changed_scope",
    "changed_hash",
  ])("rejects invalid captured input: %s", (kind) => {
    const h = harness();
    const read = h.reads[1] as PolicyReplayPlanBindingRead;
    const getter = vi.fn(() => h.target);
    if (kind === "omitted") h.reads.splice(1, 1);
    if (kind === "wrong_reference") {
      Object.assign(read, { record: null, observation: { status: "missing" } });
      read.source.reference.definitionSha256 = "f".repeat(64);
    }
    if (kind === "duplicate") h.reads.push(read);
    if (kind === "extra") Object.assign(read, { extra: true });
    if (kind === "hidden") Object.defineProperty(read, "record", { enumerable: false });
    if (kind === "getter") Object.defineProperty(read, "record", { enumerable: true, get: getter });
    if (kind === "null") h.reads[1] = null as never;
    if (kind === "hole") delete h.reads[1];
    if (kind === "missing_key") {
      Reflect.deleteProperty(read, "record");
      Object.assign(read, { other: true });
    }
    if (kind === "other_kind")
      Object.assign(read, {
        source: {
          kind: "runtime_adapter",
          reference: {
            adapterId: "adapter",
            adapterVersionId: "adapter_v1",
            definitionSha256: "a".repeat(64),
          },
        },
      });
    if (kind === "malformed_observation")
      Object.assign(read, { observation: { status: "approved" } });
    if (kind === "unverified_body") Object.assign(read, { observation: { status: "missing" } });
    if (kind === "changed_receipt")
      Object.assign(read.record as object, { createdByPrincipalId: "another_publisher" });
    if (kind === "changed_digest")
      Object.assign(read.record as object, { definitionSha256: "f".repeat(64) });
    if (kind === "changed_scope" && read.record) read.record.scope.projectId = "another_project";
    if (kind === "changed_hash")
      Object.assign(read, { observation: { status: "verified", recordSha256: "f".repeat(64) } });
    expect(h.execute).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["null_context", "extra_context", "scope", "time", "array", "limits"])(
    "rejects invalid context: %s",
    (kind) => {
      const h = harness();
      let context = h.context;
      let reads = h.reads;
      const budget = { ...limits };
      if (kind === "null_context") context = null as never;
      if (kind === "extra_context") Object.assign(context, { override: true });
      if (kind === "scope") context.scope.tenantId = "";
      if (kind === "time") context.evaluationTime = "later";
      if (kind === "array") reads = {} as never;
      if (kind === "limits") budget.maxReferences = -1;
      expect(() => inspect(context, reads, budget)).toThrowError(
        expect.objectContaining({ reason: "input_invalid" }),
      );
    },
  );

  it("bounds unique nodes, repeated dependencies and exact canonical reference bytes", () => {
    const h = harness({
      plan: (p) => {
        const first = p.boundaries[0];
        if (!first) throw new Error("Missing boundary");
        first.boundaryId = "boundary_0";
        p.boundaries.push(
          { ...structuredClone(first), boundaryId: "boundary_1" },
          { ...structuredClone(first), boundaryId: "boundary_2" },
        );
      },
    });
    const result = h.execute();
    const dependencies = result.plans.flatMap((p) => p.dependencies);
    const bytes = dependencies.reduce(
      (sum, { path, source }) =>
        sum + encodeEvaluationCanonicalJson({ kind: "record", path, source }).byteLength,
      0,
    );
    expect(dependencies).toHaveLength(7);
    expect(inspect(h.context, h.reads, { maxReferences: 7, maxReferenceBytes: bytes })).toEqual(
      result,
    );
    expect(() => inspect(h.context, h.reads, { ...limits, maxReferences: 5 })).toThrowError(
      expect.objectContaining({ reason: "reference_limit_exceeded" }),
    );
    expect(() => inspect(h.context, h.reads, { ...limits, maxReferences: 6 })).toThrowError(
      expect.objectContaining({ reason: "reference_limit_exceeded" }),
    );
    expect(() =>
      inspect(h.context, h.reads, { maxReferences: 7, maxReferenceBytes: bytes - 1 }),
    ).toThrowError(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
  });
});
