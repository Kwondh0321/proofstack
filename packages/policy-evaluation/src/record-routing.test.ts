import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  PolicyEvaluationSourceReferenceSchema,
  type ReplayPlan,
  type TargetRelease,
  type ReplayJobSnapshot,
  REPLAY_BUDGET_DIMENSIONS,
} from "@proofstack/contracts";
import {
  CreateModelAssuranceAssessment,
  StaticRuntimeDefinitionCatalogue,
  digestComparisonRecordDefinition,
} from "@proofstack/core";
import {
  createModelAssuranceRepositoryTestHarness,
  createComparisonRepositoryTestHarness,
  publishComparisonFixture,
  policyAuthorityFixture,
  releaseCandidateFixture,
  FixedClock,
} from "@proofstack/core/testing";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import type { ReplayBudgetAmounts, ReplayUsageMeasurements } from "@proofstack/replay";
import { describe, expect, it } from "vitest";
import { type PolicyRecordGraphRepositories, readAndExpandPolicyRecord } from "./record-routing.js";

type Fields = Record<string, unknown>;
const time = "2026-10-01T00:00:00.000Z";
const limits = { maxReferences: 10000, maxReferenceBytes: 4000000 };
const replayLimits = { maximumRecords: 10000, maximumRecordBytes: 4000000 };

function absentRepositories(): PolicyRecordGraphRepositories {
  const absent = new Proxy({}, { get: () => async () => null });
  return {
    control: {
      comparison: absent,
      releaseCandidate: absent,
      releasePolicy: absent,
      installationBinding: absent,
    },
    evidence: { evaluation: absent, modelAssurance: absent },
    datasets: absent,
    replayDefinitions: absent,
    replayResults: absent,
    runtimeDefinitions: absent,
  } as PolicyRecordGraphRepositories;
}

function source(kind: string, record: object) {
  const schema = PolicyEvaluationSourceReferenceSchema.options.find(
    (option) => option.shape.kind.value === kind,
  );
  if (!schema) throw new Error(`Missing source kind ${kind}`);
  const body = record as Fields;
  return schema.parse({
    kind,
    reference: Object.fromEntries(
      Object.keys(schema.shape.reference.shape).map((key) => [key, body[key]]),
    ),
  });
}

function vectors(path: string) {
  return (
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
      vectors: { kind: string; input: Fields; sha256: string }[];
    }
  ).vectors;
}

async function verify(kind: string, record: object, repositories: PolicyRecordGraphRepositories) {
  const input = {
    source: source(kind, record),
    scope: (record as { scope: EvidenceScope }).scope,
    evaluationTime: time,
  };
  const expansion = await readAndExpandPolicyRecord(input, repositories, limits, replayLimits);
  expect(expansion.read.observation.status, kind).toBe("verified");
  expect(expansion.read.source).toEqual(input.source);
  expect(expansion.references, kind).not.toBeNull();
  expect(Array.isArray(expansion.references), kind).toBe(true);
  return expansion;
}

describe("positive fixed-domain routing", () => {
  it("reads and expands all thirty evaluation/model/human kinds through actual repositories", async () => {
    const harness = await createModelAssuranceRepositoryTestHarness("routing");
    const assessment = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: harness.evaluation.repository,
      modelAssuranceRepository: harness.repository,
    }).execute(harness.command);
    const repositories = {
      ...absentRepositories(),
      evidence: { evaluation: harness.evaluation.repository, modelAssurance: harness.repository },
    };
    const kinds = new Set<string>();
    for (const { kind, record } of [
      ...harness.evaluation.records,
      ...harness.records,
      { kind: "model_assurance_assessment", record: assessment.record },
    ]) {
      const mapped =
        kind === "model_assisted_evaluator"
          ? "model_assisted_evaluator_spec"
          : kind === "blinded_evaluation_plan"
            ? "blinded_plan"
            : kind === "blinded_evaluation_result"
              ? "blinded_result"
              : kind;
      await verify(mapped, record, repositories);
      kinds.add(mapped);
    }
    expect(kinds.size).toBe(30);
  });

  it("expands every control kind including both comparison snapshot roles", async () => {
    const comparison = createComparisonRepositoryTestHarness("routing");
    for (const fixture of comparison.records) {
      // The comparison vector deliberately includes two digests under one artifact identity.
      // The fixed enumerator correctly rejects that vector; this positive case retains an
      // unchanged artifact, while graph conflict tests cover rejection separately.
      if (fixture.kind === "comparison_result") {
        for (const change of fixture.record.artifactChanges)
          if (change.baseline && change.candidate) {
            change.candidate = structuredClone(change.baseline);
            change.status = "unchanged";
          }
        const {
          createdAt: _at,
          createdByPrincipalId: _by,
          definitionSha256: _hash,
          schemaVersion: _version,
          scope,
          ...definition
        } = fixture.record;
        fixture.record.definitionSha256 = digestComparisonRecordDefinition(
          "comparison_result",
          scope,
          definition,
        );
      }
      await publishComparisonFixture(comparison.repository, fixture);
    }
    const authority = policyAuthorityFixture({ scope: comparison.scope });
    const candidate = releaseCandidateFixture("routing", comparison.scope);
    const repositories: PolicyRecordGraphRepositories = {
      ...absentRepositories(),
      control: {
        comparison: comparison.repository,
        releaseCandidate: { findReleaseCandidate: async () => candidate },
        releasePolicy: { findReleasePolicy: async () => authority.policy },
        installationBinding: { resolve: async () => authority.binding },
      },
    };
    for (const { kind, record } of comparison.records)
      await verify(
        kind === "comparison_evidence_snapshot" ? "comparison_snapshot" : kind,
        record,
        repositories,
      );
    await verify("release_candidate", candidate, repositories);
    await verify("release_policy", authority.policy, repositories);
    await verify("policy_installation_binding", authority.binding, repositories);
  });

  it("expands dataset and both fixture formats without discarding the observed trace frontier", async () => {
    for (const vector of [
      ...vectors("../../datasets/vectors/regression-definition-v1.json"),
      ...vectors("../../datasets/vectors/interaction-fixture-definition-v2.json"),
    ]) {
      const record = {
        ...vector.input,
        createdAt: "2026-09-08T00:00:00.000Z",
        createdByPrincipalId: "principal_routing",
        definitionSha256: vector.sha256,
        ...(vector.input["source"]
          ? {
              source: {
                ...(vector.input["source"] as Fields),
                capturedAt: "2026-09-08T00:00:00.000Z",
              },
            }
          : {}),
      };
      const dataset = "datasetVersionId" in record;
      const interaction = vector.input["schemaVersion"] === "0.2";
      const repositories = {
        ...absentRepositories(),
        datasets: {
          findDatasetVersion: async () => (dataset ? record : null),
          findFixtureVersion: async () => (!dataset && !interaction ? record : null),
          findRecordedInteractionFixtureVersion: async () =>
            interaction ? { version: record } : null,
        },
      } as PolicyRecordGraphRepositories;
      const expansion = await verify(
        dataset ? "dataset_version" : "regression_fixture_version",
        record,
        repositories,
      );
      if (!dataset)
        expect(expansion.references?.some(({ kind }) => kind === "trace_snapshot_selector")).toBe(
          true,
        );
    }
  });

  it("expands runtime and isolation profiles and adapters from a retained catalogue", async () => {
    const records = vectors("../../contracts/vectors/runtime-definition-v1.json").map(
      ({ input, sha256 }) => ({
        ...(input["definition"] as Fields),
        scope: input["scope"],
        definitionSha256: sha256,
        schemaVersion: "0.1",
        registeredAt: "2026-09-08T00:00:00.000Z",
        registeredByPrincipalId: "principal_routing",
      }),
    );
    const repositories = {
      ...absentRepositories(),
      runtimeDefinitions: new StaticRuntimeDefinitionCatalogue(records),
    };
    for (const record of records)
      await verify(String((record as Fields)["recordKind"]), record, repositories);
  });

  it("expands an actual terminal replay history as well as its retained plan and release", async () => {
    const definitions = new MemoryReplayDefinitionRepository();
    const records = vectors("../../replay/vectors/replay-definition-v1.json").map(
      ({ input, sha256 }) => ({
        ...input,
        definitionSha256: sha256,
        createdAt: "2026-09-08T00:00:00.000Z",
        createdByPrincipalId: "principal_routing",
      }),
    );
    const plan = records.find((record) => "planVersionId" in record) as unknown as ReplayPlan;
    const target = records.find(
      (record) => "targetReleaseId" in record,
    ) as unknown as TargetRelease;
    await definitions.publishTargetRelease(target);
    await definitions.publishReplayPlan(plan);
    let now = "2026-09-08T00:00:00.000Z";
    const jobs = new MemoryReplayJobRepository({ definitions, now: () => now });
    const scope = plan.scope;
    const { snapshot } = await jobs.createJob({
      createdByPrincipalId: "principal_routing",
      jobId: "job_routing",
      scope,
      plan: source("replay_plan", plan).reference as ReplayJobSnapshot["job"]["plan"],
    });
    now = "2026-09-08T00:00:00.100Z";
    const claimed = await jobs.claimJob({
      attemptId: "attempt_routing",
      jobId: snapshot.job.jobId,
      leaseDurationMilliseconds: 2000,
      leaseId: "lease_routing",
      scope,
      workerBuildSha256: "a".repeat(64),
      workerId: "worker_routing",
      workerProtocol: plan.workerProtocol,
    });
    if (!claimed.claimed) throw new Error("Could not claim test replay");
    const workerFence = claimed.workerFence;
    await jobs.reserveBudget({
      reservationId: "reservation_routing",
      scope,
      workerFence,
      work: { kind: "attempt_start" },
      requested: Object.fromEntries(
        REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
          dimension,
          dimension === "jobAttempts" ? 1 : 0,
        ]),
      ) as ReplayBudgetAmounts,
    });
    await jobs.reconcileBudget({
      reservationId: "reservation_routing",
      reconciliationId: "reconciliation_routing",
      scope,
      workerFence,
      usage: Object.fromEntries(
        REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
          dimension,
          { status: "observed", amount: dimension === "jobAttempts" ? 1 : 0, source: "measured" },
        ]),
      ) as ReplayUsageMeasurements,
    });
    now = "2026-09-08T00:00:00.200Z";
    const completed = await jobs.completeJob({
      scope,
      workerFence,
      code: "completed",
      status: "succeeded",
      result: {
        artifactId: "artifact_routing",
        classification: "internal",
        mediaType: "application/json",
        sizeBytes: 128,
        sha256: "f".repeat(64),
      },
    });
    const attempt = completed.attempts.at(-1);
    if (!attempt) throw new Error("Missing successful attempt");
    const repositories = {
      ...absentRepositories(),
      replayDefinitions: definitions,
      replayResults: jobs,
    };
    await verify("replay_plan", plan, repositories);
    await verify("target_release", target, repositories);
    const reference = PolicyEvaluationSourceReferenceSchema.parse({
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
    });
    const expansion = await readAndExpandPolicyRecord(
      { source: reference, scope, evaluationTime: time },
      repositories,
      limits,
      replayLimits,
    );
    expect(expansion.read.observation.status).toBe("verified");
    expect(
      expansion.references?.some(
        (edge) => edge.kind === "record" && edge.source.kind === "replay_plan",
      ),
    ).toBe(true);
  });
});
