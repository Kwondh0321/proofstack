import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  PolicyEvaluationExecutionLimitsSchema,
  encodeEvaluationCanonicalJson,
  type ProtocolDefinition,
  type ProtocolDefinitionRecord,
  ProtocolDefinitionSchema,
  type ProtocolDefinitionSelector,
  ProtocolDefinitionSelectorSchema,
  PolicyEvaluationSourceReferenceSchema,
  type ReplayPlan,
  type TargetRelease,
  REPLAY_BUDGET_DIMENSIONS,
  type ReplayJobSnapshot,
  type RecordedInteractionFixtureVersionDefinition,
} from "@proofstack/contracts";
import {
  digestProtocolDefinition,
  inspectPolicyEvaluationRuntimeRecord,
  StaticProtocolDefinitionCatalogue,
} from "@proofstack/core";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  inspectPolicyEvaluationDataset,
} from "@proofstack/datasets";
import {
  inspectPolicyEvaluationReplayDefinition,
  inspectPolicyEvaluationReplayResult,
  type ReplayBudgetAmounts,
  type ReplayUsageMeasurements,
} from "@proofstack/replay";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import { describe, expect, it, vi } from "vitest";
import { AcquisitionBudget } from "./acquisition-budget.js";
import {
  inspectParentProtocolResolution as inspect,
  readParentProtocolResolution as read,
  type PolicyProtocolParentSource,
  type PolicyProtocolResolutionInput,
} from "./resolve-parent-protocol.js";
import type { PolicyRecordRead } from "./record-routing.js";

type Fields = Record<string, unknown>;
const time = "2026-10-01T00:00:00.000000Z";
const limits = { maxReferences: 10000, maxReferenceBytes: 4000000 };
const replayLimits = { maximumRecords: 10000, maximumRecordBytes: 4000000 };
const vectors = (relative: string) =>
  (
    JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as {
      vectors: { kind?: string; input: Fields; sha256: string }[];
    }
  ).vectors;
function source(kind: string, record: Fields): PolicyProtocolParentSource {
  const schema = PolicyEvaluationSourceReferenceSchema.options.find(
    (option) => option.shape.kind.value === kind,
  );
  if (!schema) throw new Error("Missing owning source schema");
  return schema.parse({
    kind,
    reference: Object.fromEntries(
      Object.keys(schema.shape.reference.shape).map((key) => [key, record[key]]),
    ),
  }) as PolicyProtocolParentSource;
}
function scenario(kind: string, record: Fields, path: string) {
  const input: PolicyProtocolResolutionInput = {
    source: source(kind, record),
    scope: record["scope"] as EvidenceScope,
    evaluationTime: time,
    path,
    limits,
    replayLimits,
  };
  const ownedInput = {
    source: input.source,
    scope: input.scope,
    evaluationTime: input.evaluationTime,
  };
  const evidence: PolicyRecordRead =
    kind === "runtime_adapter"
      ? inspectPolicyEvaluationRuntimeRecord(
          ownedInput as Parameters<typeof inspectPolicyEvaluationRuntimeRecord>[0],
          record,
        )
      : kind === "regression_fixture_version"
        ? inspectPolicyEvaluationDataset(
            ownedInput as Parameters<typeof inspectPolicyEvaluationDataset>[0],
            record,
          )
        : inspectPolicyEvaluationReplayDefinition(
            ownedInput as Parameters<typeof inspectPolicyEvaluationReplayDefinition>[0],
            record,
          );
  expect(evidence.observation.status).toBe("verified");
  return { input, evidence };
}
function runtimeScenario() {
  const v = vectors("../../contracts/vectors/runtime-definition-v1.json").find(
    (v) => (v.input["definition"] as Fields)["recordKind"] === "runtime_adapter",
  );
  if (!v) throw new Error("Missing runtime adapter vector");
  return scenario(
    "runtime_adapter",
    {
      ...(v.input["definition"] as Fields),
      scope: v.input["scope"],
      definitionSha256: v.sha256,
      schemaVersion: "0.1",
      registeredAt: "2026-09-08T00:00:00.000Z",
      registeredByPrincipalId: "operator_parent",
    },
    "/protocol",
  );
}
function fixtureScenario(path: string, extended = false) {
  const v = vectors("../../datasets/vectors/interaction-fixture-definition-v2.json")[0];
  if (!v) throw new Error("Missing fixture vector");
  const body = structuredClone(v.input) as unknown as RecordedInteractionFixtureVersionDefinition;
  if (extended) {
    const model = body.interactionCapture.interactions[0];
    if (model?.kind !== "model") throw new Error("Missing original model interaction");
    const attempt = model.attempts[0];
    if (!attempt) throw new Error("Missing original attempt");
    model.attempts.push({
      ...structuredClone(attempt),
      attemptId: "attempt_repeated",
      sequence: 1,
    });
    for (const [artifactId, role] of [
      ["tool_arguments", "tool.arguments"],
      ["tool_contract", "tool.contract"],
      ["tool_normalized", "tool.normalized_request"],
      ["tool_result", "tool.result"],
    ] as const)
      body.interactionCapture.artifacts.push({
        contentReference: {
          artifactId,
          classification: "confidential",
          mediaType: "application/json",
          sha256: "b".repeat(64),
          sizeBytes: 32,
        },
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
        role,
      });
    body.interactionCapture.interactions.push({
      kind: "tool",
      interactionId: "interaction_tool",
      callId: "call_tool",
      sequence: 1,
      terminalOutcome: "succeeded",
      tool: {
        toolId: "tool_one",
        toolVersion: "1",
        artifactId: "tool_contract",
        definitionSha256: "b".repeat(64),
      },
      attempts: [
        {
          attemptId: "attempt_tool",
          sequence: 0,
          outcome: "succeeded",
          startedAt: attempt.endedAt,
          endedAt: attempt.endedAt,
          sideEffect: "read_only",
          effectMayHaveOccurred: false,
          normalizedRequest: {
            adapterName: "tool.json",
            adapterVersion: "1",
            artifactId: "tool_normalized",
            sha256: "b".repeat(64),
          },
          artifacts: { argumentsArtifactId: "tool_arguments", resultArtifactId: "tool_result" },
        },
      ],
    });
    body.interactionCapture.artifacts.sort((a, b) =>
      a.contentReference.artifactId < b.contentReference.artifactId ? -1 : 1,
    );
  }
  return scenario(
    "regression_fixture_version",
    {
      ...body,
      definitionSha256: digestRecordedInteractionFixtureVersionDefinition(body),
      createdAt: "2026-09-08T00:00:00.000Z",
      createdByPrincipalId: "operator_parent",
      source: { ...(v.input["source"] as Fields), capturedAt: "2026-09-08T00:00:00.000Z" },
    },
    path,
  );
}
function replayScenario(kind: string, path: string) {
  const v = vectors("../../replay/vectors/replay-definition-v1.json").find((v) => v.kind === kind);
  if (!v) throw new Error("Missing replay definition vector");
  return scenario(
    kind,
    {
      ...structuredClone(v.input),
      definitionSha256: v.sha256,
      createdAt: "2026-09-08T00:00:00.000Z",
      createdByPrincipalId: "operator_parent",
    },
    path,
  );
}
function definition(
  selector: ProtocolDefinitionSelector,
  scope: EvidenceScope,
  id = "protocol_parent",
): ProtocolDefinitionRecord {
  const v = vectors("../../contracts/vectors/protocol-definition-v1.json").find(
    (v) => (v.input["definition"] as Fields)["family"] === selector.family,
  );
  if (!v) throw new Error("Missing protocol family vector");
  const body: ProtocolDefinition = ProtocolDefinitionSchema.parse({
    ...(v.input["definition"] as Fields),
    ...selector,
    protocolDefinitionId: id,
  });
  return {
    ...body,
    scope: structuredClone(scope),
    definitionSha256: digestProtocolDefinition(scope, body),
    schemaVersion: "0.1",
    registeredAt: "2026-09-08T00:00:00.001Z",
    registeredByPrincipalId: "operator_protocol",
  };
}
const cases = [
  {
    family: "capture_adapter",
    get: () => fixtureScenario("/interactionCapture/source/captureAdapter"),
  },
  {
    family: "source_format",
    get: () => fixtureScenario("/interactionCapture/source/sourceFormat"),
  },
  {
    family: "request_normalizer",
    get: () => fixtureScenario("/interactionCapture/interactions/0/attempts/0/normalizedRequest"),
  },
  {
    family: "recorded_target_adapter",
    get: () => replayScenario("replay_plan", "/boundaries/0/invocation/targetAdapter"),
  },
  {
    family: "released_target_adapter",
    get: () => replayScenario("target_release", "/targetAdapter"),
  },
  { family: "worker_protocol", get: () => replayScenario("replay_plan", "/workerProtocol") },
  { family: "worker_protocol", get: () => replayScenario("target_release", "/workerProtocol") },
  { family: "runtime_protocol", get: runtimeScenario },
];

describe("whole-parent retained protocol resolution", () => {
  it.each(cases)(
    "derives $family only from its original owned occurrence",
    async ({ family, get }) => {
      const s = get();
      const missing = inspect(s.input, s.evidence, []);
      expect(missing.status).toBe("missing");
      expect(missing.selector.family).toBe(family);
      const record = definition(missing.selector, s.input.scope);
      const catalogue = new StaticProtocolDefinitionCatalogue([record]);
      const list = vi.fn(catalogue.listProtocolDefinitions.bind(catalogue));
      const result = await read(s.input, s.evidence, { listProtocolDefinitions: list });
      expect(list).toHaveBeenCalledExactlyOnceWith(s.input.scope, missing.selector);
      expect(result).toEqual(inspect(s.input, s.evidence, [record]));
      expect(result.status).toBe("unique");
      expect(result.matches).toHaveLength(1);
      expect(result.parent.source).toEqual(s.input.source);
      expect(result.parent.recordSha256).toBe(
        s.evidence.observation.status === "verified"
          ? s.evidence.observation.recordSha256
          : "not verified",
      );
      const member = result.matches[0];
      if (member?.status !== "retained") throw new Error("Missing retained protocol");
      expect(member.record).toEqual(record);
      expect(member.descriptorMatched).toBe(true);
      expect(member.read.observation.status).toBe("verified");
      expect(member.recordSha256).toBe(
        createHash("sha256").update(encodeEvaluationCanonicalJson(record)).digest("hex"),
      );
      expect(result.inspectionUsage.references).toBeGreaterThan(0);
      expect(result.inspectionUsage.referenceBytes).toBeGreaterThan(0);
    },
  );

  it("retains distinct model/tool normalizer occurrences and repeated attempts", async () => {
    const paths = [
      "/interactionCapture/interactions/0/attempts/0/normalizedRequest",
      "/interactionCapture/interactions/0/attempts/1/normalizedRequest",
      "/interactionCapture/interactions/1/attempts/0/normalizedRequest",
    ];
    const results = [];
    for (const path of paths) {
      const s = fixtureScenario(path, true);
      const selector = inspect(s.input, s.evidence, []).selector;
      expect(selector.family).toBe("request_normalizer");
      const record = definition(selector, s.input.scope);
      const result = await read(
        s.input,
        s.evidence,
        new StaticProtocolDefinitionCatalogue([record]),
      );
      expect(result.status).toBe("unique");
      expect(result.reference.path).toBe(path);
      results.push(result);
    }
    expect(results[0]?.selector).toEqual(results[1]?.selector);
    expect(results[2]?.selector.descriptor).toEqual({ name: "tool.json", version: "1" });
    expect(results[0]?.parent).toEqual(results[2]?.parent);
    expect(results[0]?.inspectionUsage).toEqual(results[2]?.inspectionUsage);
  });

  it("retains ambiguous original and future bodies/receipts without discarding a member", () => {
    const s = runtimeScenario();
    const selector = inspect(s.input, s.evidence, []).selector;
    const original = definition(selector, s.input.scope, "protocol_first");
    const future = {
      ...definition(selector, s.input.scope, "protocol_second"),
      registeredAt: "2099-01-01T00:00:00.000Z",
    };
    const result = inspect(s.input, s.evidence, [original, future]);
    expect(result.status).toBe("multiple");
    expect(result.matches).toHaveLength(2);
    const member = result.matches[1];
    if (member?.status !== "retained") throw new Error("Missing future member");
    expect(member.record).toEqual(future);
    expect(member.read.observation).toEqual({ status: "unavailable", reason: "not_yet_available" });
    const changed = inspect(s.input, s.evidence, [
      original,
      { ...future, registeredByPrincipalId: "operator_other" },
    ]);
    const changedMember = changed.matches[1];
    if (changedMember?.status !== "retained") throw new Error("Missing changed member");
    expect(changedMember.recordSha256).not.toBe(member.recordSha256);
    expect(inspect(s.input, s.evidence, [future])).toMatchObject({
      status: "unavailable",
      reason: "not_yet_available",
    });
  });

  it("preserves invalid members and sparse entries instead of selecting a valid sibling", () => {
    const s = runtimeScenario();
    const record = definition(inspect(s.input, s.evidence, []).selector, s.input.scope);
    for (const bad of [
      null,
      undefined,
      {},
      { ...record, definitionSha256: "0".repeat(64) },
      { ...record, approved: true },
    ]) {
      const result = inspect(s.input, s.evidence, [record, bad]);
      expect(result).toMatchObject({ status: "unavailable", reason: "record_invalid" });
      expect(result.matches).toHaveLength(2);
      expect(result.matches[1]).toEqual({ index: 1, status: "invalid", reason: "record_invalid" });
    }
    expect(inspect(s.input, s.evidence, Array(1))).toMatchObject({
      status: "unavailable",
      reason: "record_invalid",
    });
    for (const bad of [null, {}, false, Array(257)])
      expect(() => inspect(s.input, s.evidence, bad)).toThrow();
  });

  it("rejects duplicate storage identities even for identical bodies or receipt-only changes", () => {
    const s = runtimeScenario();
    const record = definition(inspect(s.input, s.evidence, []).selector, s.input.scope);
    for (const duplicate of [record, { ...record, registeredByPrincipalId: "operator_other" }])
      expect(() => inspect(s.input, s.evidence, [record, duplicate])).toThrow("Duplicate");
  });

  it("keeps substituted scope/family/version/protocol-version matches explicitly unavailable", () => {
    for (const s of [runtimeScenario(), replayScenario("target_release", "/targetAdapter")]) {
      const selector = inspect(s.input, s.evidence, []).selector;
      for (const field of ["tenantId", "projectId", "environmentId"] as const) {
        const record = definition(selector, { ...s.input.scope, [field]: "scope_other" });
        expect(inspect(s.input, s.evidence, [record])).toMatchObject({
          status: "unavailable",
          reason: "reference_mismatch",
        });
      }
      const altered = ProtocolDefinitionSelectorSchema.parse({
        ...selector,
        descriptor: { ...selector.descriptor, version: "VersionOther" },
      });
      const substitutes = [
        definition(altered, s.input.scope),
        definition(
          { family: "worker_protocol", descriptor: { name: "other.family", version: "1.0.0" } },
          s.input.scope,
        ),
      ];
      if (selector.family === "released_target_adapter")
        substitutes.push(
          definition(
            { ...selector, descriptor: { ...selector.descriptor, protocolVersion: "OTHER" } },
            s.input.scope,
          ),
        );
      for (const record of substitutes)
        expect(inspect(s.input, s.evidence, [record])).toMatchObject({
          status: "unavailable",
          reason: "reference_mismatch",
        });
    }
  });

  it("keeps full cut precision and independent original receipt hashes", () => {
    const s = runtimeScenario();
    const record = definition(inspect(s.input, s.evidence, []).selector, s.input.scope);
    expect(
      inspect({ ...s.input, evaluationTime: "2026-09-08T00:00:00.000999Z" }, s.evidence, [record]),
    ).toMatchObject({ status: "unavailable", reason: "not_yet_available" });
    const input = { ...s.input, evaluationTime: "2026-09-08T00:00:00.001000Z" };
    const first = inspect(input, s.evidence, [record]);
    expect(first.status).toBe("unique");
    const changed = inspect(input, s.evidence, [
      { ...record, registeredByPrincipalId: "operator_other" },
    ]);
    expect(changed.status).toBe("unique");
    expect(changed.matches).not.toEqual(first.matches);
  });

  it("rejects malformed context, nonprotocol paths and forged whole parents before lookup", async () => {
    const s = runtimeScenario();
    const list = vi.fn(async () => []);
    for (const bad of [
      null,
      { ...s.input, approved: true },
      { ...s.input, evaluationTime: "invalid" },
      { ...s.input, path: "/configuration" },
      { ...s.input, path: "protocol" },
      { ...s.input, path: "/" + "x".repeat(1024) },
      {
        ...s.input,
        source: {
          kind: "protocol_definition",
          reference: { protocolDefinitionId: "protocol_other", definitionSha256: "a".repeat(64) },
        },
      },
      { ...s.input, scope: { ...s.input.scope, tenantId: "" } },
      { ...s.input, replayLimits: { ...replayLimits, extra: true } },
      { ...s.input, replayLimits: { ...replayLimits, maximumRecords: 1 } },
      { ...s.input, replayLimits: { ...replayLimits, maximumRecordBytes: 0 } },
    ])
      await expect(
        read(bad as typeof s.input, s.evidence, { listProtocolDefinitions: list }),
      ).rejects.toThrow();
    for (const change of [
      (parent: PolicyRecordRead) => Reflect.set(parent.observation, "recordSha256", "0".repeat(64)),
      (parent: PolicyRecordRead) => Reflect.set(parent, "approved", true),
      (parent: PolicyRecordRead) => {
        if (parent.record) Reflect.set(parent.record, "registeredByPrincipalId", "operator_other");
      },
    ]) {
      const parent = structuredClone(s.evidence);
      change(parent);
      await expect(read(s.input, parent, { listProtocolDefinitions: list })).rejects.toThrow();
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("charges whole-parent reference limits before I/O and all returned members before selection", async () => {
    const s = runtimeScenario();
    const prepared = inspect(s.input, s.evidence, []);
    const list = vi.fn(async () => []);
    for (const bounded of [
      {
        maxReferences: prepared.inspectionUsage.references - 1,
        maxReferenceBytes: limits.maxReferenceBytes,
      },
      {
        maxReferences: limits.maxReferences,
        maxReferenceBytes: prepared.inspectionUsage.referenceBytes - 1,
      },
    ])
      await expect(
        read({ ...s.input, limits: bounded }, s.evidence, { listProtocolDefinitions: list }),
      ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    const record = definition(prepared.selector, s.input.scope);
    const future = {
      ...definition(prepared.selector, s.input.scope, "protocol_future"),
      registeredAt: "2099-01-01T00:00:00.000Z",
    };
    const execution = PolicyEvaluationExecutionLimitsSchema.parse({
      heartbeatIntervalMilliseconds: 1000,
      leaseDurationMilliseconds: 3000,
      maxAcquisitionRecordBytes: 4000000,
      maxAcquisitionRecords: 2,
      maxArtifactReadBytes: 0,
      maxAttempts: 1,
      maxRuleEvaluations: 1,
      perAttemptTimeoutMilliseconds: 10000,
      retryBackoffMilliseconds: 0,
      retryableErrors: [],
      totalDeadlineMilliseconds: 10000,
    });
    const budget = new AcquisitionBudget(execution);
    await expect(
      read(
        s.input,
        s.evidence,
        budget.wrap({ listProtocolDefinitions: async () => [record, future] }),
      ),
    ).rejects.toMatchObject({ reason: "record_limit" });
  });

  it("owns prepared context before lookup mutations and propagates rejected storage calls", async () => {
    const s = runtimeScenario();
    const original = structuredClone(s.input);
    const selector = inspect(s.input, s.evidence, []).selector;
    const record = definition(selector, original.scope);
    const result = await read(s.input, s.evidence, {
      listProtocolDefinitions: async (scope, query) => {
        scope.tenantId = "scope_mutated";
        query.descriptor.version = "mutated";
        Reflect.set(s.input, "path", "/configuration");
        return [record];
      },
    });
    expect(result).toEqual(inspect(original, s.evidence, [record]));
    for (const cause of [new Error("storage offline")])
      await expect(
        read(original, s.evidence, {
          listProtocolDefinitions: async () => {
            throw cause;
          },
        }),
      ).rejects.toBe(cause);
    const detached = result.matches[0];
    if (detached?.status !== "retained") throw new Error("Missing detached result");
    detached.record.specification.sha256 = "f".repeat(64);
    expect(record.specification.sha256).not.toBe("f".repeat(64));
  });

  it("resolves the original worker declaration inside an actual completed replay attempt", async () => {
    const defs = new MemoryReplayDefinitionRepository();
    const rows = vectors("../../replay/vectors/replay-definition-v1.json").map((v) => ({
      ...v.input,
      definitionSha256: v.sha256,
      createdAt: "2026-09-08T00:00:00.000Z",
      createdByPrincipalId: "operator_parent",
    }));
    const plan = rows.find((row) => "planVersionId" in row) as unknown as ReplayPlan;
    const target = rows.find((row) => "targetReleaseId" in row) as unknown as TargetRelease;
    await defs.publishTargetRelease(target);
    await defs.publishReplayPlan(plan);
    let now = "2026-09-08T00:00:00.000Z";
    const jobs = new MemoryReplayJobRepository({ definitions: defs, now: () => now });
    const { snapshot } = await jobs.createJob({
      createdByPrincipalId: "operator_parent",
      jobId: "job_protocol",
      scope: plan.scope,
      plan: source("replay_plan", plan as unknown as Fields)
        .reference as ReplayJobSnapshot["job"]["plan"],
    });
    now = "2026-09-08T00:00:00.100Z";
    const claimed = await jobs.claimJob({
      attemptId: "attempt_protocol",
      jobId: snapshot.job.jobId,
      leaseDurationMilliseconds: 2000,
      leaseId: "lease_protocol",
      scope: plan.scope,
      workerBuildSha256: "a".repeat(64),
      workerId: "worker_protocol",
      workerProtocol: plan.workerProtocol,
    });
    if (!claimed.claimed) throw new Error("Could not claim replay fixture");
    const workerFence = claimed.workerFence;
    await jobs.reserveBudget({
      reservationId: "reservation_protocol",
      scope: plan.scope,
      workerFence,
      work: { kind: "attempt_start" },
      requested: Object.fromEntries(
        REPLAY_BUDGET_DIMENSIONS.map((d) => [d, d === "jobAttempts" ? 1 : 0]),
      ) as ReplayBudgetAmounts,
    });
    await jobs.reconcileBudget({
      reservationId: "reservation_protocol",
      reconciliationId: "reconciliation_protocol",
      scope: plan.scope,
      workerFence,
      usage: Object.fromEntries(
        REPLAY_BUDGET_DIMENSIONS.map((d) => [
          d,
          { status: "observed", amount: d === "jobAttempts" ? 1 : 0, source: "measured" },
        ]),
      ) as ReplayUsageMeasurements,
    });
    now = "2026-09-08T00:00:00.200Z";
    const completed = await jobs.completeJob({
      scope: plan.scope,
      workerFence,
      code: "completed",
      status: "succeeded",
      result: {
        artifactId: "artifact_protocol",
        classification: "internal",
        mediaType: "application/json",
        sizeBytes: 128,
        sha256: "f".repeat(64),
      },
    });
    const attempt = completed.attempts[0];
    if (!attempt) throw new Error("Missing completed attempt");
    const parentSource = PolicyEvaluationSourceReferenceSchema.parse({
      kind: "replay_result",
      reference: {
        attemptId: attempt.attemptId,
        completedAt: attempt.endedAt,
        jobId: snapshot.job.jobId,
        plan: snapshot.job.plan,
        result: attempt.result,
        targetRelease: attempt.targetRelease,
        terminalCode: "completed",
        terminalStatus: "succeeded",
      },
    }) as PolicyProtocolParentSource;
    const input: PolicyProtocolResolutionInput = {
      source: parentSource,
      scope: plan.scope,
      evaluationTime: time,
      path: "/attempts/0/workerProtocol",
      limits,
      replayLimits,
    };
    const evidence = inspectPolicyEvaluationReplayResult(
      {
        scope: input.scope,
        evaluationTime: input.evaluationTime,
        source: parentSource as Parameters<typeof inspectPolicyEvaluationReplayResult>[0]["source"],
        limits: replayLimits,
      },
      completed,
    );
    const selector = inspect(input, evidence, []).selector;
    expect(selector.family).toBe("worker_protocol");
    const record = definition(selector, plan.scope);
    expect(inspect(input, evidence, [record]).status).toBe("unique");
  });
});
