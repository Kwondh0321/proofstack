import { readFileSync } from "node:fs";
import {
  type EvaluationImplementationRegistrationDefinition,
  type EvidenceScope,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationRecordWitnessSchema,
  REPLAY_BUDGET_DIMENSIONS,
  type ReplayJobSnapshot,
  type ReplayPlan,
  type TargetRelease,
} from "@proofstack/contracts";
import {
  CreateModelAssuranceAssessment,
  digestComparisonRecordDefinition,
  StaticEndpointProfileCatalogue,
  StaticEvaluationImplementationRegistrationCatalogue,
  StaticProtocolDefinitionCatalogue,
  StaticQualificationPolicyCatalogue,
  StaticRuntimeDefinitionCatalogue,
  ReleaseDecisionVerificationBudget,
} from "@proofstack/core";
import {
  createComparisonRepositoryTestHarness,
  createModelAssuranceRepositoryTestHarness,
  FixedClock,
  policyAuthorityFixture,
  publishComparisonFixture,
  releaseCandidateFixture,
} from "@proofstack/core/testing";
import type { ReplayBudgetAmounts, ReplayUsageMeasurements } from "@proofstack/replay";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import { describe, expect, it } from "vitest";
import {
  enumerateCapturedPolicyRecord,
  type PolicyRecordGraphRepositories,
  readAndExpandPolicyRecord,
} from "./record-routing.js";
import {
  enumerateRetainedPolicyRecord,
  inspectRetainedPolicyRecord,
} from "./retained-record-routing.js";
import { inspectOriginalSourceActors } from "./inspect-original-source-actors.js";

type Fields = Record<string, unknown>;
const time = "2026-10-01T00:00:00.000Z";
const limits = { maxReferences: 10000, maxReferenceBytes: 4000000 };
const replayLimits = { maximumRecords: 10000, maximumRecordBytes: 4000000 };

// Independently specified remaining owning domains, complementing the thirty assurance cases.
const authorFields: Readonly<Record<string, string>> = {
  protocol_definition: "/registeredByPrincipalId",
  endpoint_profile: "/registeredByPrincipalId",
  qualification_policy: "/publishedByPrincipalId",
  evaluation_implementation_registration: "/registeredByPrincipalId",
  comparison_definition: "/createdByPrincipalId",
  comparison_snapshot: "/createdByPrincipalId",
  dataset_version: "/createdByPrincipalId",
  regression_fixture_version: "/createdByPrincipalId",
  release_candidate: "/createdByPrincipalId",
  release_policy: "/publishedByPrincipalId",
  policy_installation_binding: "/registeredByPrincipalId",
  replay_runtime_profile: "/registeredByPrincipalId",
  replay_isolation_profile: "/registeredByPrincipalId",
  runtime_adapter: "/registeredByPrincipalId",
  replay_plan: "/createdByPrincipalId",
  target_release: "/createdByPrincipalId",
};

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
    implementationRegistrations: absent,
    qualificationPolicies: absent,
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
      Object.keys(schema.shape.reference.shape).map((key) => [
        key,
        kind === "evaluation_implementation_registration" && key !== "definitionSha256"
          ? (body["implementation"] as Fields)[key]
          : body[key],
      ]),
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
    replayLimits,
  };
  const expansion = await readAndExpandPolicyRecord(input, repositories, limits, replayLimits);
  expect(expansion.read.observation.status, kind).toBe("verified");
  expect(expansion.read.source).toEqual(input.source);
  expect(expansion.references, kind).not.toBeNull();
  expect(Array.isArray(expansion.references), kind).toBe(true);
  const derived = enumerateCapturedPolicyRecord(input, expansion.read, limits, replayLimits);
  expect(derived.references, kind).toEqual(expansion.references);
  const retained = inspectRetainedPolicyRecord(input, record);
  if (!retained) throw new Error("Expected owning storage capture for every source kind");
  expect(expansion.storage).toEqual(retained.storage);
  const actorField = kind === "comparison_result" ? "/createdByPrincipalId" : authorFields[kind];
  if (actorField !== undefined) {
    if (!retained.storage) throw new Error("Expected original actor body");
    const inspected = inspectOriginalSourceActors({
      ...input,
      body: record,
      witness: PolicyEvaluationRecordWitnessSchema.parse({
        entry: { source: input.source, observation: retained.read.observation },
        storage: {
          recordSha256: retained.storage.recordSha256,
          receiptTime: retained.storage.receiptTime,
        },
        origins: [{ kind: "semantic_node", nodeIndex: 0 }],
      }),
      budget: new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: 10000,
        maxAcquisitionRecordBytes: 4000000,
        maxApprovalRecords: 0,
      }),
    });
    expect(inspected).toMatchObject({
      state: "observed",
      actors: [
        {
          field: actorField,
          role: kind === "comparison_result" ? "evaluation_actor" : "source_author",
          principalId: Reflect.get(record, actorField.slice(1)),
        },
      ],
    });
  }
  expect(enumerateRetainedPolicyRecord(input, retained, limits)?.references).toEqual(
    expansion.references,
  );
  const originalCut = { ...input, evaluationTime: "2020-01-01T00:00:00.000Z" };
  const future = inspectRetainedPolicyRecord(originalCut, record);
  if (!future) throw new Error("Expected fixed retention route");
  const stored = enumerateRetainedPolicyRecord(originalCut, future, limits);
  expect(stored?.references).toEqual(expansion.references);
  expect(stored?.semanticObservation).toEqual({
    status: "unavailable",
    reason: "not_yet_available",
  });
  expect(future.read.record).toBeNull();
  expect(stored?.storage.source).toEqual(input.source);
  expect(() =>
    enumerateRetainedPolicyRecord(input, { ...retained, storage: null }, limits),
  ).toThrow(expect.objectContaining({ reason: "evidence_unverified" }));
  const changed = structuredClone(expansion.read);
  if (changed.observation.status !== "verified")
    throw new Error("Missing verified routing observation");
  Reflect.set(changed.observation, "recordSha256", "0".repeat(64));
  expect(() => enumerateCapturedPolicyRecord(input, changed, limits, replayLimits)).toThrow();
  return expansion;
}

describe("positive fixed-domain routing", () => {
  it("routes all independently retained protocol families with full original dependency occurrences", async () => {
    for (const { input, sha256 } of vectors(
      "../../contracts/vectors/protocol-definition-v1.json",
    )) {
      const record = {
        ...(input["definition"] as Fields),
        scope: input["scope"],
        definitionSha256: sha256,
        schemaVersion: "0.1",
        registeredAt: "2026-09-01T00:00:00.001Z",
        registeredByPrincipalId: "operator_protocol",
      };
      const expansion = await verify("protocol_definition", record, {
        ...absentRepositories(),
        protocolDefinitions: new StaticProtocolDefinitionCatalogue([record]),
      });
      const definition = input["definition"] as Fields;
      const expected = [
        { kind: "artifact", path: "/specification", reference: definition["specification"] },
      ];
      if (definition["implementation"] !== undefined)
        expected.push(
          { kind: "artifact", path: "/implementation", reference: definition["implementation"] },
          { kind: "artifact", path: "/configuration", reference: definition["configuration"] },
        );
      expect(expansion.references).toEqual(expected);
    }
  });

  it("preserves missing protocol data when the optional catalogue is absent", async () => {
    const source = PolicyEvaluationSourceReferenceSchema.parse({
      kind: "protocol_definition",
      reference: {
        protocolDefinitionId: "protocol_missing",
        definitionSha256: "a".repeat(64),
      },
    });
    const scope: EvidenceScope = {
      tenantId: "tenant_protocol",
      projectId: "project_protocol",
      environmentId: "environment_protocol",
    };
    expect(
      await readAndExpandPolicyRecord(
        { source, scope, evaluationTime: time },
        absentRepositories(),
        limits,
        replayLimits,
      ),
    ).toEqual({
      read: { source, record: null, observation: { status: "missing" } },
      references: null,
      storage: null,
    });
  });
  it("routes every independent endpoint profile vector and its exact retained configuration occurrence", async () => {
    for (const { input, sha256 } of vectors("../../contracts/vectors/endpoint-profile-v1.json")) {
      const record = {
        ...(input["definition"] as Fields),
        scope: input["scope"],
        definitionSha256: sha256,
        schemaVersion: "0.1",
        registeredAt: "2026-09-01T00:00:00.001Z",
        registeredByPrincipalId: "operator_retained",
      };
      const expansion = await verify("endpoint_profile", record, {
        ...absentRepositories(),
        endpointProfiles: new StaticEndpointProfileCatalogue([record]),
      });
      expect(expansion.references).toEqual([
        {
          kind: "artifact",
          path: "/configuration",
          reference: (input["definition"] as Fields)["configuration"],
        },
      ]);
    }
  });
  it("routes every independent qualification policy vector without invented artifact dependencies", async () => {
    for (const { input, sha256 } of vectors(
      "../../contracts/vectors/qualification-policy-v1.json",
    )) {
      const record = {
        ...(input["definition"] as Fields),
        scope: input["scope"],
        definitionSha256: sha256,
        schemaVersion: "0.1",
        publishedAt: "2026-09-01T00:00:00.000Z",
        publishedByPrincipalId: "operator_retained",
      };
      const expansion = await verify("qualification_policy", record, {
        ...absentRepositories(),
        qualificationPolicies: new StaticQualificationPolicyCatalogue([record]),
      });
      expect(expansion.references).toEqual([]);
    }
  });
  it("routes a complete independent implementation registration with no invented artifact dependencies", async () => {
    const document = JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/vectors/evaluation-implementation-registration-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      vectors: {
        input: { definition: EvaluationImplementationRegistrationDefinition; scope: EvidenceScope };
        sha256: string;
      }[];
    };
    for (const vector of document.vectors) {
      const record = {
        ...vector.input.definition,
        scope: vector.input.scope,
        definitionSha256: vector.sha256,
        schemaVersion: "0.1" as const,
        registeredAt: "2026-09-01T00:00:00.000Z",
        registeredByPrincipalId: "operator_retained",
      };
      const expansion = await verify("evaluation_implementation_registration", record, {
        ...absentRepositories(),
        implementationRegistrations: new StaticEvaluationImplementationRegistrationCatalogue([
          record,
        ]),
      });
      expect(expansion.references).toEqual([]);
    }
  });

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
      enumerateCapturedPolicyRecord(
        { source: reference, scope, evaluationTime: time },
        expansion.read,
        limits,
        replayLimits,
      ).references,
    ).toEqual(expansion.references);
    expect(
      expansion.references?.some(
        (edge) => edge.kind === "record" && edge.source.kind === "replay_plan",
      ),
    ).toBe(true);
    const context = { source: reference, scope, evaluationTime: time, replayLimits };
    const retained = inspectRetainedPolicyRecord(context, completed);
    expect(retained?.storage).toEqual(expansion.storage);
    if (!retained?.storage) throw new Error("Expected complete original replay history");
    const actorWitness = PolicyEvaluationRecordWitnessSchema.parse({
      entry: { source: reference, observation: retained.read.observation },
      storage: {
        recordSha256: retained.storage.recordSha256,
        receiptTime: retained.storage.receiptTime,
      },
      origins: [{ kind: "stored_node", nodeIndex: 0 }],
    });
    const normalizedRows =
      1 +
      (completed.cancellationRequest === null ? 0 : 1) +
      completed.attempts.length +
      completed.budgetLedger.length +
      completed.cancellationAcknowledgements.length +
      completed.executionObservations.length +
      completed.usageObservations.length;
    const actorBudget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: normalizedRows,
      maxAcquisitionRecordBytes: 4000000,
      maxApprovalRecords: 0,
    });
    // The owning reader normalizes schema-admitted optional undefined fields before hashing.
    const actorInput = {
      ...context,
      witness: actorWitness,
      body: retained.storage.record,
      budget: actorBudget,
    };
    expect(inspectOriginalSourceActors(actorInput)).toMatchObject({
      state: "observed",
      actors: [
        {
          field: "/job/createdByPrincipalId",
          role: "workflow_requester",
          principalId: "principal_routing",
        },
      ],
    });
    expect(actorBudget.snapshot().records).toBe(normalizedRows);
    const shortBudget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: normalizedRows - 1,
      maxAcquisitionRecordBytes: 4000000,
      maxApprovalRecords: 0,
    });
    expect(() => inspectOriginalSourceActors({ ...actorInput, budget: shortBudget })).toThrow(
      expect.objectContaining({ reason: "record_limit" }),
    );
    expect(() => shortBudget.snapshot()).toThrow();
    const tamperedActor = structuredClone(retained.storage.record) as ReplayJobSnapshot;
    tamperedActor.job.createdByPrincipalId = "principal_substituted";
    expect(
      inspectOriginalSourceActors({
        ...actorInput,
        body: tamperedActor,
        budget: new ReleaseDecisionVerificationBudget({
          maxAcquisitionRecords: 10000,
          maxAcquisitionRecordBytes: 4000000,
          maxApprovalRecords: 0,
        }),
      }),
    ).toMatchObject({ state: "unavailable", reason: "original_body_mismatch" });
    expect(enumerateRetainedPolicyRecord(context, retained, limits)?.references).toEqual(
      expansion.references,
    );
    const originalCut = { ...context, evaluationTime: "2020-01-01T00:00:00.000Z" };
    const future = inspectRetainedPolicyRecord(originalCut, completed);
    if (!future?.storage) throw new Error("Expected future original replay storage");
    expect(enumerateRetainedPolicyRecord(originalCut, future, limits)?.semanticObservation).toEqual(
      { status: "unavailable", reason: "not_yet_available" },
    );
    expect(future.read.record).toBeNull();
    expect(() =>
      inspectRetainedPolicyRecord({ source: reference, scope, evaluationTime: time }, completed),
    ).toThrow("original finite read limits");
  });
});
