import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  REPLAY_BUDGET_DIMENSIONS,
  ReplayBoundaryDeclarationSchema,
  type ReplayJobSnapshot,
  ReplayJobSnapshotSchema,
  type ReplayPlan,
  type ReplayPlanDefinition,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import { PolicyEvaluationReferenceCollector } from "@proofstack/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  inspectPolicyEvaluationReplayDefinition,
  type PolicyEvaluationReplayDefinitionSource,
  readPolicyEvaluationReplayDefinition,
} from "./policy-evaluation-replay-definition-reader.js";
import {
  enumeratePolicyEvaluationReplayDefinitionReferences,
  enumeratePolicyEvaluationReplayResultReferences,
} from "./policy-evaluation-replay-references.js";
import {
  inspectPolicyEvaluationReplayResult,
  type PolicyEvaluationReplayResultReadInput,
} from "./policy-evaluation-replay-result-reader.js";
import type { ReplayBudgetAmounts, ReplayUsageMeasurements } from "./replay-budget.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "./replay-definition-digest.js";
import { MemoryReplayDefinitionRepository } from "./testing/memory-replay-definition-repository.js";
import { MemoryReplayJobRepository } from "./testing/memory-replay-job-repository.js";

const sha = (digit: string) => digit.repeat(64);
const time = (milliseconds: number) =>
  `2026-09-08T00:00:00.${String(milliseconds).padStart(3, "0")}Z`;
const limits = { maxReferences: 10000, maxReferenceBytes: 4 * 1024 * 1024 };
const { vectors } = JSON.parse(
  readFileSync(new URL("../vectors/replay-definition-v1.json", import.meta.url), "utf8"),
) as {
  vectors: {
    kind: string;
    input: ReplayPlanDefinition | TargetReleaseDefinition;
    sha256: string;
  }[];
};
function definition<T extends ReplayPlanDefinition | TargetReleaseDefinition>(body: T) {
  return {
    ...structuredClone(body),
    createdAt: time(0),
    createdByPrincipalId: "usr_references",
    definitionSha256:
      "planVersionId" in body
        ? digestReplayPlanDefinition(body)
        : digestTargetReleaseDefinition(body),
  };
}
const target = () => definition(vectors[0]?.input as TargetReleaseDefinition);
const plan = () => definition(vectors[1]?.input as ReplayPlanDefinition);
function targetReference(value: TargetRelease) {
  return {
    definitionSha256: value.definitionSha256,
    targetId: value.targetId,
    targetReleaseId: value.targetReleaseId,
    targetAdapter: value.targetAdapter,
    workerProtocol: value.workerProtocol,
  };
}
function context(value: ReplayPlan | TargetRelease) {
  const source: PolicyEvaluationReplayDefinitionSource =
    "planVersionId" in value
      ? {
          kind: "replay_plan",
          reference: {
            definitionSha256: value.definitionSha256,
            planId: value.planId,
            planVersionId: value.planVersionId,
          },
        }
      : { kind: "target_release", reference: targetReference(value) };
  return { evaluationTime: time(900), scope: structuredClone(value.scope), source };
}
function artifact(id: string): TargetRelease["build"]["provenance"] {
  return {
    artifactId: id,
    classification: "internal",
    mediaType: "application/json",
    sha256: sha("f"),
    sizeBytes: 128,
  };
}
function richTarget() {
  return definition({
    ...(vectors[0]?.input as TargetReleaseDefinition),
    execution: { kind: "artifact", artifact: artifact("art_executable"), bundleFormat: "zip" },
    subprocessPolicy: {
      mode: "allowlisted",
      allowedImplementations: Array.from({ length: 12 }, (_, index) => ({
        executableSha256: sha("a"),
        implementationId: `impl_${String(index).padStart(2, "0")}`,
      })),
    },
    supportedBoundaryKinds: ["data", "model", "retrieval", "tool"],
    supportedBoundaryModes: ["live_provider", "recorded_stub", "simulation"],
  } satisfies TargetReleaseDefinition);
}
function richPlan() {
  const body = structuredClone(vectors[1]?.input as ReplayPlanDefinition);
  const recorded = body.boundaries[0];
  if (!recorded) throw new Error("Missing retained boundary");
  body.targetRelease = targetReference(richTarget());
  body.boundaries = [
    ...(["read_only", "idempotent_write", "non_idempotent_write"] as const).map((kind, index) => ({
      boundaryId: `live_${index}`,
      mode: "live_provider" as const,
      kind: "tool" as const,
      credential: { credentialId: "credential_one", credentialVersionId: "credential_version_one" },
      destination: { hostname: "provider.example", port: 443 as const, scheme: "https" as const },
      endpointProfile: {
        definitionSha256: sha("e"),
        endpointProfileId: "endpoint_one",
        endpointProfileVersion: "1.0.0",
      },
      operation: "lookup",
      requestLimits: { requestBytes: 1024, responseBytes: 1024 },
      usageSource: "measured" as const,
      sideEffect:
        kind === "read_only"
          ? { kind }
          : kind === "idempotent_write"
            ? {
                kind,
                idempotencyKeyScheme: "request_identity",
                sandboxDestination: true as const,
              }
            : { kind, automaticRetry: false as const, riskAcceptance: artifact("art_risk") },
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(recorded),
      boundaryId: `recorded_${String(index).padStart(2, "0")}`,
    })),
    {
      boundaryId: "simulation_one",
      mode: "simulation",
      kind: "tool",
      configurationSha256: sha("d"),
      qualification: artifact("art_qualification"),
      seedHex: sha("b"),
      simulatorRelease: structuredClone(body.targetRelease),
    },
  ];
  return definition(body);
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sorted(child)]),
    );
  return value;
}
const json = (value: unknown) => JSON.stringify(sorted(value));
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Independent structural oracle: identify reference shapes and declaration leaves, not the
// production mode switches or collector methods. Arrays retain numeric order, including 10+.
function inventory(raw: unknown) {
  const references: unknown[] = [];
  const walk = (value: unknown, path: string, key: string): void => {
    const declaration = (kind: string) =>
      references.push({
        kind: "replay_declaration",
        path,
        declaration: { kind, reference: value },
      });
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        walk(child, `${path}/${index}`, String(index));
      });
      return;
    }
    if (value === null || typeof value !== "object") {
      if (key === "artifactId") declaration("artifact_identity");
      else if (key.endsWith("Sha256") && key !== "definitionSha256") declaration("digest");
      return;
    }
    const fields = value as Record<string, unknown>;
    const has = (name: string) => Object.hasOwn(fields, name);
    if (path && has("artifactId") && has("sizeBytes")) {
      references.push({ kind: "artifact", path, reference: value });
      return;
    }
    const sourceKind = has("fixtureVersionId")
      ? "regression_fixture_version"
      : has("datasetVersionId")
        ? "dataset_version"
        : has("targetReleaseId")
          ? "target_release"
          : has("planVersionId")
            ? "replay_plan"
            : has("id") && has("family")
              ? "replay_runtime_profile"
              : has("id") && has("kind")
                ? "replay_isolation_profile"
                : undefined;
    if (path && sourceKind) {
      references.push({ kind: "record", path, source: { kind: sourceKind, reference: value } });
      return;
    }
    if (has("credentialVersionId")) {
      declaration("credential_selector");
      return;
    }
    if (has("endpointProfileId")) {
      declaration("endpoint_profile");
      return;
    }
    if (key === "targetAdapter") {
      declaration(has("protocolVersion") ? "target_adapter" : "recorded_adapter");
      return;
    }
    if (key === "workerProtocol") {
      declaration("worker_protocol");
      return;
    }
    if (has("implementationId")) {
      declaration(has("kind") ? "preinstalled_target" : "subprocess_implementation");
      return;
    }
    for (const [name, child] of Object.entries(fields).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ))
      walk(child, `${path}/${name}`, name);
  };
  walk(raw, "", "");
  return references;
}

function definitionCase(value: ReplayPlan | TargetRelease) {
  const input = context(value);
  const observed = inspectPolicyEvaluationReplayDefinition(input, value);
  expect(observed.observation.status).toBe("verified");
  return { input, observed };
}

function rehash(value: ReplayPlan | TargetRelease) {
  const { createdAt: _at, createdByPrincipalId: _by, definitionSha256: _sha, ...body } = value;
  return definition(body);
}

async function capturedJob() {
  const definitions = new MemoryReplayDefinitionRepository();
  await definitions.publishTargetRelease(target());
  const selected = plan();
  await definitions.publishReplayPlan(selected);
  let now = time(0);
  const repository = new MemoryReplayJobRepository({ definitions, now: () => now });
  const scope = selected.scope;
  const ref = {
    definitionSha256: selected.definitionSha256,
    planId: selected.planId,
    planVersionId: selected.planVersionId,
  };
  await repository.createJob({
    createdByPrincipalId: "usr_references",
    jobId: "job_references",
    scope,
    plan: ref,
  });
  now = time(100);
  const claimed = await repository.claimJob({
    attemptId: "att_latest",
    jobId: "job_references",
    scope,
    leaseDurationMilliseconds: 2000,
    leaseId: "lease_latest",
    workerId: "worker_one",
    workerBuildSha256: sha("a"),
    workerProtocol: selected.workerProtocol,
  });
  if (!claimed.claimed) throw new Error("Expected a claimed job");
  const workerFence = claimed.workerFence;
  now = time(200);
  const requested = Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((key) => [key, key === "elapsedMilliseconds" ? 1 : 0]),
  ) as ReplayBudgetAmounts;
  const usage = Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((key) => [
      key,
      { status: "observed", amount: 0, source: "measured" },
    ]),
  ) as ReplayUsageMeasurements;
  for (const [index, work] of (
    [
      { kind: "attempt_start" },
      { kind: "boundary_call", boundaryId: "bnd_vector_model", boundaryKind: "model" },
      { kind: "artifact_emission", artifactId: "art_not_a_result" },
    ] as const
  ).entries()) {
    await repository.reserveBudget({
      reservationId: `reservation_${index}`,
      scope,
      workerFence,
      work,
      requested,
    });
    await repository.reconcileBudget({
      reservationId: `reservation_${index}`,
      reconciliationId: `reconciliation_${index}`,
      scope,
      workerFence,
      usage,
    });
  }
  await repository.appendExecutionObservation({
    observationId: "obs_execution",
    scope,
    workerFence,
    payload: {
      kind: "target",
      event: "started",
      afterCancellationRequest: false,
      evidenceSha256: sha("b"),
    },
  });
  await repository.appendUsageObservation({
    observationId: "obs_usage",
    scope,
    workerFence,
    sourceEventSha256: sha("c"),
    measurements: [
      {
        dimension: "elapsedMilliseconds",
        usage: { status: "observed", amount: 100, source: "measured" },
      },
    ],
  });
  now = time(500);
  return ReplayJobSnapshotSchema.parse(
    wire(
      await repository.completeJob({
        code: "completed",
        status: "succeeded",
        scope,
        workerFence,
        result: artifact("art_result"),
      }),
    ),
  );
}
let job: ReplayJobSnapshot;
beforeAll(async () => {
  job = await capturedJob();
});
function history() {
  const value = structuredClone(job);
  const latest = value.attempts[0];
  if (!latest) throw new Error("Expected a latest attempt");
  const prior = Array.from({ length: 12 }, (_, index) => {
    const attempt = structuredClone(latest);
    attempt.attemptId = `att_prior_${index}`;
    attempt.attemptSequence = index;
    attempt.startedAt = time(index + 1);
    attempt.endedAt = time(index === 11 ? 100 : index + 2);
    attempt.status = "lease_expired";
    delete attempt.result;
    attempt.retryDisposition = "retry_scheduled";
    attempt.error = {
      code: "lease_expired",
      effectCertainty: "none",
      message: "이전 실패 — retained failure",
      detailsSha256: sha("d"),
    };
    if (index === 1 || index === 2) {
      attempt.error.effectCertainty = "may_have_occurred";
      attempt.error.effectRetrySafety =
        index === 1
          ? { kind: "read_only", evidenceSha256: sha("e") }
          : {
              kind: "destination_idempotency_verified",
              evidenceSha256: sha("e"),
              idempotencyKeySha256: sha("f"),
            };
    }
    if (index === 3) {
      attempt.error.effectCertainty = "may_have_occurred";
      attempt.error.effectRetrySafety = { kind: "not_retryable" };
      attempt.retryDisposition = "not_retryable";
    }
    attempt.mutationFence = {
      ...attempt.mutationFence,
      attemptId: attempt.attemptId,
      fencingToken: index + 1,
      leaseId: `lease_prior_${index}`,
    };
    return attempt;
  });
  latest.attemptSequence = prior.length;
  latest.mutationFence.fencingToken = prior.length + 1;
  for (const row of [
    ...value.budgetLedger,
    ...value.executionObservations,
    ...value.usageObservations,
  ])
    row.mutationFence.fencingToken = prior.length + 1;
  value.attempts = [...prior, latest];
  value.job.latestAttemptSequence = prior.length;
  value.job.lastFencingToken = prior.length + 1;
  value.job.startedAt = time(1);
  expect(ReplayJobSnapshotSchema.safeParse(value).success).toBe(true);
  return value;
}
function resultCase(value: ReplayJobSnapshot) {
  const latest = value.attempts.at(-1);
  if (!latest?.result || !latest.endedAt) throw new Error("Expected successful result");
  const input: PolicyEvaluationReplayResultReadInput = {
    evaluationTime: time(900),
    limits: { maximumRecords: 1000, maximumRecordBytes: 4 * 1024 * 1024 },
    scope: structuredClone(value.job.scope),
    source: {
      kind: "replay_result",
      reference: {
        attemptId: latest.attemptId,
        completedAt: latest.endedAt,
        jobId: value.job.jobId,
        plan: value.job.plan,
        result: latest.result,
        targetRelease: latest.targetRelease,
        terminalCode: "completed",
        terminalStatus: "succeeded",
      },
    },
  };
  const observed = inspectPolicyEvaluationReplayResult(input, value);
  expect(observed.observation.status).toBe("verified");
  return { input, observed };
}

describe("bounded direct replay dependency inventories", () => {
  it("requires explicit inventory review when execution or boundary modes change", () => {
    expect(
      ReplayBoundaryDeclarationSchema.options.map((schema) => schema.shape.mode.value),
    ).toEqual(["live_provider", "recorded_stub", "simulation"]);
    expect(
      TargetReleaseSchema.shape.execution.options.map((schema) => schema.shape.kind.value),
    ).toEqual(["artifact", "preinstalled"]);
    expect(
      TargetReleaseSchema.shape.subprocessPolicy.options.map((schema) => schema.shape.mode.value),
    ).toEqual(["denied", "allowlisted"]);
  });
  it("matches retained definition vector digests before extending their dependency inventory", () => {
    for (const vector of vectors)
      expect(definition(vector.input).definitionSha256).toBe(vector.sha256);
  });
  it("rejects conflicting target, endpoint, credential, and artifact references inside valid parents", () => {
    for (const field of ["target", "endpoint", "credential"] as const) {
      const value = richPlan();
      if (field === "target") {
        const simulation = value.boundaries.find((boundary) => boundary.mode === "simulation");
        if (simulation?.mode !== "simulation") throw new Error("Expected simulation");
        simulation.simulatorRelease.definitionSha256 = sha("0");
      } else {
        const live = value.boundaries.find((boundary) => boundary.mode === "live_provider");
        if (live?.mode !== "live_provider") throw new Error("Expected live boundary");
        if (field === "endpoint") live.endpointProfile.definitionSha256 = sha("0");
        else live.credential.credentialId = "credential_substitution";
      }
      const { input, observed } = definitionCase(rehash(value));
      expect(() =>
        enumeratePolicyEvaluationReplayDefinitionReferences(input, observed, limits),
      ).toThrow(expect.objectContaining({ reason: "reference_conflict" }));
    }
    const release = richTarget();
    if (release.execution.kind !== "artifact") throw new Error("Expected artifact execution");
    release.execution.artifact = {
      ...release.build.provenance,
      sizeBytes: release.build.provenance.sizeBytes + 1,
    };
    const { input, observed } = definitionCase(rehash(release));
    expect(() =>
      enumeratePolicyEvaluationReplayDefinitionReferences(input, observed, limits),
    ).toThrow(expect.objectContaining({ reason: "reference_conflict" }));
  });
  for (const [name, make] of Object.entries({ target, plan, richTarget, richPlan })) {
    it(`preserves the independent structural inventory for ${name}`, async () => {
      const value = make();
      const { input, observed } = definitionCase(value);
      const expected = inventory(value);
      expect(enumeratePolicyEvaluationReplayDefinitionReferences(input, observed, limits)).toEqual({
        source: input.source,
        recordSha256: hash(value),
        references: expected,
        referenceBytes: expected.reduce<number>(
          (total, entry) => total + Buffer.byteLength(json(entry)),
          0,
        ),
      });
      const repository = new MemoryReplayDefinitionRepository();
      if ("planVersionId" in value) {
        await repository.publishTargetRelease(name === "richPlan" ? richTarget() : target());
        await repository.publishReplayPlan(value);
      } else await repository.publishTargetRelease(value);
      expect(await readPolicyEvaluationReplayDefinition(input, repository)).toEqual(observed);
    });
  }
  it("retains all failed attempts, duplicate aliases, budget artifact identities, and evidence digests", () => {
    for (const value of [job, history()]) {
      const { input, observed } = resultCase(value);
      const expected = inventory(value);
      expect(enumeratePolicyEvaluationReplayResultReferences(input, observed, limits)).toEqual({
        source: input.source,
        recordSha256: hash(value),
        references: expected,
        referenceBytes: expected.reduce<number>(
          (total, entry) => total + Buffer.byteLength(json(entry)),
          0,
        ),
      });
    }
  });

  for (const mode of ["definition", "result"] as const) {
    function setup() {
      if (mode === "definition") {
        const { input, observed } = definitionCase(richPlan());
        return {
          input,
          observed,
          run: (evidence = observed, budget = limits) =>
            enumeratePolicyEvaluationReplayDefinitionReferences(input, evidence, budget),
        };
      }
      const { input, observed } = resultCase(history());
      return {
        input,
        observed,
        run: (evidence = observed, budget = limits) =>
          enumeratePolicyEvaluationReplayResultReferences(input, evidence, budget),
      };
    }
    it(`${mode}: rejects altered parent observations, invalid wrappers, and unverified evidence`, () => {
      const { observed, run } = setup();
      // The overload branches share their runtime observation shape; negative cases deliberately
      // cross the typed caller boundary and must not be accepted by either fixed inspector.
      for (const raw of [
        null,
        {},
        { ...observed, approved: true },
        { ...observed, record: null },
        { ...observed, observation: { status: "missing" } },
        { ...observed, observation: { status: "verified", recordSha256: sha("0") } },
      ]) {
        expect(() => run(raw as never)).toThrow();
      }
      const changed = structuredClone(observed);
      if (!changed.record) throw new Error("Expected body");
      if ("job" in changed.record) changed.record.job.createdByPrincipalId = "usr_changed";
      else changed.record.createdByPrincipalId = "usr_changed";
      expect(() => run(changed as never)).toThrow(
        expect.objectContaining({ reason: "observation_mismatch" }),
      );
    });
    it(`${mode}: charges every occurrence at exact count and UTF-8 boundaries without partial results`, () => {
      const { run } = setup();
      const expected = run();
      const exact = {
        maxReferences: expected.references.length,
        maxReferenceBytes: expected.referenceBytes,
      };
      expect(run(undefined, exact)).toEqual(expected);
      expect(() => run(undefined, { ...exact, maxReferences: exact.maxReferences - 1 })).toThrow(
        expect.objectContaining({ reason: "reference_limit_exceeded" }),
      );
      expect(() =>
        run(undefined, { ...exact, maxReferenceBytes: exact.maxReferenceBytes - 1 }),
      ).toThrow(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
    });
    it(`${mode}: captures wrapper body once and isolates input and output from mutation`, () => {
      const { input, observed, run } = setup();
      const expected = run();
      const originalScope = structuredClone(input.scope);
      const originalResult = structuredClone(expected);
      const getter = vi.fn(() => {
        input.scope.tenantId = "mutated_scope";
        return observed.record;
      });
      expect(
        run({
          ...observed,
          get record() {
            return getter();
          },
        } as never),
      ).toEqual(expected);
      expect(getter).toHaveBeenCalledOnce();
      Object.assign(input.scope, originalScope);
      const first = expected.references[0];
      if (!first) throw new Error("Expected references");
      Reflect.set(first, "path", "/mutated_output");
      expect(run()).toEqual(originalResult);
    });
    it(`${mode}: retains unexpected traversal failures as bounded error causes`, () => {
      const { run } = setup();
      const cause = new Error("Unexpected collector failure");
      const method = vi
        .spyOn(PolicyEvaluationReferenceCollector.prototype, "record")
        .mockImplementation(() => {
          throw cause;
        });
      try {
        expect(() => run()).toThrow(expect.objectContaining({ reason: "input_invalid", cause }));
      } finally {
        method.mockRestore();
      }
    });
    it(`${mode}: rejects foreign scopes and pre-publication times when replaying an old observation`, () => {
      for (const dimension of ["tenantId", "projectId", "environmentId"] as const) {
        const { input, run } = setup();
        input.scope[dimension] = "foreign_scope";
        expect(() => run()).toThrow(expect.objectContaining({ reason: "evidence_unverified" }));
      }
      const { input, run } = setup();
      Reflect.set(input, "evaluationTime", "2000-01-01T00:00:00Z");
      expect(() => run()).toThrow(expect.objectContaining({ reason: "evidence_unverified" }));
    });
    it(`${mode}: rejects invalid occurrence limits before touching the captured body`, () => {
      const { observed, run } = setup();
      const getter = vi.fn(() => {
        throw new Error("Must not read body");
      });
      const wrapper = {
        ...observed,
        get record() {
          return getter();
        },
      };
      for (const maxReferences of [-1, NaN, Infinity, 100001])
        expect(() => run(wrapper as never, { ...limits, maxReferences })).toThrow(
          expect.objectContaining({ reason: "input_invalid" }),
        );
      expect(getter).not.toHaveBeenCalled();
    });
  }
});
