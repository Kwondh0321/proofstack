import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type EndpointProfileDefinition,
  type EndpointProfileRecord,
  type EvaluationImplementationRegistrationRecord,
  type EvaluationRun,
  type EvaluatorSpec,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
  type QualificationPolicyDefinition,
  type QualificationPolicyRecord,
  type RecordedInteractionFixtureVersionDefinition,
  type RegressionDatasetVersionDefinition,
  type RegressionFixtureVersion,
  type RegressionFixtureVersionDefinition,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  type ReplayPlanDefinition,
  type RuntimeDefinition,
  type RuntimeDefinitionRecord,
  type TargetReleaseDefinition,
} from "@proofstack/contracts";
import {
  assemblePolicyEvaluationManifest,
  CreateModelAssuranceAssessment,
  digestEndpointProfile,
  digestEvaluationImplementationRegistration,
  digestEvaluationRecordDefinition,
  digestPolicyEvaluationRequestDefinition,
  digestQualificationPolicy,
  digestReleaseCandidateDefinition,
  digestReleasePolicyDefinition,
  digestRuntimeDefinition,
  evaluationRecordDescriptors,
  StaticEndpointProfileCatalogue,
  StaticEvaluationImplementationRegistrationCatalogue,
  StaticQualificationPolicyCatalogue,
  StaticRuntimeDefinitionCatalogue,
  validatePolicyEvaluationManifest,
} from "@proofstack/core";
import {
  comparisonDefinitionFixture,
  createEvaluationRepositoryTestHarness,
  createModelAssuranceRepositoryTestHarness,
  type EvaluationRepositoryFixtureRecord,
  FixedClock,
  MemoryComparisonRepository,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
  publishEvaluationFixture,
  releaseCandidateFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
  MemoryRegressionVersionRepository,
} from "@proofstack/datasets";
import { digestReplayPlanDefinition, digestTargetReleaseDefinition } from "@proofstack/replay";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import { describe, expect, it, vi } from "vitest";
import { AcquisitionBudget } from "./acquisition-budget.js";
import { inspectCapturedCandidateAssessmentLineage } from "./capture-candidate-assessment-lineage.js";
import { inspectCapturedEvaluationReplayBindings } from "./capture-evaluation-replay-bindings.js";
import { inspectCapturedEvaluationRun } from "./capture-evaluation-run-bindings.js";
import { inspectCapturedEvaluationSnapshots } from "./capture-evaluation-snapshots.js";
import { inspectCapturedPolicyAssessments } from "./capture-policy-assessments.js";
import { acquirePolicyRecordGraph, capturePolicyRecordGraph } from "./capture-record-graph.js";
import { capturePolicyTraceEvidence } from "./capture-trace-evidence.js";
import { deriveCapturedRecordClosure } from "./derive-record-closure.js";
import { type PolicyRecordGraphRepositories, readAndExpandPolicyRecord } from "./record-routing.js";

type Fields = Record<string, unknown>;
const requestVector = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/vectors/policy-evaluation-request-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { vectors: { input: { definition: PolicyEvaluationRequestDefinition } }[] };
const defaults = requestVector.vectors[0]?.input.definition;
if (!defaults) throw new Error("Missing request vector");
const time = "2026-10-01T00:00:00.000Z";

function request(
  candidate: ReleaseCandidate,
  policy: ReleasePolicy,
  limits = defaults?.limits,
): PolicyEvaluationRequest {
  const definition: PolicyEvaluationRequestDefinition = {
    ...(defaults as PolicyEvaluationRequestDefinition),
    evaluationTime: time,
    limits: structuredClone(limits) as PolicyEvaluationRequestDefinition["limits"],
    candidate: {
      candidateId: candidate.candidateId,
      candidateVersionId: candidate.candidateVersionId,
      definitionSha256: candidate.definitionSha256,
    },
    policy: {
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      definitionSha256: policy.definitionSha256,
    },
  };
  return {
    ...definition,
    createdAt: time,
    createdByPrincipalId: "principal_graph",
    definitionSha256: digestPolicyEvaluationRequestDefinition(candidate.scope, definition),
    schemaVersion: "0.1",
    scope: structuredClone(candidate.scope),
  };
}

function candidateDigest(candidate: ReleaseCandidate): ReleaseCandidate {
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    schemaVersion: _version,
    definitionSha256: _hash,
    scope,
    ...definition
  } = candidate;
  return {
    ...candidate,
    definitionSha256: digestReleaseCandidateDefinition(
      scope,
      definition as ReleaseCandidateDefinition,
    ),
  };
}

function policyDigest(policy: ReleasePolicy): ReleasePolicy {
  const {
    publishedAt: _at,
    publishedByPrincipalId: _by,
    schemaVersion: _version,
    definitionSha256: _hash,
    scope,
    ...definition
  } = policy;
  return {
    ...policy,
    definitionSha256: digestReleasePolicyDefinition(scope, definition as ReleasePolicyDefinition),
  };
}

function missingRepositories() {
  const calls: { domain: string; method: string; args: unknown[] }[] = [];
  const port = (domain: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, method) =>
          async (...args: unknown[]) => {
            calls.push({ domain, method: String(method), args: structuredClone(args) });
            return null;
          },
      },
    );
  const repositories = {
    control: {
      comparison: port("comparison"),
      releaseCandidate: port("candidate"),
      releasePolicy: port("policy"),
      installationBinding: port("binding"),
    },
    evidence: { evaluation: port("evaluation"), modelAssurance: port("model") },
    datasets: port("dataset"),
    replayDefinitions: port("replay"),
    replayResults: port("job"),
    runtimeDefinitions: port("runtime"),
    implementationRegistrations: port("implementation"),
    qualificationPolicies: port("qualification"),
    endpointProfiles: port("endpoint"),
    protocolDefinitions: port("protocol"),
  } as PolicyRecordGraphRepositories;
  return { repositories, calls };
}

function registrationInspectionUsage(graph: Awaited<ReturnType<typeof capturePolicyRecordGraph>>) {
  const references = graph.edges
    .filter(({ reference }) => reference.kind === "registered_implementation")
    .flatMap(({ parent }) => {
      const node = graph.nodes.find(
        ({ read }) =>
          policyEvaluationSourceReferenceKey(read.source) ===
          policyEvaluationSourceReferenceKey(parent),
      );
      if (!node?.references) throw new Error("Missing registration parent frontier");
      return node.references;
    });
  return {
    references: references.length,
    referenceBytes: references.reduce(
      (sum, reference) => sum + encodeEvaluationCanonicalJson(reference).byteLength,
      0,
    ),
  };
}

function retainedRegistrations(setup: Awaited<ReturnType<typeof harness>>) {
  const records = new Map<string, EvaluationImplementationRegistrationRecord>();
  for (const item of setup.evaluation.records) {
    const implementation =
      item.kind === "oracle_spec" || item.kind === "evaluator_spec"
        ? item.record.implementation
        : item.kind === "evaluation_run" || item.kind === "evaluation_run_rejection"
          ? item.record.applicability.interpreter
          : undefined;
    if (!implementation) continue;
    const key = JSON.stringify([
      implementation.implementationId,
      implementation.implementationVersionId,
    ]);
    const prior = records.get(key);
    if (prior) {
      expect(prior.implementation).toEqual(implementation);
      continue;
    }
    const definition = {
      recordKind: "evaluation_implementation_registration" as const,
      implementation: structuredClone(implementation),
    };
    records.set(key, {
      ...definition,
      scope: structuredClone(setup.input.scope),
      schemaVersion: "0.1",
      definitionSha256: digestEvaluationImplementationRegistration(setup.input.scope, definition),
      registeredAt: "2026-09-01T00:00:00.000Z",
      registeredByPrincipalId: "operator_retained",
    });
  }
  return [...records.values()];
}

async function harness(
  replayCase?: "valid" | "invalid_digest" | "unsupported_kind" | "history",
  snapshots?: {
    mutate?: (fixture: EvaluationRepositoryFixtureRecord) => void;
    dataset?: "matched" | "wrong_fixture";
    replayBindings?: boolean;
    plan?: (plan: ReplayPlanDefinition) => void;
    qualificationPolicy?: boolean;
    endpointProfile?: boolean;
    modelEndpoint?: boolean;
    modelCapture?: (definition: RecordedInteractionFixtureVersionDefinition) => void;
  },
) {
  const evaluation = createEvaluationRepositoryTestHarness("graph");
  // Define independent operator data before publishing new plans that refer to its hash.
  const endpointProfile = snapshots?.endpointProfile
    ? (() => {
        const document = JSON.parse(
          readFileSync(
            new URL("../../contracts/vectors/endpoint-profile-v1.json", import.meta.url),
            "utf8",
          ),
        ) as { vectors: { input: { definition: EndpointProfileDefinition } }[] };
        const definition = document.vectors[0]?.input.definition;
        if (!definition) throw new Error("Missing independent endpoint profile vector");
        if (snapshots.modelEndpoint)
          definition.operations = ["chat", "generate_content", "text_completion"];
        return {
          ...structuredClone(definition),
          scope: evaluation.scope,
          schemaVersion: "0.1" as const,
          definitionSha256: digestEndpointProfile(evaluation.scope, definition),
          registeredAt: "2026-09-01T00:00:00.001Z",
          registeredByPrincipalId: "operator_retained",
        } satisfies EndpointProfileRecord;
      })()
    : undefined;
  // Independently define operator data first, then publish new reports referring to it.
  // Existing placeholder report hashes are never fabricated into genuine policy bodies.
  const qualificationPolicy = snapshots?.qualificationPolicy
    ? (() => {
        const document = JSON.parse(
          readFileSync(
            new URL("../../contracts/vectors/qualification-policy-v1.json", import.meta.url),
            "utf8",
          ),
        ) as { vectors: { input: { definition: QualificationPolicyDefinition } }[] };
        const definition = document.vectors[0]?.input.definition;
        if (!definition) throw new Error("Missing independent qualification policy vector");
        return {
          ...structuredClone(definition),
          scope: evaluation.scope,
          schemaVersion: "0.1" as const,
          definitionSha256: digestQualificationPolicy(evaluation.scope, definition),
          publishedAt: "2026-09-01T00:00:00.000Z",
          publishedByPrincipalId: "operator_retained",
        } satisfies QualificationPolicyRecord;
      })()
    : undefined;
  const datasets = new MemoryRegressionVersionRepository();
  const modelPredecessors: RegressionFixtureVersion[] = [];
  const retainedFixtures = snapshots?.dataset
    ? evaluation.records
        .filter((f) => f.kind === "evaluation_run")
        .map(({ record }) => {
          const definition: RegressionFixtureVersionDefinition = {
            fixtureId:
              record.evaluationRunId === "evr_1"
                ? "fixture_lineage_second"
                : record.fixture.fixtureId,
            fixtureVersionId:
              record.evaluationRunId === "evr_1"
                ? "fxv_schema_v2"
                : record.fixture.fixtureVersionId,
            name: "Candidate lineage fixture",
            scope: evaluation.scope,
            schemaVersion: "0.1",
            replayability: "evidence_only",
            source: {
              kind: "trace_snapshot",
              traceId: "0123456789abcdef0123456789abcdef",
              eventIds: ["evt_lineage"],
              observedEventCount: 1,
              sourceCompleteness: "observed_snapshot",
            },
          };
          if (snapshots.modelEndpoint && record.evaluationRunId !== "evr_1") {
            if (!endpointProfile) throw new Error("Missing independent model endpoint data");
            const vector = JSON.parse(
              readFileSync(
                new URL(
                  "../../datasets/vectors/interaction-fixture-definition-v2.json",
                  import.meta.url,
                ),
                "utf8",
              ),
            ) as { vectors: { input: RecordedInteractionFixtureVersionDefinition }[] };
            const capture = structuredClone(vector.vectors[0]?.input.interactionCapture);
            if (!capture) throw new Error("Missing original capture vector");
            const model = capture.interactions[0];
            if (model?.kind !== "model" || !model.attempts[0])
              throw new Error("Missing original model attempt");
            const attempt = model.attempts[0];
            const binding = capture.artifacts.find(
              (a) =>
                a.contentReference.artifactId === attempt.artifacts.providerConfigurationArtifactId,
            );
            if (!binding) throw new Error("Missing original provider configuration");
            binding.contentReference = structuredClone(endpointProfile.configuration);
            binding.redaction = {
              status: "applied",
              records: [
                {
                  stage: "source",
                  rulesetId: "rule_private",
                  rulesetVersion: "1",
                  changedPaths: ["/secret"],
                  matchCount: 1,
                },
              ],
            };
            capture.artifacts.sort((a, b) =>
              a.contentReference.artifactId < b.contentReference.artifactId ? -1 : 1,
            );
            attempt.artifacts.providerConfigurationArtifactId =
              endpointProfile.configuration.artifactId;
            attempt.provider = {
              ...attempt.provider,
              endpointProfileId: endpointProfile.endpointProfileId,
              endpointProfileVersion: endpointProfile.endpointProfileVersion,
              name: endpointProfile.provider,
            };
            // This NEW synthetic capture precedes its original publication receipt and the
            // new run. Historical vector bodies/receipts and provider execution are not rewritten.
            for (const interaction of capture.interactions)
              for (const item of interaction.attempts) {
                item.startedAt = "2026-09-01T00:00:00.000Z";
                item.endedAt = "2026-09-01T00:00:00.000Z";
              }
            const precursor: RegressionFixtureVersionDefinition = {
              ...definition,
              fixtureVersionId: `${definition.fixtureVersionId}_precursor`,
            };
            const predecessor = {
              ...precursor,
              createdAt: "2026-09-01T00:00:00.000Z",
              createdByPrincipalId: "principal_lineage",
              source: { ...precursor.source, capturedAt: "2026-09-01T00:00:00.000Z" },
              definitionSha256: digestRegressionFixtureVersionDefinition(precursor),
            };
            modelPredecessors.push(predecessor);
            const recorded: RecordedInteractionFixtureVersionDefinition = {
              ...definition,
              schemaVersion: "0.2",
              replayability: "recorded_interactions",
              interactionCapture: capture,
              predecessor: {
                fixtureVersionId: predecessor.fixtureVersionId,
                definitionSha256: predecessor.definitionSha256,
              },
            };
            snapshots.modelCapture?.(recorded);
            return {
              ...recorded,
              createdAt: "2026-09-01T00:00:00.002Z",
              createdByPrincipalId: "principal_lineage",
              source: { ...recorded.source, capturedAt: "2026-09-01T00:00:00.000Z" },
              definitionSha256: digestRecordedInteractionFixtureVersionDefinition(recorded),
            };
          }
          return {
            ...definition,
            createdAt: "2026-09-01T00:00:00.000Z",
            createdByPrincipalId: "principal_lineage",
            source: { ...definition.source, capturedAt: "2026-09-01T00:00:00.000Z" },
            definitionSha256: digestRegressionFixtureVersionDefinition(definition),
          };
        })
    : [];
  for (const fixture of modelPredecessors) await datasets.publishFixtureVersion(fixture);
  for (const fixture of retainedFixtures) {
    if (fixture.schemaVersion === "0.2") {
      for (const binding of fixture.interactionCapture.artifacts)
        datasets.seedInteractionArtifact({
          schemaVersion: "0.1",
          scope: fixture.scope,
          contentReference: binding.contentReference,
          redaction: binding.redaction,
          retention: binding.retention,
          state: "available",
          createdAt: "2026-09-01T00:00:00.000Z",
          availableAt: "2026-09-01T00:00:00.001Z",
        });
      await datasets.publishRecordedInteractionFixtureVersion(fixture);
    } else await datasets.publishFixtureVersion(fixture);
  }
  const datasetDefinition: RegressionDatasetVersionDefinition = {
    schemaVersion: "0.1",
    scope: evaluation.scope,
    name: "Candidate lineage dataset",
    datasetId: "dts_regression",
    datasetVersionId: "dtv_regression_v1",
    fixtureVersions: retainedFixtures
      .filter((_, i) => snapshots?.dataset !== "wrong_fixture" || i > 0)
      .map(({ fixtureId, fixtureVersionId, definitionSha256 }) => ({
        fixtureId,
        fixtureVersionId,
        definitionSha256,
      })),
  };
  const retainedDataset = snapshots?.dataset
    ? {
        ...datasetDefinition,
        createdAt: "2026-09-01T00:00:00.000Z",
        createdByPrincipalId: "principal_lineage",
        definitionSha256: digestRegressionDatasetVersionDefinition(datasetDefinition),
      }
    : undefined;
  if (retainedDataset) await datasets.publishDatasetVersion(retainedDataset);
  const bindDataset = (object: Fields) => {
    if (retainedDataset && object["datasetVersionId"] === retainedDataset.datasetVersionId) {
      object["datasetId"] = retainedDataset.datasetId;
      object["definitionSha256"] = retainedDataset.definitionSha256;
    }
    const fixture = retainedFixtures.find((f) => f.fixtureVersionId === object["fixtureVersionId"]);
    if (fixture) {
      object["fixtureId"] = fixture.fixtureId;
      object["definitionSha256"] = fixture.definitionSha256;
    }
  };
  const replayRepository = new MemoryReplayDefinitionRepository();
  const runtimeRecords: RuntimeDefinitionRecord[] = [];
  const replay = replayCase
    ? (() => {
        const document = JSON.parse(
          readFileSync(
            new URL("../../replay/vectors/replay-definition-v1.json", import.meta.url),
            "utf8",
          ),
        ) as {
          vectors: { kind: string; input: ReplayPlanDefinition | TargetReleaseDefinition }[];
        };
        const targetDefinition = document.vectors.find((v) => v.kind === "target_release")
          ?.input as TargetReleaseDefinition;
        targetDefinition.scope = evaluation.scope;
        if (snapshots?.replayBindings)
          targetDefinition.supportedBoundaryModes = endpointProfile
            ? ["live_provider", "simulation"]
            : ["simulation"];
        if (replayCase === "unsupported_kind") targetDefinition.supportedBoundaryKinds = ["tool"];
        const receipt = {
          createdAt:
            replayCase === "history" ? "2026-09-01T00:00:00.000Z" : "2026-09-08T00:00:00.000Z",
          createdByPrincipalId: "principal_replay_graph",
        };
        const target = {
          ...targetDefinition,
          ...receipt,
          definitionSha256: digestTargetReleaseDefinition(targetDefinition),
        };
        const targetReference = {
          targetId: target.targetId,
          targetReleaseId: target.targetReleaseId,
          definitionSha256: target.definitionSha256,
          targetAdapter: target.targetAdapter,
          workerProtocol: target.workerProtocol,
        };
        const planDefinition = document.vectors.find((v) => v.kind === "replay_plan")
          ?.input as ReplayPlanDefinition;
        planDefinition.scope = evaluation.scope;
        planDefinition.targetRelease = targetReference;
        if (snapshots?.replayBindings) {
          if (!retainedDataset) throw new Error("Joined replay requires a retained dataset");
          planDefinition.dataset = {
            datasetId: retainedDataset.datasetId,
            datasetVersionId: retainedDataset.datasetVersionId,
            definitionSha256: retainedDataset.definitionSha256,
          };
          // A shared plan can simulate a dataset containing several distinct evaluation fixtures.
          // This is retained metadata; the test does not claim a simulator actually ran.
          planDefinition.boundaries = [
            {
              boundaryId: endpointProfile
                ? "boundary_0_shared_simulation"
                : "boundary_shared_simulation",
              kind: "model",
              mode: "simulation",
              configurationSha256: "7".repeat(64),
              seedHex: "8".repeat(64),
              simulatorRelease: targetReference,
              qualification: {
                artifactId: "artifact_simulation_qualification",
                sha256: "9".repeat(64),
                sizeBytes: 1,
                mediaType: "application/json",
                classification: "internal",
              },
            },
          ];
          const vectors = JSON.parse(
            readFileSync(
              new URL("../../contracts/vectors/runtime-definition-v1.json", import.meta.url),
              "utf8",
            ),
          ) as { vectors: { input: { definition: RuntimeDefinition } }[] };
          for (const { input } of vectors.vectors) {
            const definition = structuredClone(input.definition);
            if (definition.recordKind === "runtime_adapter") continue;
            if (definition.recordKind === "replay_runtime_profile") {
              definition.family = target.runtime.family;
              definition.runtime = {
                architecture: target.runtime.architecture,
                platform: target.runtime.platform,
                version: target.runtime.version,
              };
            }
            const record: RuntimeDefinitionRecord = {
              ...definition,
              schemaVersion: "0.1",
              scope: evaluation.scope,
              registeredAt: "2026-09-01T00:00:00.000Z",
              registeredByPrincipalId: "principal_graph_runtime",
              definitionSha256: digestRuntimeDefinition(evaluation.scope, definition),
            };
            runtimeRecords.push(record);
            if (record.recordKind === "replay_runtime_profile")
              planDefinition.runtimeProfile = {
                id: record.id,
                version: record.version,
                family: record.family,
                definitionSha256: record.definitionSha256,
              };
            else
              planDefinition.isolationProfile = {
                id: record.id,
                version: record.version,
                kind: record.kind,
                definitionSha256: record.definitionSha256,
              };
          }
        }
        if (endpointProfile) {
          planDefinition.boundaries.push({
            boundaryId: "boundary_1_endpoint",
            mode: "live_provider",
            kind: "model",
            endpointProfile: {
              endpointProfileId: endpointProfile.endpointProfileId,
              endpointProfileVersion: endpointProfile.endpointProfileVersion,
              definitionSha256: endpointProfile.definitionSha256,
            },
            destination: structuredClone(endpointProfile.destination),
            operation: "chat",
            credential: {
              credentialId: "credential_endpoint",
              credentialVersionId: "credential_endpoint_v1",
            },
            requestLimits: { requestBytes: 1024, responseBytes: 4096 },
            sideEffect: { kind: "read_only" },
            usageSource: "provider_reported",
          });
        }
        snapshots?.plan?.(planDefinition);
        if (replayCase === "invalid_digest") {
          const boundary = planDefinition.boundaries[0];
          if (boundary?.mode !== "recorded_stub") throw new Error("Expected recorded fixture");
          boundary.invocationDefinitionSha256 = "f".repeat(64);
        }
        const plan = {
          ...planDefinition,
          ...receipt,
          definitionSha256: digestReplayPlanDefinition(planDefinition),
        };
        return {
          target,
          targetReference,
          plan,
          planReference: {
            planId: plan.planId,
            planVersionId: plan.planVersionId,
            definitionSha256: plan.definitionSha256,
          },
        };
      })()
    : undefined;
  if (replay) {
    await replayRepository.publishTargetRelease(replay.target);
    await replayRepository.publishReplayPlan(replay.plan);
  }
  // The upstream evaluation fixtures were created on September 2; their source must precede them.
  let historyTime = "2026-09-01T00:00:00.000Z";
  const replayJobs = new MemoryReplayJobRepository({
    definitions: replayRepository,
    now: () => historyTime,
  });
  let replayResultReference: EvaluationRun["replay"] | undefined;
  if (replay && replayCase === "history") {
    await replayJobs.createJob({
      scope: evaluation.scope,
      jobId: "job_graph_history",
      createdByPrincipalId: "principal_graph",
      plan: replay.planReference,
    });
    historyTime = "2026-09-01T00:00:00.100Z";
    const claim = await replayJobs.claimJob({
      scope: evaluation.scope,
      jobId: "job_graph_history",
      attemptId: "attempt_graph_history",
      leaseId: "lease_graph_history",
      leaseDurationMilliseconds: 1000,
      workerId: "worker_graph_history",
      workerBuildSha256: "b".repeat(64),
      workerProtocol: replay.plan.workerProtocol,
    });
    if (!claim.claimed) throw new Error("Expected claimed graph history");
    historyTime = "2026-09-01T00:00:00.200Z";
    const completed = await replayJobs.completeJob({
      scope: evaluation.scope,
      workerFence: claim.workerFence,
      status: "succeeded",
      code: "completed",
      result: {
        artifactId: "artifact_graph_history",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        mediaType: "application/json",
        classification: "internal",
      },
    });
    const latest = completed.attempts.at(-1);
    if (!latest?.result || !latest.endedAt) throw new Error("Expected completed graph history");
    replayResultReference = {
      jobId: completed.job.jobId,
      attemptId: latest.attemptId,
      completedAt: latest.endedAt,
      plan: replay.planReference,
      targetRelease: replay.targetReference,
      result: latest.result,
      terminalCode: "completed",
      terminalStatus: "succeeded",
    };
  }
  const rewrittenHashes = new Map<string, string>();
  const bind = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const object = value as Fields;
    if (
      replayResultReference &&
      object["terminalStatus"] === "succeeded" &&
      typeof object["jobId"] === "string"
    )
      Object.assign(object, structuredClone(replayResultReference));
    if (replay && typeof object["planVersionId"] === "string")
      Object.assign(object, replay.planReference);
    if (replay && typeof object["targetReleaseId"] === "string")
      Object.assign(object, replay.targetReference);
    // Independent vectors reuse artifact names for different bytes. Give different descriptors
    // distinct fixture identities, while keeping genuinely identical occurrences shared.
    if (
      typeof object["artifactId"] === "string" &&
      typeof object["sha256"] === "string" &&
      object["artifactId"] !== replayResultReference?.result.artifactId
    ) {
      const suffix = createHash("sha256")
        .update(encodeEvaluationCanonicalJson(object))
        .digest("hex")
        .slice(0, 16);
      object["artifactId"] = `graph_${object["artifactId"]}_${suffix}`;
    }
    if (object["datasetVersionId"] === "dtv_regression_v1")
      object["definitionSha256"] = "7".repeat(64);
    if (object["fixtureVersionId"] === "fxv_boundary") object["definitionSha256"] = "2".repeat(64);
    bindDataset(object);
    const hash = object["definitionSha256"];
    if (typeof hash === "string" && rewrittenHashes.has(hash))
      object["definitionSha256"] = rewrittenHashes.get(hash);
    for (const child of Object.values(object)) bind(child);
  };
  for (const fixture of evaluation.records) {
    const oldHash = fixture.record.definitionSha256;
    bind(fixture.record);
    if (snapshots) {
      // Repository vectors exercise local records, not cross-record chronology or distinct cases.
      // Join them into an actual coherent retained snapshot before testing semantic substitutions.
      if (fixture.kind === "criterion_set") {
        for (const criterion of fixture.record.criteria) {
          const expression = criterion.applicability;
          if (expression.operator !== "allOf" || expression.operands[0]?.operator !== "equals")
            throw new Error("Expected environment applicability clause");
          expression.operands[0].value = evaluation.scope.environmentId;
        }
      }
      if (fixture.kind === "qualification_report") {
        if (qualificationPolicy)
          fixture.record.policy = {
            policyId: qualificationPolicy.policyId,
            policyVersionId: qualificationPolicy.policyVersionId,
            definitionSha256: qualificationPolicy.definitionSha256,
          };
        fixture.record.startedAt = "2026-09-02T00:00:00.000Z";
        fixture.record.completedAt = "2026-09-02T00:00:00.000Z";
        fixture.record.validFrom = "2026-09-02T00:00:00.000Z";
      }
      if (fixture.kind === "evaluation_run") {
        fixture.record.applicability.evaluatedAt = "2026-09-02T00:00:00.000Z";
        fixture.record.applicability.context.environmentId = evaluation.scope.environmentId;
        fixture.record.applicability.context.populationTags = ["adult users"];
        fixture.record.applicability.contextSha256 = createHash("sha256")
          .update(encodeEvaluationCanonicalJson(fixture.record.applicability.context))
          .digest("hex");
      }
      if (fixture.kind === "evaluation_run" && fixture.record.evaluationRunId === "evr_1")
        fixture.record.fixture.fixtureVersionId = "fxv_schema_v2";
      if (fixture.kind === "evaluation_run") bindDataset(fixture.record.fixture);
      if (fixture.kind === "raw_observation") {
        fixture.record.startedAt = "2026-09-02T00:00:01.000Z";
        fixture.record.completedAt = "2026-09-02T00:00:02.000Z";
        fixture.record.recordedAt = "2026-09-02T00:00:02.000Z";
      }
      if (fixture.kind === "evaluation_run_result") {
        fixture.record.completedAt = "2026-09-02T00:00:03.000Z";
        fixture.record.recordedAt = "2026-09-02T00:00:03.000Z";
      }
      if (fixture.kind === "evaluation_aggregate")
        fixture.record.createdAt = "2026-09-02T00:00:04.000Z";
      if (fixture.kind === "assessment") fixture.record.createdAt = "2026-09-02T00:00:05.000Z";
      snapshots.mutate?.(fixture);
    }
    const body = structuredClone(fixture.record) as unknown as Fields;
    for (const key of evaluationRecordDescriptors[fixture.kind].receiptKeys) delete body[key];
    fixture.record.definitionSha256 = digestEvaluationRecordDefinition(
      fixture.kind,
      evaluation.scope,
      body,
    );
    rewrittenHashes.set(oldHash, fixture.record.definitionSha256);
    await publishEvaluationFixture(evaluation.repository, fixture);
  }
  const assessment = evaluation.records.find((fixture) => fixture.kind === "assessment");
  const run = evaluation.records.find((fixture) => fixture.kind === "evaluation_run");
  if (assessment?.kind !== "assessment" || run?.kind !== "evaluation_run")
    throw new Error("Missing evaluation graph roots");
  const candidate = candidateDigest({
    ...releaseCandidateFixture("graph", evaluation.scope),
    assessments: [
      {
        assessmentId: assessment.record.assessmentId,
        definitionSha256: assessment.record.definitionSha256,
      },
    ],
    datasets: [run.record.dataset],
    targetRelease: run.record.replay.targetRelease,
    modelAssuranceAssessments: [],
  });
  // The standalone candidate/policy vectors contain placeholder hashes. Bind shared references to
  // the actual evaluation records before publishing this joined fixture; never rewrite the store.
  const policyDraft = releasePolicyRepositoryFixture("graph", evaluation.scope);
  for (const rule of policyDraft.rules) {
    if ("assessment" in rule.predicate && "assessmentId" in rule.predicate.assessment) {
      rule.predicate.assessment.definitionSha256 = assessment.record.definitionSha256;
      rule.predicate.assessment.assessmentId = assessment.record.assessmentId;
    }
  }
  const policy = policyDigest(policyDraft);
  const candidateRepository = new MemoryReleaseCandidateRepository();
  const policyRepository = new MemoryReleasePolicyRepository();
  await candidateRepository.publishReleaseCandidate(candidate);
  await policyRepository.publishReleasePolicy(policy);
  const missing = missingRepositories();
  const { calls } = missing;
  const repositories: PolicyRecordGraphRepositories = {
    ...missing.repositories,
    control: {
      ...missing.repositories.control,
      releaseCandidate: candidateRepository,
      releasePolicy: policyRepository,
    },
    evidence: { ...missing.repositories.evidence, evaluation: evaluation.repository },
    ...(replay ? { replayDefinitions: replayRepository } : {}),
    ...(replayResultReference ? { replayResults: replayJobs } : {}),
    ...(retainedDataset ? { datasets } : {}),
    ...(snapshots?.replayBindings
      ? { runtimeDefinitions: new StaticRuntimeDefinitionCatalogue(runtimeRecords) }
      : {}),
    ...(qualificationPolicy
      ? { qualificationPolicies: new StaticQualificationPolicyCatalogue([qualificationPolicy]) }
      : {}),
    ...(endpointProfile
      ? { endpointProfiles: new StaticEndpointProfileCatalogue([endpointProfile]) }
      : {}),
  };
  return {
    candidate,
    policy,
    repositories,
    calls,
    evaluation,
    replay,
    replayResultReference,
    input: request(candidate, policy),
    qualificationPolicy,
    endpointProfile,
  };
}

describe("request-owned record graph reinspection", () => {
  async function predecessorHarness() {
    const h = await harness();
    const repository = new MemoryComparisonRepository();
    const prior = comparisonDefinitionFixture("graph", h.input.scope);
    const successor = comparisonDefinitionFixture("graph", h.input.scope, {
      predecessor: {
        comparisonVersionId: prior.comparisonVersionId,
        definitionSha256: prior.definitionSha256,
      },
      version: "v2",
    });
    await repository.publishComparisonDefinition(prior);
    await repository.publishComparisonDefinition(successor);
    const rule = structuredClone(
      h.policy.rules.find(({ predicate }) => predicate.kind === "comparison_threshold"),
    );
    if (rule?.predicate.kind !== "comparison_threshold") throw new Error("Missing comparison rule");
    rule.predicate.comparison = {
      comparisonId: successor.comparisonId,
      comparisonVersionId: successor.comparisonVersionId,
      definitionSha256: successor.definitionSha256,
    };
    const policy = policyDigest({
      ...h.policy,
      rules: [
        rule,
        ...h.policy.rules.filter(({ predicate }) => predicate.kind === "approval_required"),
      ].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)),
    });
    const missing = missingRepositories();
    const repositories: PolicyRecordGraphRepositories = {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        comparison: repository,
        releasePolicy: { findReleasePolicy: async () => policy },
      },
    };
    return { repositories, prior, repository, input: request(h.candidate, policy) };
  }

  it.each(["created", "removed"] as const)(
    "rejects a %s comparison predecessor at its selector boundary",
    async (change) => {
      const h = await predecessorHarness();
      const original = h.repository.findComparisonDefinition.bind(h.repository);
      let missing = change === "created";
      const read = vi
        .spyOn(h.repository, "findComparisonDefinition")
        .mockImplementation(async (scope, id) =>
          missing && id === h.prior.comparisonVersionId ? null : original(scope, id),
        );
      const retained = await capturePolicyRecordGraph(h.input, h.repositories);
      const edgeIndex = retained.edges.findIndex(
        ({ reference }) => reference.path === "/predecessor",
      );
      expect(edgeIndex).toBeGreaterThanOrEqual(0);
      missing = !missing;
      read.mockClear();
      await expect(
        acquirePolicyRecordGraph(
          h.input,
          h.repositories,
          new AcquisitionBudget(h.input.limits),
          retained,
        ),
      ).rejects.toMatchObject({ reason: "source_revision_changed", identity: `edge:${edgeIndex}` });
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it("compares a selector-prefetched full receipt before expanding the selected definition", async () => {
    const h = await predecessorHarness();
    const retained = await capturePolicyRecordGraph(h.input, h.repositories);
    const original = h.repository.findComparisonDefinition.bind(h.repository);
    const read = vi
      .spyOn(h.repository, "findComparisonDefinition")
      .mockImplementation(async (scope, id) => {
        const record = await original(scope, id);
        return record && id === h.prior.comparisonVersionId
          ? { ...record, createdByPrincipalId: "changed_selector_receipt" }
          : record;
      });
    await expect(
      acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        retained,
      ),
    ).rejects.toMatchObject({
      reason: "source_revision_changed",
      identity: `comparison_definition:${h.prior.comparisonVersionId}`,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("preserves repeated edges and unresolved observations while charging the same cumulative meter", async () => {
    const h = await harness();
    const budget = new AcquisitionBudget(h.input.limits);
    const retained = await acquirePolicyRecordGraph(h.input, h.repositories, budget);
    const current = await acquirePolicyRecordGraph(h.input, h.repositories, budget, retained);
    const { usage: firstUsage, ...first } = retained;
    const { usage: secondUsage, ...second } = current;
    expect(second).toEqual(first);
    expect(retained.unresolved.records).toBeGreaterThan(0);
    expect(
      retained.edges.filter(({ target }) => target?.kind === "criterion_set").length,
    ).toBeGreaterThan(5);
    for (const key of Object.keys(firstUsage) as (keyof typeof firstUsage)[])
      expect(secondUsage[key], key).toBe(firstUsage[key] * 2);
  });

  it("rejects a changed root receipt before reading its children or the second root", async () => {
    const h = await harness();
    const retained = await capturePolicyRecordGraph(h.input, h.repositories);
    const policy = vi.spyOn(h.repositories.control.releasePolicy, "findReleasePolicy");
    const assessment = vi.spyOn(h.repositories.evidence.evaluation, "findAssessment");
    vi.spyOn(h.repositories.control.releaseCandidate, "findReleaseCandidate").mockResolvedValue({
      ...h.candidate,
      createdAt: "2026-09-03T00:00:00.000Z",
    });
    await expect(
      acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        retained,
      ),
    ).rejects.toMatchObject({
      code: "policy_captured_observation_recheck_failed",
      reason: "source_revision_changed",
    });
    expect(policy).not.toHaveBeenCalled();
    expect(assessment).not.toHaveBeenCalled();
  });

  it("rejects creation of a formerly missing valid dataset before traversing its fixture members", async () => {
    const h = await harness(undefined, { dataset: "matched" });
    const dataset = vi.spyOn(h.repositories.datasets, "findDatasetVersion").mockResolvedValue(null);
    const retained = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(
      retained.nodes.find(({ read }) => read.source.kind === "dataset_version")?.read.observation
        .status,
    ).toBe("missing");
    dataset.mockRestore();
    const fixture = vi.spyOn(h.repositories.datasets, "findFixtureVersion");
    await expect(
      acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        retained,
      ),
    ).rejects.toMatchObject({
      reason: "source_revision_changed",
      identity: expect.stringContaining("dataset_version"),
    });
    expect(fixture).not.toHaveBeenCalled();
  });

  it.each(["missing", "not_yet_available"] as const)(
    "rejects a formerly %s criterion at its earlier exact-read boundary",
    async (state) => {
      const h = await harness();
      const evaluation = h.repositories.evidence.evaluation;
      const original = evaluation.findCriterionSet.bind(evaluation);
      const criterion = vi
        .spyOn(evaluation, "findCriterionSet")
        .mockImplementation(async (...args) => {
          const record = await original(...args);
          return state === "missing"
            ? null
            : record && { ...record, publishedAt: "2027-01-01T00:00:00.000Z" };
        });
      const retained = await capturePolicyRecordGraph(h.input, h.repositories);
      expect(retained.edges.some(({ selectorFailure }) => selectorFailure !== undefined)).toBe(
        true,
      );
      criterion.mockRestore();
      await expect(
        acquirePolicyRecordGraph(
          h.input,
          h.repositories,
          new AcquisitionBudget(h.input.limits),
          retained,
        ),
      ).rejects.toMatchObject({
        reason: "source_revision_changed",
        identity: "criterion_set:csv_response_v1",
      });
    },
  );

  it("rejects a disappeared criterion at its earlier exact-read boundary", async () => {
    const h = await harness();
    const retained = await capturePolicyRecordGraph(h.input, h.repositories);
    vi.spyOn(h.repositories.evidence.evaluation, "findCriterionSet").mockResolvedValue(null);
    await expect(
      acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        retained,
      ),
    ).rejects.toMatchObject({
      reason: "source_revision_changed",
      identity: "criterion_set:csv_response_v1",
    });
  });

  it("rejects a changed criterion receipt even when its definition is unchanged", async () => {
    const h = await harness();
    const retained = await capturePolicyRecordGraph(h.input, h.repositories);
    const evaluation = h.repositories.evidence.evaluation;
    const original = evaluation.findCriterionSet.bind(evaluation);
    vi.spyOn(evaluation, "findCriterionSet").mockImplementation(async (...args) => {
      const record = await original(...args);
      return record && { ...record, publishedByPrincipalId: "principal_changed_receipt" };
    });
    await expect(
      acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        retained,
      ),
    ).rejects.toMatchObject({
      reason: "source_revision_changed",
      identity: expect.stringContaining("criterion_set"),
    });
  });

  it("keeps cumulative record limit failures distinct from revision changes", async () => {
    const h = await harness();
    const input = request(h.candidate, h.policy, {
      ...h.input.limits,
      maxAcquisitionRecords: 2,
    });
    const repositories = missingRepositories().repositories;
    const budget = new AcquisitionBudget(input.limits);
    const retained = await acquirePolicyRecordGraph(input, repositories, budget);
    await expect(
      acquirePolicyRecordGraph(input, repositories, budget, retained),
    ).rejects.toMatchObject({ code: "policy_record_graph_failed", reason: "record_limit" });
  });

  it("propagates owning repository failures without reporting a revision change", async () => {
    const h = await harness();
    const retained = await capturePolicyRecordGraph(h.input, h.repositories);
    const failure = new Error("candidate storage unavailable");
    vi.spyOn(h.repositories.control.releaseCandidate, "findReleaseCandidate").mockRejectedValue(
      failure,
    );
    await expect(
      acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        retained,
      ),
    ).rejects.toBe(failure);
  });

  it.each(["request", "duplicate_node", "missing_node", "extra_edge", "derived_binding"] as const)(
    "rejects inconsistent retained %s material",
    async (change) => {
      const h = await harness();
      const retained = await capturePolicyRecordGraph(h.input, h.repositories);
      if (change === "request")
        Reflect.set(retained, "scope", { ...retained.scope, projectId: "other_project" });
      if (change === "duplicate_node")
        Reflect.set(retained, "nodes", [...retained.nodes, retained.nodes[0]]);
      if (change === "missing_node") Reflect.set(retained, "nodes", retained.nodes.slice(1));
      if (change === "extra_edge")
        Reflect.set(retained, "edges", [...retained.edges, retained.edges[0]]);
      if (change === "derived_binding")
        Reflect.set(retained, "unresolved", { records: 0, references: 0 });
      await expect(
        acquirePolicyRecordGraph(
          h.input,
          h.repositories,
          new AcquisitionBudget(h.input.limits),
          retained,
        ),
      ).rejects.toMatchObject({ reason: "source_revision_changed" });
    },
  );
});

describe("independent retained record closure", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4 * 1024 * 1024 };
  type Graph = Awaited<ReturnType<typeof capturePolicyRecordGraph>>;
  const editable = (graph: Graph) => ({
    roots: structuredClone([...graph.roots]),
    nodes: structuredClone([...graph.nodes]),
    edges: structuredClone([...graph.edges]),
  });
  type Editable = ReturnType<typeof editable>;
  const first = <T>(values: readonly T[], predicate: (value: T) => boolean): T => {
    const found = values.find(predicate);
    if (!found) throw new Error("Missing closure test observation");
    return found;
  };
  const root = (graph: Editable) =>
    first(graph.nodes, ({ read }) => read.source.kind === "release_candidate");
  const missing = (graph: Editable) =>
    first(graph.nodes, ({ read }) => read.observation.status === "missing");
  const selected = (graph: Editable) =>
    first(
      graph.edges,
      ({ reference, target }) => reference.kind === "criterion_selector" && target !== null,
    );
  const direct = (graph: Editable) =>
    first(graph.edges, ({ reference }) => reference.kind === "record");
  const artifact = (graph: Editable) =>
    first(graph.edges, ({ reference }) => reference.kind === "artifact");
  const reorder = (graph: Editable) =>
    graph.nodes.sort((a, b) => {
      const left = policyEvaluationSourceReferenceKey(a.read.source);
      const right = policyEvaluationSourceReferenceKey(b.read.source);
      return left < right ? -1 : left > right ? 1 : 0;
    });

  it("derives the request inventory from owning bodies with repeated edges, cycles and distinct frontiers", async () => {
    const setup = await harness("history", { dataset: "matched", replayBindings: true });
    const read = vi.spyOn(setup.repositories.evidence.evaluation, "findCriterionSet");
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const calls = read.mock.calls.length;
    const original = structuredClone(graph);
    const derived = deriveCapturedRecordClosure(setup.input, graph, limits);
    expect(derived.entries).toEqual(graph.entries);
    expect(derived.closure).toEqual(graph.recordClosure);
    expect(graph.recordClosure.sources).toContainEqual({
      kind: "release_candidate",
      reference: setup.input.candidate,
    });
    expect(graph.recordClosure.sources).toContainEqual({
      kind: "release_policy",
      reference: setup.input.policy,
    });
    expect(graph.recordClosure.sources.filter(({ kind }) => kind === "criterion_set")).toHaveLength(
      1,
    );
    expect(
      graph.edges.filter(({ target }) => target?.kind === "criterion_set").length,
    ).toBeGreaterThan(5);
    expect(derived.closure.frontier.map(({ edgeIndex }) => edgeIndex)).toEqual(
      graph.edges.flatMap(({ target, reference }, index) =>
        target === null ||
        reference.kind === "qualification_policy" ||
        reference.kind === "registered_implementation"
          ? [index]
          : [],
      ),
    );
    expect(new Set(derived.closure.frontier.map(({ kind }) => kind))).toEqual(
      new Set(["artifact", "trace", "retained_declaration"]),
    );
    expect(derived.entries.some(({ observation }) => observation.status === "missing")).toBe(true);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(graph).toEqual(original);
    const source = derived.closure.sources.find((value) => value.kind === "release_candidate");
    if (source?.kind !== "release_candidate") throw new Error("Missing derived root");
    source.reference.candidateVersionId = "candidate_mutated_after_derivation";
    expect(graph).toEqual(original);
    expect(derived.closure).not.toHaveProperty("sealed");
    expect(derived.closure).not.toHaveProperty("authority");
  });

  it("derives both unavailable roots without claiming a verified empty graph", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, missingRepositories().repositories);
    const derived = deriveCapturedRecordClosure(setup.input, graph, {
      maxReferences: 0,
      maxReferenceBytes: 0,
    });
    expect(derived.entries).toHaveLength(2);
    expect(derived.entries.every(({ observation }) => observation.status === "missing")).toBe(true);
    expect(derived.closure).toMatchObject({
      frontier: [],
      inspectionUsage: { references: 0, referenceBytes: 0 },
    });
  });

  it("rejects a self-consistent manifest subset against the separately derived source inventory", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const assemble = (entries: Graph["entries"]) =>
      assemblePolicyEvaluationManifest({
        entries: [...entries],
        manifestId: "manifest_closure",
        request: graph.request,
        scope: graph.scope,
      });
    const verify = (pageSet: ReturnType<typeof assemble>) =>
      validatePolicyEvaluationManifest({
        pageSet,
        expected: {
          manifest: {
            manifestId: pageSet.manifest.manifestId,
            definitionSha256: pageSet.manifest.definitionSha256,
          },
          request: graph.request,
          scope: graph.scope,
          sources: [...graph.recordClosure.sources],
        },
      });
    const complete = assemble(graph.entries);
    expect(verify(complete)).toEqual(complete);
    const subset = assemble(graph.entries.slice(1));
    expect(() => verify(subset)).toThrow(
      expect.objectContaining({ code: "source_closure_mismatch" }),
    );
  });

  it("rejects a selector absence contradicting a retained verified exact child before trace I/O", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    let reads = 0;
    const repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, property) {
            if (property === "findCriterionSet")
              return async (...args: Parameters<typeof original.findCriterionSet>) => {
                reads++;
                return reads === 1 ? original.findCriterionSet(...args) : null;
              };
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    const evidence = { resolveExactEvents: vi.fn(async () => []) };
    await expect(
      capturePolicyTraceEvidence(setup.input, repositories, evidence),
    ).rejects.toMatchObject({ reason: "observation_conflict" });
    expect(reads).toBeGreaterThan(1);
    expect(evidence.resolveExactEvents).not.toHaveBeenCalled();
  });

  it("preserves a genuine selector membership mismatch when its independently reached set is available", async () => {
    const setup = await harness(undefined, {
      mutate: ({ kind, record }) => {
        if (kind === "oracle_spec") {
          const criterion = record.supportedCriteria[0];
          if (!criterion) throw new Error("Missing oracle selector");
          criterion.criterionId = "criterion_unrelated";
        }
      },
    });
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const edge = graph.edges.find(
      ({ parent, reference }) =>
        parent.kind === "oracle_spec" && reference.kind === "criterion_selector",
    );
    expect(edge).toMatchObject({
      target: null,
      selectorFailure: { status: "unavailable", reason: "lineage_mismatch" },
    });
    expect(
      graph.nodes.find(({ read }) => read.source.kind === "criterion_set")?.read.observation.status,
    ).toBe("verified");
    expect(deriveCapturedRecordClosure(setup.input, graph, limits).closure).toEqual(
      graph.recordClosure,
    );
  });

  it.each(["missing", "not_yet_available"] as const)(
    "preserves %s selector observations without inventing sources",
    async (state) => {
      const setup = await harness();
      const original = setup.repositories.evidence.evaluation;
      const graph = await capturePolicyRecordGraph(setup.input, {
        ...setup.repositories,
        evidence: {
          ...setup.repositories.evidence,
          evaluation: new Proxy(original, {
            get(target, property) {
              if (property === "findCriterionSet")
                return async (...args: Parameters<typeof original.findCriterionSet>) => {
                  const record = await original.findCriterionSet(...args);
                  return state === "missing"
                    ? null
                    : record && { ...record, publishedAt: "2027-01-01T00:00:00.000Z" };
                };
              const value: unknown = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        },
      });
      const derived = deriveCapturedRecordClosure(setup.input, graph, limits);
      const frontier = derived.closure.frontier.filter(
        ({ kind }) => kind === "unresolved_selector",
      );
      expect(frontier.length).toBeGreaterThan(5);
      for (const { edgeIndex } of frontier)
        expect(graph.edges[edgeIndex]).toMatchObject({
          target: null,
          selectorFailure:
            state === "missing" ? { status: "missing" } : { status: "unavailable", reason: state },
        });
      const altered = editable(graph);
      const edge = first(altered.edges, (value) => value.selectorFailure !== undefined);
      Reflect.set(edge, "selectorFailure", { status: "unavailable", reason: "invented" });
      expect(() => deriveCapturedRecordClosure(setup.input, altered, limits)).toThrow();
      Reflect.set(edge, "selectorFailure", { status: "missing", reason: "extra" });
      expect(() => deriveCapturedRecordClosure(setup.input, altered, limits)).toThrow();
      Reflect.deleteProperty(edge, "selectorFailure");
      expect(() => deriveCapturedRecordClosure(setup.input, altered, limits)).toThrow();
    },
  );

  const attacks: readonly [string, (graph: Editable) => void][] = [
    [
      "different root order",
      (g) => {
        g.roots.reverse();
      },
    ],
    [
      "omitted root",
      (g) => {
        g.roots.pop();
      },
    ],
    [
      "caller-added root",
      (g) => {
        g.roots.push(g.roots[0] as Graph["roots"][number]);
      },
    ],
    [
      "omitted reachable node",
      (g) => {
        g.nodes.splice(0, 1);
      },
    ],
    [
      "duplicate node",
      (g) => {
        g.nodes.push(g.nodes[0] as Graph["nodes"][number]);
        reorder(g);
      },
    ],
    [
      "changed canonical node order",
      (g) => {
        g.nodes.reverse();
      },
    ],
    [
      "orphan node",
      (g) => {
        const source = {
          kind: "release_candidate" as const,
          reference: {
            candidateId: "orphan",
            candidateVersionId: "orphan_v1",
            definitionSha256: "a".repeat(64),
          },
        };
        g.nodes.push({
          read: { source, observation: { status: "missing" }, record: null },
          references: null,
        });
        reorder(g);
      },
    ],
    [
      "changed semantic body",
      (g) => {
        Reflect.set(root(g).read.record as object, "candidateId", "candidate_substituted");
      },
    ],
    [
      "changed original receipt",
      (g) => {
        Reflect.set(root(g).read.record as object, "createdAt", "2026-09-04T00:00:00.000Z");
      },
    ],
    [
      "changed original observation",
      (g) => {
        Reflect.set(root(g).read.observation, "recordSha256", "f".repeat(64));
      },
    ],
    [
      "verified parent with no reference inventory",
      (g) => {
        Reflect.set(root(g), "references", null);
      },
    ],
    [
      "reference and matching edge removed together",
      (g) => {
        const node = root(g);
        Reflect.set(node, "references", node.references?.slice(1));
        g.edges.splice(0, 1);
      },
    ],
    [
      "missing parent relabeled as empty leaf",
      (g) => {
        Reflect.set(missing(g), "references", []);
      },
    ],
    [
      "missing parent retaining a body",
      (g) => {
        Reflect.set(missing(g).read, "record", {});
      },
    ],
    [
      "invalid observation status",
      (g) => {
        Reflect.set(missing(g).read, "observation", { status: "approved" });
      },
    ],
    [
      "extra node field",
      (g) => {
        Reflect.set(root(g), "complete", true);
      },
    ],
    [
      "extra read field",
      (g) => {
        Reflect.set(root(g).read, "complete", true);
      },
    ],
    [
      "extra edge field",
      (g) => {
        Reflect.set(direct(g), "complete", true);
      },
    ],
    [
      "omitted edge",
      (g) => {
        g.edges.splice(0, 1);
      },
    ],
    [
      "duplicate trailing edge",
      (g) => {
        g.edges.push(g.edges[0] as Graph["edges"][number]);
      },
    ],
    [
      "changed edge order",
      (g) => {
        g.edges.reverse();
      },
    ],
    [
      "changed edge parent",
      (g) => {
        Reflect.set(direct(g), "parent", g.roots[1]);
      },
    ],
    [
      "changed edge parent hash",
      (g) => {
        Reflect.set(direct(g), "parentRecordSha256", "f".repeat(64));
      },
    ],
    [
      "changed occurrence path",
      (g) => {
        Reflect.set(direct(g).reference, "path", "/invented");
      },
    ],
    [
      "direct edge with null target",
      (g) => {
        Reflect.set(direct(g), "target", null);
      },
    ],
    [
      "direct edge with selector failure",
      (g) => {
        Reflect.set(direct(g), "selectorFailure", { status: "missing" });
      },
    ],
    [
      "resolved selector with failure",
      (g) => {
        Reflect.set(selected(g), "selectorFailure", { status: "missing" });
      },
    ],
    [
      "resolved selector with substituted target",
      (g) => {
        Reflect.set(selected(g), "target", g.roots[0]);
      },
    ],
    [
      "resolved selector relabeled missing",
      (g) => {
        const edge = selected(g);
        Reflect.set(edge, "target", null);
        Reflect.set(edge, "selectorFailure", { status: "missing" });
      },
    ],
    [
      "artifact converted into a record target",
      (g) => {
        Reflect.set(artifact(g), "target", g.roots[0]);
      },
    ],
    [
      "artifact with selector failure",
      (g) => {
        Reflect.set(artifact(g), "selectorFailure", { status: "missing" });
      },
    ],
  ];
  it.each(attacks)("rejects %s independently of the supplied inventory", async (_label, attack) => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const altered = editable(graph);
    attack(altered);
    expect(() => deriveCapturedRecordClosure(setup.input, altered, limits)).toThrow();
  });

  it("retains parent-owned declarations and cannot turn an omitted identity into an artifact lookup", async () => {
    const setup = await harness("history", { dataset: "matched", replayBindings: true });
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const declarations = graph.recordClosure.frontier.filter(
      ({ kind }) => kind === "retained_declaration",
    );
    expect(declarations.length).toBeGreaterThan(0);
    const declarationKinds = declarations.map(
      ({ edgeIndex }) => graph.edges[edgeIndex]?.reference.kind,
    );
    expect(declarationKinds).toContain("registered_implementation");
    expect(declarationKinds).toContain("qualification_policy");
    expect(declarationKinds).toContain("replay_declaration");
    expect(declarationKinds).toContain("control_declaration");
    const altered = editable(graph);
    const edge = altered.edges[declarations[0]?.edgeIndex ?? -1];
    if (!edge) throw new Error("Missing declaration");
    Reflect.set(edge, "target", altered.roots[0]);
    expect(() => deriveCapturedRecordClosure(setup.input, altered, limits)).toThrow();
  });

  it("uses independent repeated occurrence counts and canonical bytes for exact and one-below admission", async () => {
    const setup = await harness("history", { dataset: "matched", replayBindings: true });
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const exact = {
      maxReferences: graph.edges.length,
      maxReferenceBytes: graph.edges.reduce(
        (sum, edge) => sum + encodeEvaluationCanonicalJson(edge.reference).byteLength,
        0,
      ),
    };
    expect(deriveCapturedRecordClosure(setup.input, graph, exact).closure.inspectionUsage).toEqual({
      references: exact.maxReferences,
      referenceBytes: exact.maxReferenceBytes,
    });
    expect(() =>
      deriveCapturedRecordClosure(setup.input, graph, {
        ...exact,
        maxReferences: exact.maxReferences - 1,
      }),
    ).toThrow();
    expect(() =>
      deriveCapturedRecordClosure(setup.input, graph, {
        ...exact,
        maxReferenceBytes: exact.maxReferenceBytes - 1,
      }),
    ).toThrow();
    expect(() =>
      deriveCapturedRecordClosure(setup.input, graph, { ...exact, maxReferences: -1 }),
    ).toThrow();
    expect(() =>
      deriveCapturedRecordClosure(
        { ...setup.input, definitionSha256: "f".repeat(64) },
        graph,
        exact,
      ),
    ).toThrow();
  });
});

describe("evaluation run replay bindings", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4 * 1024 * 1024 };
  const setup = () => harness("history", { dataset: "matched", replayBindings: true });
  const statuses = (graph: Awaited<ReturnType<typeof capturePolicyRecordGraph>>, kind: string) =>
    graph.evaluationReplays.parents.map(
      (parent) => parent.checks.find((check) => check.kind === kind)?.observation.status,
    );

  it("joins exact plan and result prerequisites while allowing distinct fixtures to share a plan", async () => {
    const h = await setup();
    const planRead = vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan");
    const resultRead = vi.spyOn(h.repositories.replayResults, "findJob");
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const report = graph.evaluationReplays;
    expect(report.parents).toHaveLength(2);
    expect(report.unavailableParents).toEqual([]);
    expect(
      report.parents.flatMap((parent) => parent.checks).map((check) => check.observation.status),
    ).toEqual(Array(10).fill("matched"));
    const runs = h.evaluation.records.filter((record) => record.kind === "evaluation_run");
    expect(new Set(runs.map(({ record }) => record.fixture.fixtureVersionId)).size).toBe(2);
    expect(new Set(runs.map(({ record }) => record.replay.plan.planVersionId)).size).toBe(1);
    expect(planRead).toHaveBeenCalledTimes(1);
    expect(resultRead).toHaveBeenCalledTimes(1);
    expect(report.inspectionUsage.references).toBe(12);
    for (const parent of report.parents) {
      expect(graph.entries).toContainEqual({
        source: parent.source,
        observation: { status: "verified", recordSha256: parent.recordSha256 },
      });
      expect(parent.dependencyEdgeIndexes).toHaveLength(6);
      expect(
        parent.dependencyEdgeIndexes.filter(
          (index) => graph.edges[index]?.parent.kind === "replay_plan",
        ),
      ).toHaveLength(2);
    }
    const reordered = inspectCapturedEvaluationReplayBindings(
      { ...graph, nodes: [...graph.nodes].reverse() },
      limits,
    );
    expect(reordered).toEqual(report);
    const before = structuredClone(graph);
    const first = reordered.parents[0];
    if (!first) throw new Error("Missing run report");
    first.source.reference.definitionSha256 = "f".repeat(64);
    expect(graph).toEqual(before);
    expect(report).not.toHaveProperty("sealed");
    expect(report).not.toHaveProperty("eligible");
  });

  it.each(["dataset", "target", "receipt"] as const)(
    "retains a known plan %s mismatch independently of unavailable evidence",
    async (kind) => {
      const h = await harness("history", {
        dataset: "matched",
        replayBindings: true,
        plan: (plan) => {
          if (kind === "dataset") plan.dataset.datasetVersionId = "dataset_foreign";
        },
        mutate: ({ kind: recordKind, record }) => {
          if (kind === "target" && recordKind === "evaluation_run") {
            record.replay.targetRelease.targetId = "target_foreign";
            record.replay.targetRelease.targetReleaseId = "target_foreign_v1";
          }
        },
      });
      if (kind === "receipt") {
        if (!h.replay) throw new Error("Missing plan");
        vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockResolvedValue({
          ...h.replay.plan,
          createdAt: "2026-09-01T00:00:00.201Z",
        });
      }
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      expect(statuses(graph, `plan_${kind}`)).toEqual(["mismatch", "mismatch"]);
      if (kind === "dataset")
        expect(statuses(graph, "plan_prerequisites")).toEqual(["unavailable", "unavailable"]);
      if (kind === "target")
        expect(statuses(graph, "result_history")).toEqual(["unavailable", "unavailable"]);
      if (kind === "receipt")
        expect(statuses(graph, "result_history")).toEqual(["mismatch", "mismatch"]);
    },
  );

  it.each([
    ["2026-09-01T00:00:00.199999Z", "mismatch"],
    ["2026-09-01T00:00:00.200000Z", "matched"],
    ["2026-09-01T00:00:00.200001Z", "matched"],
  ] as const)("preserves the exact plan receipt boundary at %s", async (completedAt, expected) => {
    const h = await harness("history", {
      dataset: "matched",
      replayBindings: true,
      mutate: ({ kind, record }) => {
        if (kind === "evaluation_run") record.replay.completedAt = completedAt;
      },
    });
    if (!h.replay) throw new Error("Missing plan");
    vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockResolvedValue({
      ...h.replay.plan,
      createdAt: "2026-09-01T00:00:00.200Z",
    });
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(statuses(graph, "plan_receipt")).toEqual([expected, expected]);
  });

  it.each(["plan", "result", "runtime", "isolation", "dataset"] as const)(
    "preserves the missing %s prerequisite",
    async (kind) => {
      const h = await setup();
      if (kind === "plan")
        vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockResolvedValue(null);
      if (kind === "result")
        vi.spyOn(h.repositories.replayResults, "findJob").mockResolvedValue(null);
      if (kind === "runtime")
        vi.spyOn(h.repositories.runtimeDefinitions, "findRuntimeProfile").mockResolvedValue(null);
      if (kind === "isolation")
        vi.spyOn(h.repositories.runtimeDefinitions, "findIsolationProfile").mockResolvedValue(null);
      if (kind === "dataset")
        vi.spyOn(h.repositories.datasets, "findDatasetVersion").mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const affected = kind === "result" ? "result_history" : "plan_prerequisites";
      expect(statuses(graph, affected)).toEqual(["unavailable", "unavailable"]);
      expect(statuses(graph, "plan_dataset")).toEqual(
        Array(2).fill(kind === "plan" ? "unavailable" : "matched"),
      );
      if (kind === "plan")
        expect(statuses(graph, "result_history")).toEqual(["unavailable", "unavailable"]);
    },
  );

  it("does not hide a known boundary contradiction behind an unavailable runtime", async () => {
    const h = await harness("history", {
      dataset: "matched",
      replayBindings: true,
      plan: (plan) => {
        const boundary = plan.boundaries[0];
        if (boundary) boundary.kind = "data";
      },
    });
    vi.spyOn(h.repositories.runtimeDefinitions, "findRuntimeProfile").mockResolvedValue(null);
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(statuses(graph, "plan_prerequisites")).toEqual(["mismatch", "mismatch"]);
    expect(statuses(graph, "plan_dataset")).toEqual(["matched", "matched"]);
  });

  it("preserves missing evaluation parents and an actually empty run inventory", async () => {
    const h = await setup();
    vi.spyOn(h.repositories.evidence.evaluation, "findEvaluationRun").mockResolvedValue(null);
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(graph.evaluationReplays.parents).toEqual([]);
    expect(graph.evaluationReplays.unavailableParents).toHaveLength(2);
    expect(
      graph.evaluationReplays.unavailableParents.every(
        (parent) => parent.observation.status === "missing",
      ),
    ).toBe(true);
    expect(graph.evaluationReplays.inspectionUsage).toEqual({ references: 0, referenceBytes: 0 });
    expect(
      inspectCapturedEvaluationReplayBindings(
        {
          nodes: [],
          edges: [],
          replayPlans: {
            plans: [],
            unavailablePlans: [],
            inspectionUsage: { references: 0, referenceBytes: 0 },
          },
          replayResults: { results: [], unavailableResults: [] },
        },
        { maxReferences: 0, maxReferenceBytes: 0 },
      ),
    ).toEqual({
      parents: [],
      unavailableParents: [],
      inspectionUsage: { references: 0, referenceBytes: 0 },
    });
  });

  it("admits repeated shared-plan traversal at exact limits and rejects one below", async () => {
    const h = await setup();
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const usage = graph.evaluationReplays.inspectionUsage;
    const exact = { maxReferences: usage.references, maxReferenceBytes: usage.referenceBytes };
    expect(inspectCapturedEvaluationReplayBindings(graph, exact)).toEqual(graph.evaluationReplays);
    expect(() =>
      inspectCapturedEvaluationReplayBindings(graph, {
        ...exact,
        maxReferences: exact.maxReferences - 1,
      }),
    ).toThrow();
    expect(() =>
      inspectCapturedEvaluationReplayBindings(graph, {
        ...exact,
        maxReferenceBytes: exact.maxReferenceBytes - 1,
      }),
    ).toThrow();
  });

  it.each([
    "edge_missing",
    "edge_duplicate",
    "parent_hash",
    "parent_source",
    "reference",
    "reference_kind",
    "target",
    "selector_failure",
    "node_missing",
    "node_source",
    "plan_report_missing",
    "plan_report_hash",
    "plan_report_empty",
    "plan_report_source",
    "result_report_missing",
    "result_report_hash",
    "result_report_empty",
    "result_report_source",
    "result_plan",
    "result_plan_observation",
  ] as const)("rejects broken retained provenance: %s", async (kind) => {
    const h = await setup();
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const changed = {
      ...structuredClone(graph),
      edges: [...graph.edges],
      nodes: [...structuredClone(graph.nodes)],
    };
    const index = changed.edges.findIndex(
      (edge) => edge.parent.kind === "evaluation_run" && edge.reference.path === "/replay/plan",
    );
    const edge = changed.edges[index];
    if (edge?.reference.kind !== "record") throw new Error("Missing original plan edge");
    if (edge.parent.kind !== "evaluation_run") throw new Error("Missing run parent");
    if (kind === "edge_missing") changed.edges.splice(index, 1);
    if (kind === "edge_duplicate") changed.edges.push(edge);
    if (kind === "parent_hash")
      changed.edges[index] = { ...edge, parentRecordSha256: "f".repeat(64) };
    if (kind === "parent_source")
      changed.edges[index] = {
        ...edge,
        parent: {
          ...edge.parent,
          reference: { ...edge.parent.reference, definitionSha256: "f".repeat(64) },
        },
      };
    if (kind === "reference_kind") {
      if (!h.replayResultReference) throw new Error("Missing result reference");
      changed.edges[index] = {
        ...edge,
        reference: {
          kind: "artifact",
          path: edge.reference.path,
          reference: h.replayResultReference.result,
        },
      };
    }
    if (kind === "reference")
      changed.edges[index] = {
        ...edge,
        reference: { ...edge.reference, source: graph.roots[0] as typeof edge.reference.source },
      };
    if (kind === "target") changed.edges[index] = { ...edge, target: null };
    if (kind === "selector_failure")
      changed.edges[index] = { ...edge, selectorFailure: { status: "missing" } };
    if (kind === "node_missing")
      changed.nodes = changed.nodes.filter(({ read }) => read.source.kind !== "replay_plan");
    if (kind === "node_source")
      for (const node of changed.nodes)
        if (node.read.source.kind === "replay_plan")
          node.read.source.reference.definitionSha256 = "f".repeat(64);
    if (kind.startsWith("plan_report_"))
      changed.replayPlans = {
        ...graph.replayPlans,
        plans:
          kind === "plan_report_missing"
            ? []
            : graph.replayPlans.plans.map((report) => ({
                ...report,
                ...(kind === "plan_report_hash"
                  ? { recordSha256: "f".repeat(64) }
                  : kind === "plan_report_source"
                    ? {
                        source: {
                          ...report.source,
                          reference: {
                            ...report.source.reference,
                            definitionSha256: "f".repeat(64),
                          },
                        },
                      }
                    : { checks: [] }),
              })),
      };
    if (kind.startsWith("result_report_"))
      changed.replayResults = {
        ...graph.replayResults,
        results:
          kind === "result_report_missing"
            ? []
            : graph.replayResults.results.map((report) => ({
                ...report,
                ...(kind === "result_report_hash"
                  ? { recordSha256: "f".repeat(64) }
                  : kind === "result_report_source"
                    ? {
                        source: {
                          ...report.source,
                          reference: {
                            ...report.source.reference,
                            completedAt: "2026-09-01T00:00:00.200001Z",
                          },
                        },
                      }
                    : { checks: [] }),
              })),
      };
    if (kind === "result_plan" || kind === "result_plan_observation")
      changed.replayResults = {
        ...graph.replayResults,
        results: graph.replayResults.results.map((report) => ({
          ...report,
          plan: {
            ...report.plan,
            ...(kind === "result_plan"
              ? {
                  source: {
                    ...report.plan.source,
                    reference: {
                      ...report.plan.source.reference,
                      definitionSha256: "f".repeat(64),
                    },
                  },
                }
              : { recordObservation: { status: "missing" as const } }),
          },
        })),
      };
    expect(() => inspectCapturedEvaluationReplayBindings(changed, limits)).toThrow(
      expect.objectContaining({ reason: "reference_conflict" }),
    );
  });
});

describe("retained evaluation snapshots in the acquired graph", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4 * 1024 * 1024 };
  it.each([
    ["context_digest", "run_applicability_context"],
    ["context_scope", "run_applicability_context"],
    ["applicability_result", "run_applicability_result"],
    ["applicability_unknown", "run_applicability_result"],
    ["criterion_missing", "run_criterion"],
    ["criterion_evaluator", "run_criterion_reference"],
    ["criterion_oracle", "run_criterion_reference"],
    ["criterion_receipt", "run_criterion_receipt"],
    ["status_draft", "run_status"],
    ["status_expired", "run_status"],
    ["status_future", "run_status"],
    ["aggregation_dataset", "run_aggregation"],
    ["evaluator_support", "run_specification"],
    ["oracle_support", "run_specification"],
    ["evaluator_oracle", "run_specification"],
    ["evaluator_budget", "run_budget"],
    ["oracle_budget", "run_budget"],
    ["qualification_subject", "run_qualification_subject"],
    ["qualification_fixture_set", "run_qualification_fixture_set"],
    ["qualification_case", "run_qualification_cases"],
    ["qualification_extra_case", "run_qualification_cases"],
    ["qualification_expected", "run_qualification_cases"],
    ["qualification_fixture", "run_qualification_coverage"],
    ["qualification_criterion", "run_qualification_coverage"],
    ["qualification_outcome", "run_qualification_outcome"],
    ["qualification_window", "run_qualification_window"],
    ["qualification_receipts", "run_qualification_receipts"],
  ])(
    "rejects or preserves a retained run-definition contradiction: %s",
    async (mutation, expected) => {
      const h = await harness(undefined, {
        mutate: (fixture) => {
          const { kind, record } = fixture;
          if (kind === "evaluation_run") {
            if (mutation === "context_digest") record.applicability.contextSha256 = "0".repeat(64);
            if (mutation === "context_scope")
              record.applicability.context.environmentId = "env_other";
            if (mutation === "applicability_result")
              record.applicability.context.populationTags = [];
            if (mutation === "applicability_unknown") delete record.applicability.context.locale;
            if (
              ["context_scope", "applicability_result", "applicability_unknown"].includes(mutation)
            )
              record.applicability.contextSha256 = createHash("sha256")
                .update(encodeEvaluationCanonicalJson(record.applicability.context))
                .digest("hex");
            if (mutation === "criterion_missing") record.criterion.criterionId = "crt_missing";
            if (mutation === "criterion_receipt")
              record.applicability.evaluatedAt =
                "2026-09-01T23:59:59.999999999999999999999999999999Z";
            if (mutation === "qualification_subject")
              record.evaluatorQualification = structuredClone(record.oracleQualification);
          }
          if (kind === "criterion_set") {
            const criterion = record.criteria[0];
            if (!criterion) throw new Error("Missing criterion");
            if (mutation === "criterion_evaluator") criterion.evaluator.evaluatorId = "evl_other";
            if (mutation === "criterion_oracle") criterion.oracle.oracleId = "orc_other";
          }
          if (kind === "criterion_set_status" && record.status === "approved") {
            if (mutation === "status_draft") {
              record.status = "draft";
              delete record.previousStatus;
            }
            if (mutation === "status_expired") record.expiresAt = "2026-09-02T00:00:00.000Z";
            if (mutation === "status_future")
              record.effectiveAt = "2026-09-02T00:00:00.000000000000000000000000000001Z";
          }
          if (kind === "aggregation_policy" && mutation === "aggregation_dataset")
            record.dataset.datasetVersionId = "dtv_other";
          if (kind === "evaluator_spec") {
            const supported = record.supportedCriteria[0];
            const oracle = record.oracles[0];
            if (!supported || !oracle) throw new Error("Missing specification prerequisites");
            if (mutation === "evaluator_support") supported.criterionId = "crt_other";
            if (mutation === "evaluator_oracle") oracle.oracleId = "orc_other";
            if (mutation === "evaluator_budget") record.budgets.inputBytes--;
          }
          if (kind === "oracle_spec") {
            const supported = record.supportedCriteria[0];
            if (!supported) throw new Error("Missing supported criterion");
            if (mutation === "oracle_support") supported.criterionId = "crt_other";
            if (mutation === "oracle_budget") record.budgets.memoryBytes--;
          }
          if (kind === "qualification_fixture_set") {
            const boundary = record.cases.find((c) => c.caseKind === "boundary");
            if (!boundary) throw new Error("Missing boundary case");
            if (mutation === "qualification_fixture")
              boundary.fixture.fixtureVersionId = "fxv_other";
            if (mutation === "qualification_criterion")
              boundary.criterion.criterionId = "crt_other";
          }
          if (kind === "qualification_report" && record.subject.kind === "evaluator") {
            if (mutation === "qualification_fixture_set")
              record.fixtureSet.fixtureSetId = "qfs_other";
            const boundary = record.caseResults.find((c) => c.caseKind === "boundary");
            if (!boundary) throw new Error("Missing boundary result");
            if (mutation === "qualification_case") boundary.caseId = "case_boundary_other";
            if (mutation === "qualification_extra_case") {
              record.caseResults.push({ ...structuredClone(boundary), caseId: "case_zz_extra" });
              record.summary.matchedCount++;
              record.summary.totalCount++;
            }
            if (mutation === "qualification_expected") {
              boundary.expectedOutcome = "fail";
              boundary.actualOutcome = "fail";
            }
            if (mutation === "qualification_outcome") record.status = "unqualified";
            if (mutation === "qualification_window") {
              record.startedAt = record.completedAt = record.validFrom = "2026-09-01T00:00:00Z";
              record.validUntil = "2026-09-02T00:00:00.000Z";
            }
            if (mutation === "qualification_receipts")
              record.startedAt = "2026-09-01T23:59:59.999999999999999999999999999999Z";
          }
        },
      });
      if (
        [
          "criterion_evaluator",
          "criterion_oracle",
          "evaluator_oracle",
          "qualification_fixture_set",
        ].includes(mutation)
      ) {
        // Same-version identity forks fail at acquisition, before any relationship can look usable.
        await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toThrow(
          "reference_conflict",
        );
        return;
      }
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const parents = graph.evaluationSnapshots.parents;
      const runs = parents.filter((p) => p.source.kind === "evaluation_run");
      expect(runs).toHaveLength(2);
      for (const run of runs)
        expect(
          run.checks.some((c) => c.kind === expected && c.observation.status === "mismatch"),
        ).toBe(true);
      for (const result of parents.filter((p) => p.source.kind === "evaluation_run_result"))
        expect(result.checks).toContainEqual({
          kind: "run_definition",
          path: "/evaluationRunId",
          observation: { status: "mismatch" },
        });
      expect(parents.find((p) => p.source.kind === "assessment")?.checks).toContainEqual({
        kind: "aggregate_history",
        path: "/aggregate",
        observation: { status: "mismatch" },
      });
    },
  );

  it.each([
    ["evaluator", "run_criterion_reference"],
    ["oracle", "run_criterion_reference"],
    ["source_review", "run_source_reviews"],
    ["fixture_set", "run_qualification_fixture_set"],
    ["evaluator_oracles", "run_specification"],
  ])(
    "unit-checks unequal declared references independently of acquisition conflicts: %s",
    async (change, expected) => {
      const h = await harness(undefined, {});
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const original = graph.nodes.find((n) => n.read.source.kind === "evaluation_run")?.read;
      if (original?.observation.status !== "verified") throw new Error("Missing run");
      const parent = structuredClone(original);
      const run = parent.record as EvaluationRun;
      if (change === "evaluator") run.evaluator.evaluatorVersionId = "evv_other";
      if (change === "oracle") run.oracle.oracleVersionId = "orv_other";
      if (change === "source_review") {
        const review = run.sourceReviews[0];
        if (!review) throw new Error("Missing source review");
        review.sourceReviewId = "srv_other";
      }
      // This domain-rule unit test supplies controlled record bodies. End-to-end tests above
      // separately enforce hashes, parent-bound edges and repository identities before this call.
      const checks = inspectCapturedEvaluationRun(parent, (source, path) => {
        const edge = graph.edges.find(
          (e) =>
            e.reference.path === path &&
            policyEvaluationSourceReferenceKey(e.parent) ===
              policyEvaluationSourceReferenceKey(source.source),
        );
        const child = graph.nodes.find(
          (n) =>
            edge?.target &&
            policyEvaluationSourceReferenceKey(n.read.source) ===
              policyEvaluationSourceReferenceKey(edge.target),
        )?.read;
        if (!child) throw new Error("Missing test dependency");
        const copy = structuredClone(child);
        if (copy.observation.status === "verified" && copy.source.kind === "evaluator_spec") {
          const spec = copy.record as EvaluatorSpec;
          if (change === "fixture_set")
            spec.qualificationFixtureSet.fixtureSetVersionId = "qfv_other";
          if (change === "evaluator_oracles") {
            const oracle = spec.oracles[0];
            if (!oracle) throw new Error("Missing evaluator oracle");
            oracle.oracleVersionId = "orv_other";
          }
        }
        return copy;
      });
      expect(checks.some((c) => c.kind === expected && c.observation.status === "mismatch")).toBe(
        true,
      );
    },
  );

  it.each([
    "findCriterionSet",
    "findCriterionSetStatus",
    "findEvaluatorSpec",
    "findOracleSpec",
    "findQualificationReport",
    "findQualificationFixtureSet",
  ] as const)(
    "retains missing run prerequisites instead of manufacturing a definition match: %s",
    async (method) => {
      const h = await harness(undefined, {});
      vi.spyOn(h.repositories.evidence.evaluation, method).mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const runs = graph.evaluationSnapshots.parents.filter(
        (p) => p.source.kind === "evaluation_run",
      );
      expect(runs).toHaveLength(2);
      expect(runs.flatMap((p) => p.checks).some((c) => c.observation.status === "mismatch")).toBe(
        false,
      );
      expect(runs.every((p) => p.checks.some((c) => c.observation.status === "unavailable"))).toBe(
        true,
      );
      expect(
        graph.evaluationSnapshots.parents.find((p) => p.source.kind === "assessment")?.checks,
      ).toContainEqual({
        kind: "aggregate_history",
        path: "/aggregate",
        observation: { status: "unavailable" },
      });
    },
  );

  it.each([
    ["2026-09-01T23:59:59.999999999999999999999999999999Z", "mismatch"],
    ["2026-09-02T00:00:00.000Z", "mismatch"],
    ["2026-09-02T00:00:00.000000000000000000000000000001Z", "matched"],
  ])(
    "keeps all supported fractional precision at a declared status expiry: %s",
    async (expiry, expected) => {
      const h = await harness(undefined, {
        mutate: (fixture) => {
          if (fixture.kind === "criterion_set_status" && fixture.record.status === "approved")
            fixture.record.expiresAt = expiry;
        },
      });
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const runs = graph.evaluationSnapshots.parents.filter(
        (p) => p.source.kind === "evaluation_run",
      );
      expect(runs).toHaveLength(2);
      for (const run of runs)
        expect(run.checks.find((c) => c.kind === "run_status")?.observation.status).toBe(expected);
    },
  );

  it("does not lose a known context contradiction when a qualification is missing", async () => {
    const h = await harness(undefined, {
      mutate: (fixture) => {
        if (fixture.kind === "evaluation_run")
          fixture.record.applicability.contextSha256 = "0".repeat(64);
      },
    });
    vi.spyOn(h.repositories.evidence.evaluation, "findQualificationReport").mockResolvedValue(null);
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const runs = graph.evaluationSnapshots.parents.filter(
      (p) => p.source.kind === "evaluation_run",
    );
    for (const run of runs) {
      expect(run.checks.some((c) => c.observation.status === "mismatch")).toBe(true);
      expect(run.checks.some((c) => c.observation.status === "unavailable")).toBe(true);
    }
    expect(
      graph.evaluationSnapshots.parents.find((p) => p.source.kind === "assessment")?.checks,
    ).toContainEqual({
      kind: "aggregate_history",
      path: "/aggregate",
      observation: { status: "mismatch" },
    });
  });

  it.each(
    (["evaluator", "oracle"] as const).flatMap((role) =>
      (["elapsedMilliseconds", "inputBytes", "memoryBytes", "outputBytes"] as const).map(
        (dimension) => ({ role, dimension }),
      ),
    ),
  )(
    "checks every $role execution ceiling without rounding: $dimension",
    async ({ role, dimension }) => {
      const h = await harness(undefined, {
        mutate: (fixture) => {
          if (
            (fixture.kind === "evaluator_spec" || fixture.kind === "oracle_spec") &&
            fixture.kind === `${role}_spec`
          )
            fixture.record.budgets[dimension]--;
        },
      });
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      for (const run of graph.evaluationSnapshots.parents.filter(
        (p) => p.source.kind === "evaluation_run",
      ))
        expect(
          run.checks.find((c) => c.kind === "run_budget" && c.path === `/${role}`)?.observation
            .status,
        ).toBe("mismatch");
    },
  );

  it("retains an approved status without an optional expiration as a local record check only", async () => {
    const h = await harness(undefined, {
      mutate: (fixture) => {
        if (fixture.kind === "criterion_set_status") delete fixture.record.expiresAt;
      },
    });
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const runs = graph.evaluationSnapshots.parents.filter(
      (p) => p.source.kind === "evaluation_run",
    );
    expect(runs).toHaveLength(2);
    for (const run of runs)
      expect(run.checks.find((c) => c.kind === "run_status")?.observation.status).toBe("matched");
    expect(graph.evaluationSnapshots).not.toHaveProperty("eligible");
  });

  it("joins actual published runs, results, aggregates and assessments without extra reads", async () => {
    const h = await harness(undefined, {});
    const repository = h.repositories.evidence.evaluation;
    const observations = vi.spyOn(repository, "findRawObservation");
    const aggregate = vi.spyOn(repository, "findEvaluationAggregate");
    const qualifications = vi.spyOn(repository, "findQualificationReport");
    const qualificationCases = vi.spyOn(repository, "findQualificationFixtureSet");
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const reports = graph.evaluationSnapshots;
    expect(reports.parents).toHaveLength(6);
    expect(reports.unavailableParents).toEqual([]);
    expect(
      reports.parents.flatMap((p) => p.checks).every((c) => c.observation.status === "matched"),
    ).toBe(true);
    expect(observations).toHaveBeenCalledTimes(2);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(qualifications).toHaveBeenCalledTimes(2);
    expect(qualificationCases).toHaveBeenCalledTimes(1);
    expect(reports.inspectionUsage.references).toBe(33);
    for (const report of reports.parents) {
      expect(graph.entries).toContainEqual({
        source: report.source,
        observation: { status: "verified", recordSha256: report.recordSha256 },
      });
      expect(report.dependencyEdgeIndexes.length).toBeGreaterThan(0);
      for (const index of report.dependencyEdgeIndexes) expect(graph.edges[index]).toBeDefined();
      if (report.source.kind === "evaluation_run")
        expect(
          report.dependencyEdgeIndexes.filter(
            (i) => graph.edges[i]?.parent.kind === "qualification_report",
          ),
        ).toHaveLength(2);
    }
    const reordered = inspectCapturedEvaluationSnapshots(
      { nodes: [...graph.nodes].reverse(), edges: graph.edges },
      limits,
    );
    expect(reordered).toEqual(reports);
    const before = structuredClone(graph);
    const first = reordered.parents.find((p) => p.source.kind === "evaluation_run_result");
    if (first?.source.kind !== "evaluation_run_result") throw new Error("Missing result report");
    first.source.reference.resultId = "result_detached";
    expect(graph).toEqual(before);
    expect(reports).not.toHaveProperty("eligible");
    expect(reports).not.toHaveProperty("sealed");
  });

  it.each([
    "observation_attempt",
    "observation_budget",
    "observation_time",
    "observation_verdict",
    "omitted_observation",
    "result_terminal",
    "duplicate_fixture",
    "dataset_mismatch",
    "aggregate_confidence",
    "aggregate_time",
    "assessment_run",
    "assessment_observation",
    "assessment_coverage",
    "assessment_time",
  ])("detects cross-record inconsistency despite valid individual digests: %s", async (kind) => {
    const h = await harness(undefined, {
      mutate: ({ kind: recordKind, record }: EvaluationRepositoryFixtureRecord) => {
        if (recordKind === "raw_observation" && record.observationId === "obs_0") {
          if (kind === "observation_attempt") record.attemptId = "attempt_other";
          if (kind === "observation_budget") record.budgetUsage.elapsedMilliseconds = 5001;
          if (kind === "observation_time") record.startedAt = "2026-09-01T23:59:59.999Z";
          if (kind === "observation_verdict") {
            record.verdict = "fail";
            record.measurement = { kind: "boolean", metricName: "schema_valid", value: false };
          }
        }
        if (recordKind === "evaluation_run_result" && record.resultId === "evs_0") {
          if (kind === "omitted_observation") record.observations = [];
          if (kind === "result_terminal") record.terminalReason = "attempts_exhausted";
        }
        if (recordKind === "evaluation_run" && record.evaluationRunId === "evr_1") {
          if (kind === "duplicate_fixture") record.fixture.fixtureVersionId = "fxv_schema_v1";
          if (kind === "dataset_mismatch") record.dataset.datasetVersionId = "dtv_other";
        }
        if (recordKind === "evaluation_aggregate") {
          if (kind === "aggregate_confidence" && record.passInterval.status === "reported")
            record.passInterval.interval.confidenceLevelBasisPoints = 9000;
          if (kind === "aggregate_time") record.createdAt = "2026-09-02T00:00:02.999Z";
        }
        if (recordKind === "aggregation_policy" && kind === "assessment_coverage")
          record.minimumApplicableCount = 3;
        if (recordKind === "assessment") {
          if (kind === "assessment_run") record.runs.pop();
          if (kind === "assessment_observation") record.observations.pop();
          if (kind === "assessment_time") record.createdAt = "2026-09-02T00:00:03.999Z";
        }
      },
    });
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const { parents, unavailableParents } = graph.evaluationSnapshots;
    expect(unavailableParents).toEqual([]);
    expect(parents.flatMap((p) => p.checks).some((c) => c.observation.status === "mismatch")).toBe(
      true,
    );
    expect(
      parents.flatMap((p) => p.checks).some((c) => c.observation.status === "unavailable"),
    ).toBe(false);
    const assessment = parents.find((p) => p.source.kind === "assessment");
    const affected = kind.startsWith("assessment_") ? "assessment_snapshot" : "aggregate_history";
    expect(assessment?.checks.find((c) => c.kind === affected)?.observation.status).toBe(
      "mismatch",
    );
  });

  it.each([
    "findEvaluationRun",
    "findRawObservation",
    "findEvaluationRunResult",
    "findAggregationPolicy",
    "findEvaluationAggregate",
    "findAssessment",
  ] as const)(
    "preserves unavailable evidence and does not shrink a favorable snapshot: %s",
    async (method) => {
      const h = await harness(undefined, {});
      vi.spyOn(h.repositories.evidence.evaluation, method).mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const reports = graph.evaluationSnapshots;
      const checks = reports.parents.flatMap((p) => p.checks);
      expect(checks.some((c) => c.observation.status === "mismatch")).toBe(false);
      if (method === "findAssessment") {
        expect(reports.parents).toEqual([]);
        expect(reports.unavailableParents[0]?.source.kind).toBe("assessment");
      } else {
        expect(checks.some((c) => c.observation.status === "unavailable")).toBe(true);
        expect(
          reports.parents
            .find((p) => p.source.kind === "assessment")
            ?.checks.find((c) => c.kind === "aggregate_history")?.observation.status,
        ).toBe("unavailable");
      }
      if (method === "findEvaluationRun")
        expect(
          graph.edges.some(
            (e) =>
              e.reference.kind === "evaluation_run_identity" &&
              e.target === null &&
              e.selectorFailure?.status === "missing",
          ),
        ).toBe(true);
    },
  );

  it("preserves an established bad history alongside another unavailable observation", async () => {
    const h = await harness(undefined, {
      mutate: (fixture) => {
        if (fixture.kind === "raw_observation" && fixture.record.observationId === "obs_0")
          fixture.record.attemptId = "attempt_other";
      },
    });
    const find = h.repositories.evidence.evaluation.findRawObservation.bind(
      h.repositories.evidence.evaluation,
    );
    vi.spyOn(h.repositories.evidence.evaluation, "findRawObservation").mockImplementation(
      (scope, id) => (id === "obs_1" ? Promise.resolve(null) : find(scope, id)),
    );
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const aggregate = graph.evaluationSnapshots.parents.find(
      (p) => p.source.kind === "evaluation_aggregate",
    );
    expect(aggregate?.checks.map((c) => c.observation.status)).toEqual([
      "matched",
      "mismatch",
      "unavailable",
    ]);
    expect(
      graph.evaluationSnapshots.parents
        .find((p) => p.source.kind === "assessment")
        ?.checks.find((c) => c.kind === "aggregate_history")?.observation.status,
    ).toBe("mismatch");
  });

  it("charges nested repeated inputs cumulatively and accepts exact admission boundaries", async () => {
    const h = await harness(undefined, {});
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const usage = graph.evaluationSnapshots.inspectionUsage;
    const exact = { maxReferences: usage.references, maxReferenceBytes: usage.referenceBytes };
    expect(inspectCapturedEvaluationSnapshots(graph, exact)).toEqual(graph.evaluationSnapshots);
    expect(() =>
      inspectCapturedEvaluationSnapshots(graph, { ...exact, maxReferences: usage.references - 1 }),
    ).toThrow("reference_limit_exceeded");
    expect(() =>
      inspectCapturedEvaluationSnapshots(graph, {
        ...exact,
        maxReferenceBytes: usage.referenceBytes - 1,
      }),
    ).toThrow("reference_bytes_exceeded");
    expect(() =>
      inspectCapturedEvaluationSnapshots(graph, { ...exact, maxReferences: -1 }),
    ).toThrow("input_invalid");
  });

  it.each(["record_invalid", "not_yet_available"] as const)(
    "retains the original unavailable observation reason: %s",
    async (reason) => {
      const h = await harness(undefined, {});
      const original = h.repositories.evidence.evaluation.findRawObservation.bind(
        h.repositories.evidence.evaluation,
      );
      vi.spyOn(h.repositories.evidence.evaluation, "findRawObservation").mockImplementation(
        async (scope, id) => {
          const record = await original(scope, id);
          if (record && id === "obs_0") {
            if (reason === "record_invalid") record.definitionSha256 = "f".repeat(64);
            else record.recordedAt = "2026-11-01T00:00:00.000Z";
          }
          return record;
        },
      );
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const entry = graph.entries.find(
        (e) => e.source.kind === "raw_observation" && e.source.reference.observationId === "obs_0",
      );
      expect(entry?.observation).toEqual({ status: "unavailable", reason });
      const result = graph.evaluationSnapshots.parents.find(
        (p) => p.source.kind === "evaluation_run_result" && p.source.reference.resultId === "evs_0",
      );
      expect(result?.checks[0]?.observation.status).toBe("unavailable");
      expect(
        result?.dependencyEdgeIndexes.some(
          (i) => graph.edges[i]?.target?.kind === "raw_observation",
        ),
      ).toBe(true);
    },
  );

  it("propagates an observation-store failure without a partial successful report", async () => {
    const h = await harness(undefined, {});
    const failure = new Error("Evaluation observation store failed");
    vi.spyOn(h.repositories.evidence.evaluation, "findRawObservation").mockRejectedValue(failure);
    await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toBe(failure);
  });

  it("keeps an empty internal graph empty rather than manufacturing successful checks", () => {
    expect(
      inspectCapturedEvaluationSnapshots(
        { nodes: [], edges: [] },
        { maxReferences: 0, maxReferenceBytes: 0 },
      ),
    ).toEqual({
      parents: [],
      unavailableParents: [],
      inspectionUsage: { references: 0, referenceBytes: 0 },
    });
  });

  it.each([
    "edge_missing",
    "edge_duplicate",
    "parent_hash",
    "node_missing",
    "target_kind",
    "selector_failure_missing",
  ])(
    "rejects a broken internal provenance invariant instead of reporting absent evidence: %s",
    async (kind) => {
      const h = await harness(undefined, {});
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const edges = structuredClone([...graph.edges]);
      const nodes = structuredClone([...graph.nodes]);
      const index = edges.findIndex(
        (e) => e.parent.kind === "evaluation_run_result" && e.reference.path === "/evaluationRunId",
      );
      const edge = edges[index];
      if (!edge?.target) throw new Error("Missing result edge");
      if (kind === "edge_missing") edges.splice(index, 1);
      if (kind === "edge_duplicate") edges.push(structuredClone(edge));
      if (kind === "parent_hash") Object.assign(edge, { parentRecordSha256: "f".repeat(64) });
      if (kind === "node_missing")
        nodes.splice(
          nodes.findIndex(
            (n) =>
              policyEvaluationSourceReferenceKey(n.read.source) ===
              policyEvaluationSourceReferenceKey(edge.target as NonNullable<typeof edge.target>),
          ),
          1,
        );
      if (kind === "target_kind") Object.assign(edge, { target: graph.roots[0] });
      if (kind === "selector_failure_missing") Object.assign(edge, { target: null });
      expect(() => inspectCapturedEvaluationSnapshots({ nodes, edges }, limits)).toThrow(
        "reference_conflict",
      );
    },
  );
});

describe("request-rooted recursive record graph", () => {
  it.each(["valid", "profile_mismatch", "missing_plan", "missing_result"])(
    "retains replay result binding observations through actual graph acquisition: %s",
    async (kind) => {
      const h = await harness("history");
      const originalFind = h.repositories.replayResults.findJob.bind(h.repositories.replayResults);
      const read = vi.spyOn(h.repositories.replayResults, "findJob");
      if (kind === "profile_mismatch")
        read.mockImplementation(async (scope, id) => {
          const value = await originalFind(scope, id);
          if (value?.attempts[0]) value.attempts[0].runtimeProfile.id = "runtime_other";
          return value;
        });
      if (kind === "missing_plan")
        vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockResolvedValue(null);
      if (kind === "missing_result") read.mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      expect(read).toHaveBeenCalledTimes(1);
      if (kind === "missing_result") {
        expect(graph.replayResults.results).toEqual([]);
        expect(graph.replayResults.unavailableResults).toEqual([
          {
            source: { kind: "replay_result", reference: h.replayResultReference },
            observation: { status: "missing" },
          },
        ]);
        return;
      }
      expect(graph.replayResults.results).toHaveLength(1);
      expect(graph.replayResults.unavailableResults).toEqual([]);
      const report = graph.replayResults.results[0];
      expect(report?.source).toEqual({ kind: "replay_result", reference: h.replayResultReference });
      const node = graph.entries.find((e) => e.source.kind === "replay_result");
      expect(node?.observation).toEqual({ status: "verified", recordSha256: report?.recordSha256 });
      expect(
        report?.checks.filter((c) => c.observation.status === "mismatch").map((c) => c.kind),
      ).toEqual(kind === "profile_mismatch" ? ["runtime_profile"] : []);
      if (kind === "missing_plan") {
        expect(report?.plan.recordObservation).toEqual({ status: "missing" });
        expect(report?.checks.find((c) => c.kind === "runtime_profile")?.observation).toEqual({
          status: "unavailable",
          reason: "plan_unavailable",
        });
      } else expect(report?.checks.every((c) => c.observation.status !== "unavailable")).toBe(true);
      expect(graph.edges).toContainEqual({
        parent: report?.source,
        parentRecordSha256: report?.recordSha256,
        reference: { kind: "record", path: "/job/plan", source: report?.plan.source },
        target: report?.plan.source,
      });
      expect(graph).not.toHaveProperty("sealed");
    },
  );

  it("propagates a replay history repository failure without returning partial checks", async () => {
    const h = await harness("history");
    const failure = new Error("History unavailable");
    vi.spyOn(h.repositories.replayResults, "findJob").mockRejectedValue(failure);
    await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toBe(failure);
  });

  it.each(["valid", "invalid_digest", "unsupported_kind"] as const)(
    "retains published replay plan semantics in the actual acquired graph: %s",
    async (kind) => {
      const h = await harness(kind);
      const readPlan = vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan");
      const readTarget = vi.spyOn(h.repositories.replayDefinitions, "findTargetRelease");
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const report = graph.replayPlans.plans[0];
      expect(graph.replayPlans.plans).toHaveLength(1);
      expect(graph.replayPlans.unavailablePlans).toEqual([]);
      expect(report?.source).toEqual({ kind: "replay_plan", reference: h.replay?.planReference });
      expect(
        report?.checks.filter((c) => c.observation.status === "mismatch").map((c) => c.kind),
      ).toEqual(
        kind === "invalid_digest"
          ? ["invocation_digest"]
          : kind === "unsupported_kind"
            ? ["boundary_kind"]
            : [],
      );
      expect(report?.checks.find((c) => c.kind === "fixture_membership")?.observation).toEqual({
        status: "unavailable",
      });
      expect(readPlan).toHaveBeenCalledTimes(1);
      expect(readTarget).toHaveBeenCalledTimes(1);
      for (const dependency of report?.dependencies ?? []) {
        expect(graph.edges).toContainEqual({
          parent: report?.source,
          parentRecordSha256: report?.recordSha256,
          reference: { kind: "record", path: dependency.path, source: dependency.source },
          target: dependency.source,
        });
        expect(dependency.recordObservation).toEqual(
          graph.entries.find(
            (e) =>
              policyEvaluationSourceReferenceKey(e.source) ===
              policyEvaluationSourceReferenceKey(dependency.source),
          )?.observation,
        );
      }
      expect(graph).not.toHaveProperty("sealed");
      expect(graph).not.toHaveProperty("verdict");
    },
  );

  it.each(["plan", "target"])(
    "preserves missing %s observations, not successful empty replay bindings",
    async (kind) => {
      const h = await harness("valid");
      if (kind === "plan")
        vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockResolvedValue(null);
      else vi.spyOn(h.repositories.replayDefinitions, "findTargetRelease").mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      if (kind === "plan")
        expect(graph.replayPlans).toEqual({
          inspectionUsage: { references: 0, referenceBytes: 0 },
          plans: [],
          unavailablePlans: [
            {
              source: { kind: "replay_plan", reference: h.replay?.planReference },
              observation: { status: "missing" },
            },
          ],
        });
      else {
        const plan = graph.replayPlans.plans[0];
        expect(
          plan?.dependencies.find((d) => d.path === "/targetRelease")?.recordObservation,
        ).toEqual({ status: "missing" });
        expect(
          plan?.checks.filter((c) => c.observation.status === "matched").map((c) => c.kind),
        ).toEqual(["invocation_digest"]);
      }
    },
  );

  it("propagates replay storage errors without returning a partial semantic capture", async () => {
    const h = await harness("valid");
    const failure = new Error("Replay storage failure");
    vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockRejectedValue(failure);
    await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toBe(failure);
  });

  it("traverses real immutable evaluation records, terminates backreferences, and retains open frontiers", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(graph.nodes.length).toBeGreaterThan(20);
    expect(graph.edges.length).toBeGreaterThan(graph.nodes.length);
    expect(graph.roots).toEqual([
      { kind: "release_candidate", reference: setup.input.candidate },
      { kind: "release_policy", reference: setup.input.policy },
    ]);
    expect(graph.nodes.filter(({ read }) => read.source.kind === "criterion_set")).toHaveLength(1);
    expect(
      graph.edges.filter(({ reference }) => reference.kind === "criterion_selector").length,
    ).toBeGreaterThan(5);
    expect(
      graph.edges.filter(
        ({ reference, target }) =>
          reference.kind === "criterion_selector" && target?.kind === "criterion_set",
      ).length,
    ).toBeGreaterThan(5);
    expect(graph.unresolved.records).toBeGreaterThan(0);
    expect(graph.unresolved.references).toBeGreaterThan(0);
    expect(
      graph.nodes
        .filter(({ read }) => read.observation.status !== "verified")
        .every(({ references }) => references === null),
    ).toBe(true);
    expect(
      graph.edges.some(({ reference, target }) => reference.kind === "artifact" && target === null),
    ).toBe(true);
    const keys = graph.entries.map(({ source }) => policyEvaluationSourceReferenceKey(source));
    expect(keys).toEqual([...new Set(keys)].sort());
    expect(graph.edges[0]?.parent.kind).toBe("release_candidate");
    const inspections = [
      graph.recordClosure,
      graph.policyAssessments,
      graph.candidateAssessmentLineage,
      graph.evaluationSnapshots,
      graph.evaluationReplays,
      graph.modelAssurance,
      graph.datasetRelations,
      graph.replayPlans,
    ].map((report) => report.inspectionUsage);
    inspections.push(registrationInspectionUsage(graph));
    expect(graph.usage.references).toBe(
      graph.edges.length + inspections.reduce((sum, usage) => sum + usage.references, 0),
    );
    expect(graph.usage.referenceBytes).toBe(
      graph.edges.reduce(
        (sum, edge) => sum + encodeEvaluationCanonicalJson(edge.reference).byteLength,
        inspections.reduce((sum, usage) => sum + usage.referenceBytes, 0),
      ),
    );
    expect(graph).not.toHaveProperty("sealed");
    expect(graph).not.toHaveProperty("verdict");
  });

  it("produces identical graphs on repeated reads without changing caller or repository state", async () => {
    const setup = await harness();
    const original = structuredClone(setup.input);
    const first = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const second = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(first).toEqual(second);
    expect(setup.input).toEqual(original);
    (first.roots[0]?.reference as { definitionSha256: string }).definitionSha256 = "f".repeat(64);
    const stored = await setup.repositories.control.releaseCandidate.findReleaseCandidate(
      setup.input.scope,
      setup.candidate.candidateVersionId,
    );
    expect(stored).toEqual(setup.candidate);
    expect(setup.input).toEqual(original);
  });

  it.each(["references", "bytes"] as const)(
    "admits combined semantic inspection %s exactly and rejects one below before trace I/O",
    async (dimension) => {
      const setup = await harness("history", { dataset: "matched" });
      const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
      const reports = [
        graph.recordClosure,
        graph.policyAssessments,
        graph.candidateAssessmentLineage,
        graph.evaluationSnapshots,
        graph.evaluationReplays,
        graph.datasetRelations,
        graph.replayPlans,
      ];
      for (const report of reports) expect(report.inspectionUsage.references).toBeGreaterThan(0);
      const referenceCount =
        graph.edges.length +
        reports.reduce((sum, report) => sum + report.inspectionUsage.references, 0) +
        registrationInspectionUsage(graph).references;
      const referenceBytes =
        graph.edges.reduce(
          (sum, edge) => sum + encodeEvaluationCanonicalJson(edge.reference).byteLength,
          0,
        ) +
        reports.reduce((sum, report) => sum + report.inspectionUsage.referenceBytes, 0) +
        registrationInspectionUsage(graph).referenceBytes;
      expect(graph.modelAssurance.inspectionUsage.references).toBe(0);
      expect(graph.usage.records).toBeLessThan(referenceCount);
      expect(graph.usage).toMatchObject({ references: referenceCount, referenceBytes });
      const limits = {
        ...setup.input.limits,
        maxAcquisitionRecords: referenceCount,
        maxAcquisitionRecordBytes: graph.usage.bytes + referenceBytes,
      };
      const exact = request(setup.candidate, setup.policy, limits);
      expect((await capturePolicyRecordGraph(exact, setup.repositories)).usage).toEqual(
        graph.usage,
      );
      const tooSmall = request(setup.candidate, setup.policy, {
        ...limits,
        ...(dimension === "references"
          ? { maxAcquisitionRecords: referenceCount - 1 }
          : { maxAcquisitionRecordBytes: limits.maxAcquisitionRecordBytes - 1 }),
      });
      const evidence = { resolveExactEvents: vi.fn(async () => []) };
      await expect(
        capturePolicyTraceEvidence(tooSmall, setup.repositories, evidence),
      ).rejects.toMatchObject({
        reason: dimension === "references" ? "reference_limit" : "byte_limit",
      });
      expect(evidence.resolveExactEvents).not.toHaveBeenCalled();
    },
  );

  it("retains both missing roots without inventing child records or accepting an empty graph", async () => {
    const setup = await harness();
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(setup.input, missing.repositories);
    expect(graph.entries).toHaveLength(2);
    expect(graph.entries.every(({ observation }) => observation.status === "missing")).toBe(true);
    expect(graph.unresolved).toEqual({ records: 2, references: 0 });
    expect(graph.usage).toMatchObject({ reads: 2, records: 2, bytes: 8, references: 0 });
    expect(missing.calls.map(({ domain }) => domain)).toEqual(["candidate", "policy"]);
  });

  it("rejects forged request digests and caller-added roots before storage access", async () => {
    const setup = await harness();
    const missing = missingRepositories();
    for (const input of [
      { ...setup.input, definitionSha256: "f".repeat(64) },
      { ...setup.input, roots: [] },
    ])
      await expect(capturePolicyRecordGraph(input, missing.repositories)).rejects.toMatchObject({
        code: "policy_evaluation_request_record_invalid",
      });
    expect(missing.calls).toHaveLength(0);
  });

  it("preserves unavailable roots and does not turn them into verified leaves", async () => {
    const setup = await harness();
    setup.repositories = {
      ...setup.repositories,
      control: {
        ...setup.repositories.control,
        releaseCandidate: {
          findReleaseCandidate: async () =>
            ({ ...setup.candidate, extra: true }) as ReleaseCandidate,
        },
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const node = graph.nodes.find(({ read }) => read.source.kind === "release_candidate");
    expect(node).toMatchObject({
      read: { record: null, observation: { status: "unavailable", reason: "record_invalid" } },
      references: null,
    });
  });

  it("returns no partial graph when cumulative records, bytes, or references exceed limits", async () => {
    const setup = await harness();
    for (const [dimension, limit] of [
      ["maxAcquisitionRecords", 2],
      ["maxAcquisitionRecordBytes", 1],
    ] as const) {
      const input = request(setup.candidate, setup.policy, {
        ...setup.input.limits,
        [dimension]: limit,
      });
      await expect(capturePolicyRecordGraph(input, setup.repositories)).rejects.toMatchObject({
        code:
          dimension === "maxAcquisitionRecords"
            ? "policy_evaluation_evidence_references_invalid"
            : "policy_record_graph_failed",
      });
    }
    const missing = missingRepositories();
    const exact = request(setup.candidate, setup.policy, {
      ...setup.input.limits,
      maxAcquisitionRecords: 2,
      maxAcquisitionRecordBytes: 8,
    });
    expect((await capturePolicyRecordGraph(exact, missing.repositories)).usage.bytes).toBe(8);
    await expect(
      capturePolicyRecordGraph(
        request(setup.candidate, setup.policy, { ...exact.limits, maxAcquisitionRecordBytes: 7 }),
        missing.repositories,
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
  });

  it("propagates repository failures instead of fabricating missing graph nodes", async () => {
    const setup = await harness();
    const failure = new Error("database offline");
    setup.repositories = {
      ...setup.repositories,
      control: {
        ...setup.repositories.control,
        releasePolicy: {
          findReleasePolicy: async () => {
            throw failure;
          },
        },
      },
    };
    await expect(capturePolicyRecordGraph(setup.input, setup.repositories)).rejects.toBe(failure);
  });

  it("keeps failed selector occurrences as explicit unresolved edges", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    setup.repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet") return async () => null;
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(
      graph.edges
        .filter(({ reference }) => reference.kind === "criterion_selector")
        .every(
          ({ target, selectorFailure }) => target === null && selectorFailure?.status === "missing",
        ),
    ).toBe(true);
    expect(graph.edges.some(({ selectorFailure }) => selectorFailure?.status === "missing")).toBe(
      true,
    );
  });

  it("rejects conflicting exact references from different parents", async () => {
    const setup = await harness();
    const draft = structuredClone(setup.policy);
    for (const rule of draft.rules)
      if ("assessment" in rule.predicate && "assessmentId" in rule.predicate.assessment)
        rule.predicate.assessment.definitionSha256 = "f".repeat(64);
    const policy = policyDigest(draft);
    await expect(
      capturePolicyRecordGraph(request(setup.candidate, policy), {
        ...setup.repositories,
        control: {
          ...setup.repositories.control,
          releasePolicy: { findReleasePolicy: async () => policy },
        },
      }),
    ).rejects.toMatchObject({
      reason: "reference_conflict",
      identity: `assessment:${setup.candidate.assessments[0]?.assessmentId}`,
    });
  });

  it("rejects conflicting artifact descriptors even when each parent is internally consistent", async () => {
    const setup = await harness();
    const previous = structuredClone(setup.candidate);
    previous.candidateVersionId = "candidate_graph_prior";
    const build = previous.buildArtifacts[0];
    if (!build) throw new Error("Missing build artifact");
    build.artifact.sizeBytes++;
    const retained = candidateDigest(previous);
    const candidate = candidateDigest({
      ...setup.candidate,
      predecessor: {
        candidateId: retained.candidateId,
        candidateVersionId: retained.candidateVersionId,
        definitionSha256: retained.definitionSha256,
      },
    });
    await expect(
      capturePolicyRecordGraph(request(candidate, setup.policy), {
        ...setup.repositories,
        control: {
          ...setup.repositories.control,
          releaseCandidate: {
            findReleaseCandidate: async (_scope, id) =>
              id === candidate.candidateVersionId ? candidate : retained,
          },
        },
      }),
    ).rejects.toMatchObject({
      reason: "reference_conflict",
      identity: `artifact:${build.artifact.artifactId}`,
    });
  });

  it("rejects changed full-record receipts across repeated exact selector reads", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    let reads = 0;
    const repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet")
              return async (...args: Parameters<typeof original.findCriterionSet>) => {
                const value = await original.findCriterionSet(...args);
                reads++;
                return value && reads > 1
                  ? { ...value, publishedAt: "2026-09-03T00:00:00.000Z" }
                  : value;
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    await expect(capturePolicyRecordGraph(setup.input, repositories)).rejects.toMatchObject({
      reason: "observation_conflict",
    });
    expect(reads).toBeGreaterThan(1);
  });

  it("keeps unavailable selectors distinct from missing and does not manufacture their hashes", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    const repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet")
              return async (...args: Parameters<typeof original.findCriterionSet>) => {
                const value = await original.findCriterionSet(...args);
                return value && { ...value, publishedAt: "2027-01-01T00:00:00.000Z" };
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, repositories);
    const edges = graph.edges.filter(({ reference }) => reference.kind === "criterion_selector");
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges)
      expect(edge).toMatchObject({
        target: null,
        selectorFailure: { status: "unavailable", reason: "not_yet_available" },
      });
  });

  it("admits exact aggregate budgets and rejects one byte or occurrence less", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const limits = {
      ...setup.input.limits,
      maxAcquisitionRecords: graph.usage.references,
      maxAcquisitionRecordBytes: graph.usage.bytes + graph.usage.referenceBytes,
    };
    expect(graph.usage.references).toBeGreaterThan(graph.usage.records);
    const exact = await capturePolicyRecordGraph(
      request(setup.candidate, setup.policy, limits),
      setup.repositories,
    );
    expect(exact.usage).toEqual(graph.usage);
    for (const [key, reason] of [
      ["maxAcquisitionRecords", "reference_limit"],
      ["maxAcquisitionRecordBytes", "byte_limit"],
    ] as const)
      await expect(
        capturePolicyRecordGraph(
          request(setup.candidate, setup.policy, { ...limits, [key]: limits[key] - 1 }),
          setup.repositories,
        ),
      ).rejects.toMatchObject({ code: "policy_record_graph_failed", reason });
  });

  it("retains a comparison predecessor edge and expands the prefetched definition without rereading it", async () => {
    const setup = await harness();
    const repository = new MemoryComparisonRepository();
    const prior = comparisonDefinitionFixture("graph", setup.input.scope);
    const successor = comparisonDefinitionFixture("graph", setup.input.scope, {
      predecessor: {
        comparisonVersionId: prior.comparisonVersionId,
        definitionSha256: prior.definitionSha256,
      },
      version: "v2",
    });
    await repository.publishComparisonDefinition(prior);
    await repository.publishComparisonDefinition(successor);
    const rule = structuredClone(
      setup.policy.rules.find(({ predicate }) => predicate.kind === "comparison_threshold"),
    );
    if (rule?.predicate.kind !== "comparison_threshold") throw new Error("Missing comparison rule");
    rule.predicate.comparison = {
      comparisonId: successor.comparisonId,
      comparisonVersionId: successor.comparisonVersionId,
      definitionSha256: successor.definitionSha256,
    };
    const policy = policyDigest({
      ...setup.policy,
      rules: [
        rule,
        ...setup.policy.rules.filter(({ predicate }) => predicate.kind === "approval_required"),
      ].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)),
    });
    const read = vi.spyOn(repository, "findComparisonDefinition");
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(request(setup.candidate, policy), {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        comparison: repository,
        releasePolicy: { findReleasePolicy: async () => policy },
      },
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      graph.nodes.filter(({ read }) => read.source.kind === "comparison_definition"),
    ).toHaveLength(2);
    expect(graph.edges.find(({ reference }) => reference.path === "/predecessor")).toMatchObject({
      target: {
        kind: "comparison_definition",
        reference: { comparisonVersionId: prior.comparisonVersionId },
      },
    });
  });

  it("waits for an already-started fixture sibling read before exposing a storage failure", async () => {
    const setup = await harness();
    const failure = new Error("fixture store offline");
    let release!: (value: null) => void;
    let started!: () => void;
    const pending = new Promise<null>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = false;
    const capture = capturePolicyRecordGraph(setup.input, {
      ...setup.repositories,
      datasets: {
        findDatasetVersion: async () => null,
        findFixtureVersion: async () => {
          throw failure;
        },
        findRecordedInteractionFixtureVersion: async () => {
          started();
          return pending;
        },
      },
    }).catch((error: unknown) => {
      finished = true;
      return error;
    });
    await entered;
    await Promise.resolve();
    expect(finished).toBe(false);
    release(null);
    expect(await capture).toBe(failure);
    expect(finished).toBe(true);
  });

  it("retains the normal model-profile/evaluator cycle while expanding each exact node only once", async () => {
    const setup = await harness();
    const model = await createModelAssuranceRepositoryTestHarness("graph");
    const assessment = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: model.evaluation.repository,
      modelAssuranceRepository: model.repository,
    }).execute(model.command);
    const candidate = candidateDigest({
      ...setup.candidate,
      assessments: [assessment.record.baseAssessment],
      modelAssuranceAssessments: [
        {
          assessmentExtensionId: assessment.record.assessmentExtensionId,
          definitionSha256: assessment.record.definitionSha256,
        },
      ],
    });
    const missing = missingRepositories();
    const allowed = new Set([
      "model_assurance_assessment",
      "model_qualification_report",
      "model_evaluator_profile",
      "model_assisted_evaluator",
    ]);
    const graph = await capturePolicyRecordGraph(request(candidate, setup.policy), {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        releaseCandidate: { findReleaseCandidate: async () => candidate },
      },
      evidence: {
        ...missing.repositories.evidence,
        modelAssurance: {
          find: async (scope, kind, id) =>
            allowed.has(kind) ? model.repository.find(scope, kind, id) : null,
        },
      },
    });
    for (const kind of ["model_evaluator_profile", "model_assisted_evaluator_spec"])
      expect(graph.nodes.filter(({ read }) => read.source.kind === kind)).toHaveLength(1);
    expect(
      graph.edges.find(({ reference }) => reference.kind === "model_evaluator_selector"),
    ).toMatchObject({ target: { kind: "model_assisted_evaluator_spec" } });
    expect(
      graph.edges.some(
        ({ parent, target }) =>
          parent.kind === "model_assisted_evaluator_spec" &&
          target?.kind === "model_evaluator_profile",
      ),
    ).toBe(true);
    expect(graph.usage.reads).toBeLessThan(50);
  });

  it("owns the validated request before a repository can mutate the caller's context", async () => {
    const setup = await harness();
    const original = structuredClone(setup.input);
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(setup.input, {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        releaseCandidate: {
          findReleaseCandidate: async () => {
            setup.input.scope.tenantId = "tenant_mutated";
            setup.input.policy.definitionSha256 = "f".repeat(64);
            setup.input.limits.maxAcquisitionRecordBytes = 1;
            return null;
          },
        },
      },
    });
    expect(graph.scope).toEqual(original.scope);
    expect(graph.roots[1]).toEqual({ kind: "release_policy", reference: original.policy });
    expect(graph.usage.bytes).toBe(8);
    expect(missing.calls[0]?.args[0]).toEqual(original.scope);
  });
});

describe("fixed cross-domain routing", () => {
  it("routes every declared source kind without a plugin validator or latest lookup", async () => {
    const setup = await harness();
    const run = setup.evaluation.records.find(({ kind }) => kind === "evaluation_run");
    if (run?.kind !== "evaluation_run") throw new Error("Missing replay reference");
    const runtimeVectors = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/runtime-definition-v1.json", import.meta.url),
        "utf8",
      ),
    ) as { vectors: { input: { definition: Fields } }[] };
    const readLimits = { maxReferences: 1000, maxReferenceBytes: 1000000 };
    expect(PolicyEvaluationSourceReferenceSchema.options).toHaveLength(48);
    for (const option of PolicyEvaluationSourceReferenceSchema.options) {
      const kind = option.shape.kind.value;
      const runtime = runtimeVectors.vectors.find(
        ({ input }) => input.definition["recordKind"] === kind,
      )?.input.definition;
      const reference =
        kind === "replay_result"
          ? run.record.replay
          : kind === "target_release"
            ? run.record.replay.targetRelease
            : Object.fromEntries(
                Object.keys(option.shape.reference.shape).map((key) => [
                  key,
                  key === "definitionSha256"
                    ? "a".repeat(64)
                    : key === "role"
                      ? "candidate"
                      : (runtime?.[key] ?? "record_one"),
                ]),
              );
      const source = PolicyEvaluationSourceReferenceSchema.parse({ kind, reference });
      const missing = missingRepositories();
      const expansion = await readAndExpandPolicyRecord(
        { scope: setup.input.scope, evaluationTime: time, source },
        missing.repositories,
        readLimits,
        { maximumRecords: 1000, maximumRecordBytes: 1000000 },
      );
      expect(expansion, kind).toEqual({
        read: { source, observation: { status: "missing" }, record: null },
        references: null,
      });
      expect(missing.calls.length, kind).toBe(kind === "regression_fixture_version" ? 2 : 1);
      const domain =
        kind === "protocol_definition"
          ? "protocol"
          : kind === "endpoint_profile"
            ? "endpoint"
            : kind === "qualification_policy"
              ? "qualification"
              : kind === "evaluation_implementation_registration"
                ? "implementation"
                : kind.startsWith("comparison_")
                  ? "comparison"
                  : kind === "release_candidate"
                    ? "candidate"
                    : kind === "release_policy"
                      ? "policy"
                      : kind === "policy_installation_binding"
                        ? "binding"
                        : ["dataset_version", "regression_fixture_version"].includes(kind)
                          ? "dataset"
                          : ["replay_plan", "target_release"].includes(kind)
                            ? "replay"
                            : kind === "replay_result"
                              ? "job"
                              : runtime
                                ? "runtime"
                                : [
                                      "blinded_plan",
                                      "blinded_result",
                                      "calibration_report",
                                      "human_review_protocol",
                                      "human_review_record",
                                      "human_reviewer_independence",
                                      "independence_declaration",
                                      "independent_critique",
                                      "model_assisted_evaluator_spec",
                                      "model_assurance_assessment",
                                      "model_evaluator_profile",
                                      "model_qualification_report",
                                      "model_qualification_suite",
                                    ].includes(kind)
                                  ? "model"
                                  : "evaluation";
      expect(
        missing.calls.every((call) => call.domain === domain),
        kind,
      ).toBe(true);
    }
  });
});

describe("candidate assessment dataset and target lineage", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4 * 1024 * 1024 };
  const members = (graph: Awaited<ReturnType<typeof capturePolicyRecordGraph>>) => {
    if (graph.candidateAssessmentLineage.status !== "inspected")
      throw new Error("Expected candidate lineage");
    return graph.candidateAssessmentLineage.members;
  };
  const checks = (graph: Awaited<ReturnType<typeof capturePolicyRecordGraph>>) =>
    members(graph).flatMap((m) => m.checks);
  const inspect = (
    setup: Awaited<ReturnType<typeof harness>>,
    graph: Awaited<ReturnType<typeof capturePolicyRecordGraph>>,
    budget = limits,
  ) =>
    inspectCapturedCandidateAssessmentLineage(
      setup.input,
      graph,
      graph.evaluationSnapshots,
      graph.modelAssurance,
      budget,
    );

  it("connects every candidate assessment to exact retained histories, dataset fixtures and target", async () => {
    const setup = await harness("history", { dataset: "matched" });
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(members(graph)).toHaveLength(1);
    expect(checks(graph).length).toBeGreaterThan(10);
    expect(checks(graph).every((c) => c.observation.status === "matched")).toBe(true);
    expect(checks(graph).filter((c) => c.kind === "candidate_target")).toHaveLength(2);
    expect(checks(graph).filter((c) => c.kind === "dataset_fixture")).toHaveLength(2);
    const member = members(graph)[0];
    if (!member) throw new Error("Expected assessment");
    expect(graph.edges[member.candidateEdgeIndex]?.target).toEqual(member.source);
    expect(
      member.dependencyEdgeIndexes.filter(
        (i) => graph.edges[i]?.reference.path === "/targetRelease",
      ),
    ).toHaveLength(2);
    expect(graph.candidateAssessmentLineage).not.toHaveProperty("sealed");
    expect(graph.candidateAssessmentLineage).not.toHaveProperty("verdict");
  });

  it.each(["dataset", "target"] as const)(
    "retains a valid same-scope assessment's wrong candidate %s",
    async (kind) => {
      const setup = await harness("history", { dataset: "matched" });
      if (kind === "dataset")
        setup.candidate.datasets = [
          {
            datasetId: "dataset_other",
            datasetVersionId: "dataset_version_other",
            definitionSha256: "f".repeat(64),
          },
        ];
      else
        setup.candidate.targetRelease = {
          ...setup.candidate.targetRelease,
          targetReleaseId: "release_other",
        };
      setup.candidate = candidateDigest(setup.candidate);
      setup.input = request(setup.candidate, setup.policy);
      setup.repositories = {
        ...setup.repositories,
        control: {
          ...setup.repositories.control,
          releaseCandidate: {
            findReleaseCandidate: async () => setup.candidate,
          },
        },
      };
      const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
      expect(
        checks(graph)
          .filter((c) => c.kind === `candidate_${kind}`)
          .map((c) => c.observation.status),
      ).toEqual(Array(kind === "dataset" ? 3 : 2).fill("mismatch"));
      expect(checks(graph).find((c) => c.kind === "assessment_history")?.observation.status).toBe(
        "matched",
      );
    },
  );

  it("does not count a readable fixture outside the declared dataset", async () => {
    const setup = await harness("history", { dataset: "wrong_fixture" });
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(
      checks(graph)
        .filter((c) => c.kind === "dataset_fixture")
        .map((c) => c.observation.status),
    ).toEqual(["mismatch", "matched"]);
    expect(
      checks(graph)
        .filter((c) => c.kind === "fixture_available")
        .every((c) => c.observation.status === "matched"),
    ).toBe(true);
  });

  it.each([
    ["findAssessment", "assessment_history"],
    ["findEvaluationAggregate", "aggregate_available"],
    ["findAggregationPolicy", "aggregation_policy_available"],
    ["findEvaluationRun", "run_available"],
  ] as const)("preserves the unreadable %s frontier", async (method, expected) => {
    const setup = await harness("history", { dataset: "matched" });
    vi.spyOn(setup.repositories.evidence.evaluation, method).mockResolvedValue(null);
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(members(graph)).toHaveLength(1);
    expect(
      checks(graph).some((c) => c.kind === expected && c.observation.status === "unavailable"),
    ).toBe(true);
    expect(checks(graph).some((c) => c.kind === "candidate_target")).toBe(
      method === "findAggregationPolicy",
    );
  });

  it.each(["dataset", "fixture", "target"] as const)(
    "keeps %s availability separate from exact candidate declarations",
    async (kind) => {
      const setup = await harness("history", { dataset: "matched" });
      if (kind === "dataset")
        vi.spyOn(setup.repositories.datasets, "findDatasetVersion").mockResolvedValue(null);
      if (kind === "fixture")
        vi.spyOn(setup.repositories.datasets, "findFixtureVersion").mockResolvedValue(null);
      if (kind === "target")
        vi.spyOn(setup.repositories.replayDefinitions, "findTargetRelease").mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
      expect(
        checks(graph)
          .filter((c) => c.kind === `${kind}_available`)
          .map((c) => c.observation.status),
      ).toEqual(Array(kind === "dataset" ? 3 : 2).fill("unavailable"));
      expect(
        checks(graph)
          .filter((c) => c.kind === "candidate_dataset" || c.kind === "candidate_target")
          .every((c) => c.observation.status === "matched"),
      ).toBe(true);
      expect(
        checks(graph)
          .filter((c) => c.kind === "dataset_fixture")
          .map((c) => c.observation.status),
      ).toEqual(kind === "dataset" ? ["unavailable", "unavailable"] : ["matched", "matched"]);
    },
  );

  it.each(["record_invalid", "reference_mismatch", "not_yet_available"] as const)(
    "preserves %s assessment observations",
    async (reason) => {
      const setup = await harness(undefined, {});
      const find = setup.repositories.evidence.evaluation.findAssessment.bind(
        setup.repositories.evidence.evaluation,
      );
      vi.spyOn(setup.repositories.evidence.evaluation, "findAssessment").mockImplementation(
        async (...args) => {
          const record = await find(...args);
          if (!record) throw new Error("Expected assessment");
          if (reason === "record_invalid") record.definitionSha256 = "f".repeat(64);
          if (reason === "not_yet_available") record.createdAt = "2026-11-01T00:00:00.000Z";
          if (reason === "reference_mismatch") {
            record.assessmentId = "assessment_other";
            const definition = structuredClone(record) as unknown as Fields;
            for (const key of evaluationRecordDescriptors.assessment.receiptKeys)
              delete definition[key];
            record.definitionSha256 = digestEvaluationRecordDefinition(
              "assessment",
              record.scope,
              definition,
            );
          }
          return record;
        },
      );
      const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
      expect(members(graph)[0]?.observation).toEqual({ status: "unavailable", reason });
      expect(checks(graph).map((c) => c.observation.status)).toEqual(["unavailable"]);
    },
  );

  it("propagates criterion/run-history contradictions even with matching candidate references", async () => {
    const setup = await harness("history", {
      dataset: "matched",
      mutate(fixture) {
        if (fixture.kind === "evaluation_run")
          fixture.record.applicability.context.populationTags = [];
      },
    });
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(checks(graph).find((c) => c.kind === "assessment_history")?.observation.status).toBe(
      "mismatch",
    );
    expect(
      checks(graph)
        .filter((c) => c.kind === "candidate_dataset" || c.kind === "candidate_target")
        .every((c) => c.observation.status === "matched"),
    ).toBe(true);
  });

  it("keeps an observed empty aggregate distinct from established target lineage", async () => {
    const setup = await harness(undefined, {
      mutate(fixture) {
        if (fixture.kind !== "evaluation_aggregate") return;
        const record = fixture.record;
        record.members = [];
        for (const key of Object.keys(record.counts) as (keyof typeof record.counts)[])
          record.counts[key] = 0;
        for (const key of ["coverage", "abstentionRate", "errorRate", "passProportion"] as const)
          record[key] = { status: "unavailable", reason: "zero_denominator" };
        record.passInterval = { status: "not_reported", reason: "no_decided_cases" };
      },
    });
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(checks(graph).find((c) => c.kind === "aggregate_available")?.observation.status).toBe(
      "matched",
    );
    expect(checks(graph).filter((c) => c.kind === "candidate_target")).toMatchObject([
      {
        source: { kind: "evaluation_aggregate" },
        path: "/members",
        observation: { status: "unavailable" },
      },
    ]);
    expect(checks(graph).some((c) => c.kind === "run_available")).toBe(false);
    expect(checks(graph).find((c) => c.kind === "candidate_dataset")?.observation.status).toBe(
      "matched",
    );
  });

  it("does not replace an unavailable candidate with an empty member list", async () => {
    const setup = await harness();
    setup.repositories = {
      ...setup.repositories,
      control: {
        ...setup.repositories.control,
        releaseCandidate: { findReleaseCandidate: async () => null },
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(graph.candidateAssessmentLineage).toEqual({
      status: "candidate_unavailable",
      source: { kind: "release_candidate", reference: setup.input.candidate },
      observation: { status: "missing" },
      inspectionUsage: { references: 0, referenceBytes: 0 },
    });
  });

  it.each([
    "parent_hash",
    "target",
    "reference",
    "selector_failure",
    "missing_edge",
    "duplicate_edge",
    "missing_node",
    "root_reference",
    "history_hash",
    "history_missing",
    "history_empty",
  ] as const)("rejects internal %s provenance corruption", async (change) => {
    const setup = await harness(undefined, {});
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const altered = structuredClone(graph);
    const edges = [...altered.edges];
    const nodes = [...altered.nodes];
    const index = edges.findIndex(
      (e) => e.parent.kind === "assessment" && e.reference.path === "/aggregate",
    );
    const edge = edges[index];
    if (!edge) throw new Error("Missing aggregate edge");
    if (change === "parent_hash") edges[index] = { ...edge, parentRecordSha256: "f".repeat(64) };
    if (change === "target") edges[index] = { ...edge, target: null };
    if (change === "reference")
      edges[index] = {
        ...edge,
        reference: {
          kind: "evaluation_run_identity",
          path: "/aggregate",
          evaluationRunId: "run_other",
        },
      };
    if (change === "selector_failure")
      edges[index] = { ...edge, selectorFailure: { status: "missing" } };
    if (change === "missing_edge") edges.splice(index, 1);
    if (change === "duplicate_edge") edges.push(edge);
    if (change === "missing_node")
      nodes.splice(
        nodes.findIndex((n) => n.read.source.kind === "evaluation_aggregate"),
        1,
      );
    if (change === "root_reference") setup.input.candidate.definitionSha256 = "f".repeat(64);
    const parents = [...altered.evaluationSnapshots.parents];
    const assessmentIndex = parents.findIndex((p) => p.source.kind === "assessment");
    const parent = parents[assessmentIndex];
    if (!parent) throw new Error("Missing assessment report");
    if (change === "history_hash")
      parents[assessmentIndex] = { ...parent, recordSha256: "f".repeat(64) };
    if (change === "history_missing") parents.splice(assessmentIndex, 1);
    if (change === "history_empty") parents[assessmentIndex] = { ...parent, checks: [] };
    expect(() =>
      inspect(setup, {
        ...altered,
        nodes,
        edges,
        evaluationSnapshots: { ...altered.evaluationSnapshots, parents },
      }),
    ).toThrow("reference_conflict");
  });

  it("meters repeated traversal at exact limits, rejects one below and owns its output", async () => {
    const setup = await harness(undefined, {});
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const usage = graph.candidateAssessmentLineage.inspectionUsage;
    const exact = { maxReferences: usage.references, maxReferenceBytes: usage.referenceBytes };
    const output = inspect(setup, graph, exact);
    expect(output).toEqual(graph.candidateAssessmentLineage);
    expect(() =>
      inspect(setup, graph, { ...exact, maxReferences: exact.maxReferences - 1 }),
    ).toThrow("reference_limit_exceeded");
    expect(() =>
      inspect(setup, graph, { ...exact, maxReferenceBytes: exact.maxReferenceBytes - 1 }),
    ).toThrow("reference_bytes_exceeded");
    const before = structuredClone(graph);
    if (output.status !== "inspected") throw new Error("Expected lineage");
    Object.assign(output.candidate.source.reference, { definitionSha256: "f".repeat(64) });
    expect(graph).toEqual(before);
  });
});

describe("candidate-owned policy assessment declarations", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4 * 1024 * 1024 };

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("Missing assessment test fixture member");
    return value;
  }

  async function capture(change: (setup: Awaited<ReturnType<typeof harness>>) => void = () => {}) {
    const setup = await harness();
    change(setup);
    setup.candidate = candidateDigest(setup.candidate);
    setup.policy = policyDigest(setup.policy);
    setup.input = request(setup.candidate, setup.policy);
    setup.repositories = {
      ...setup.repositories,
      control: {
        ...setup.repositories.control,
        releaseCandidate: { findReleaseCandidate: async () => setup.candidate },
        releasePolicy: { findReleasePolicy: async () => setup.policy },
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    return { setup, graph };
  }

  it("retains complete candidate declarations and each original rule occurrence independently", async () => {
    const { setup, graph } = await capture((value) => {
      const reference = required(value.candidate.assessments[0]);
      const modelReference = {
        assessmentExtensionId: "assessment_model",
        definitionSha256: "a".repeat(64),
      };
      value.candidate.modelAssuranceAssessments = [modelReference];
      const template = required(value.policy.rules[0]);
      const predicates: ReleasePolicy["rules"][number]["predicate"][] = [
        {
          kind: "coverage_floor",
          sourceKind: "assessment_samples",
          assessment: reference,
          sampleClass: "observed",
          minimumCount: 1,
          unit: "cases",
        },
        {
          kind: "uncertainty_bound",
          assessment: reference,
          bound: "lower",
          comparator: "at_least",
          confidenceLevelBasisPoints: 9500,
          intervalMethod: "wilson_score_interval",
          intervalMethodVersion: "1.0.0",
          thresholdBasisPoints: 0,
          unit: "basis_points",
        },
        {
          kind: "eligibility_required",
          assessmentClass: "evaluation",
          assessment: reference,
          expected: "eligible",
        },
        {
          kind: "eligibility_required",
          assessmentClass: "model_assurance",
          assessment: modelReference,
          expected: "eligible",
        },
      ];
      value.policy.rules = [
        ...predicates.map((predicate, i) => ({
          ...structuredClone(template),
          ruleId: `rule_assessment_${i}`,
          predicate,
        })),
        ...value.policy.rules.filter(({ predicate }) => predicate.kind === "approval_required"),
      ].sort((left, right) =>
        left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0,
      );
    });
    const report = graph.policyAssessments;
    if (report.status !== "inspected") throw new Error("Expected assessment inspection");
    expect(report.members).toHaveLength(2);
    expect(report.rules).toHaveLength(4);
    expect(report.rules.map(({ ruleId }) => ruleId)).toEqual(
      setup.policy.rules
        .filter(({ predicate }) => "assessment" in predicate)
        .map(({ ruleId }) => ruleId),
    );
    expect(report.rules.map(({ membership }) => membership.status)).toEqual(
      Array(4).fill("declared"),
    );
    expect(report.rules.map(({ observation }) => observation.status)).toEqual([
      "verified",
      "verified",
      "verified",
      "missing",
    ]);
    expect(new Set(report.rules.map(({ policyEdgeIndex }) => policyEdgeIndex)).size).toBe(4);
    for (const rule of report.rules) {
      const edge = required(graph.edges[rule.policyEdgeIndex]);
      expect(edge.parentRecordSha256).toBe(report.policy.recordSha256);
      expect(edge.reference.path).toBe(`/rules/${rule.ruleIndex}/predicate/assessment`);
      expect(edge.target).toEqual(rule.source);
      if (rule.membership.status !== "declared") throw new Error("Expected declared member");
      const candidateEdge = required(graph.edges[rule.membership.candidateEdgeIndex]);
      expect(candidateEdge.parentRecordSha256).toBe(report.candidate.recordSha256);
      expect(candidateEdge.target).toEqual(rule.source);
    }
    expect(report.inspectionUsage.references).toBe(6);
    expect(report).not.toHaveProperty("verdict");
    expect(report).not.toHaveProperty("sealed");
  });

  it("does not treat a readable same-scope assessment as candidate-owned", async () => {
    const { graph } = await capture(({ candidate }) => {
      candidate.assessments = [
        { assessmentId: "assessment_other", definitionSha256: "b".repeat(64) },
      ];
    });
    const report = graph.policyAssessments;
    if (report.status !== "inspected") throw new Error("Expected inspection");
    expect(report.members[0]?.observation.status).toBe("missing");
    expect(report.rules.length).toBeGreaterThan(0);
    expect(
      report.rules.every(
        ({ membership, observation }) =>
          membership.status === "not_declared" && observation.status === "verified",
      ),
    ).toBe(true);
  });

  it("retains unused declarations even when no policy rule references an assessment", async () => {
    const { graph } = await capture(({ policy }) => {
      policy.rules = policy.rules.filter(({ predicate }) => !("assessment" in predicate));
    });
    const report = graph.policyAssessments;
    expect(report).toMatchObject({
      status: "inspected",
      rules: [],
      members: [{ observation: { status: "verified" } }],
    });
  });

  it.each(["missing", "record_invalid", "reference_mismatch", "not_yet_available"] as const)(
    "keeps declared membership separate from %s record availability",
    async (failure) => {
      const { graph } = await capture((setup) => {
        const repository = setup.repositories.evidence.evaluation;
        setup.repositories = {
          ...setup.repositories,
          evidence: {
            ...setup.repositories.evidence,
            evaluation: new Proxy(repository, {
              get(target, key) {
                if (key === "findAssessment")
                  return async (...args: Parameters<typeof repository.findAssessment>) => {
                    const record = await repository.findAssessment(...args);
                    if (!record) throw new Error("Expected retained assessment");
                    if (failure === "missing") return null;
                    if (failure === "record_invalid")
                      return { ...record, definitionSha256: "f".repeat(64) };
                    if (failure === "reference_mismatch") {
                      const changed = { ...record, assessmentId: "assessment_wrong" };
                      const body = structuredClone(changed) as unknown as Fields;
                      for (const key of evaluationRecordDescriptors.assessment.receiptKeys)
                        delete body[key];
                      changed.definitionSha256 = digestEvaluationRecordDefinition(
                        "assessment",
                        changed.scope,
                        body,
                      );
                      return changed;
                    }
                    return { ...record, createdAt: "2026-10-02T00:00:00.000Z" };
                  };
                const value: unknown = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          },
        };
      });
      const report = graph.policyAssessments;
      if (report.status !== "inspected") throw new Error("Expected inspection");
      const observation =
        failure === "missing" ? { status: "missing" } : { status: "unavailable", reason: failure };
      expect(report.members[0]?.observation).toEqual(observation);
      for (const rule of report.rules) {
        expect(rule.membership.status).toBe("declared");
        expect(rule.observation).toEqual(observation);
      }
    },
  );

  it.each(["release_candidate", "release_policy"] as const)(
    "preserves unavailable %s roots instead of reporting empty successful bindings",
    async (kind) => {
      const setup = await harness();
      setup.repositories = {
        ...setup.repositories,
        control: {
          ...setup.repositories.control,
          ...(kind === "release_candidate"
            ? { releaseCandidate: { findReleaseCandidate: async () => null } }
            : {
                releasePolicy: {
                  findReleasePolicy: async () => ({
                    ...setup.policy,
                    definitionSha256: "f".repeat(64),
                  }),
                },
              }),
        },
      };
      const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
      expect(graph.policyAssessments).toMatchObject({
        status: "roots_unavailable",
        unavailableRoots: [
          {
            source: { kind },
            observation:
              kind === "release_candidate"
                ? { status: "missing" }
                : { status: "unavailable", reason: "record_invalid" },
          },
        ],
        inspectionUsage: { references: 0, referenceBytes: 0 },
      });
      expect(graph.policyAssessments).not.toHaveProperty("rules");
    },
  );

  it("rejects a changed digest under the same declared assessment identity", async () => {
    await expect(
      capture(({ candidate }) => {
        required(candidate.assessments[0]).definitionSha256 = "f".repeat(64);
      }),
    ).rejects.toMatchObject({ reason: "reference_conflict" });
  });

  it.each([
    "parent_hash",
    "target",
    "reference",
    "selector_failure",
    "missing_edge",
    "duplicate_edge",
    "missing_node",
    "root_reference",
  ] as const)("rejects internal %s provenance corruption", async (change) => {
    const { setup, graph } = await capture();
    const altered = structuredClone(graph) as unknown as {
      nodes: (typeof graph.nodes)[number][];
      edges: (typeof graph.edges)[number][];
    };
    const edgeIndex = altered.edges.findIndex(
      ({ parent, reference }) =>
        parent.kind === "release_candidate" && reference.path === "/assessments/0",
    );
    const edge = required(altered.edges[edgeIndex]);
    if (change === "parent_hash")
      altered.edges[edgeIndex] = { ...edge, parentRecordSha256: "f".repeat(64) };
    if (change === "target") altered.edges[edgeIndex] = { ...edge, target: null };
    if (change === "reference")
      altered.edges[edgeIndex] = {
        ...edge,
        reference: {
          kind: "evaluation_run_identity",
          path: edge.reference.path,
          evaluationRunId: "run_other",
        },
      };
    if (change === "selector_failure")
      altered.edges[edgeIndex] = { ...edge, selectorFailure: { status: "missing" } };
    if (change === "missing_edge") altered.edges.splice(edgeIndex, 1);
    if (change === "duplicate_edge") altered.edges.push(edge);
    if (change === "missing_node")
      altered.nodes = altered.nodes.filter(({ read }) => read.source.kind !== "assessment");
    if (change === "root_reference") setup.input.candidate.definitionSha256 = "f".repeat(64);
    expect(() => inspectCapturedPolicyAssessments(setup.input, altered, limits)).toThrow(
      expect.objectContaining({ reason: "reference_conflict" }),
    );
  });

  it("admits exact repeated inspection budgets and rejects one below each limit", async () => {
    const { setup, graph } = await capture();
    const usage = graph.policyAssessments.inspectionUsage;
    const exact = { maxReferences: usage.references, maxReferenceBytes: usage.referenceBytes };
    expect(inspectCapturedPolicyAssessments(setup.input, graph, exact)).toEqual(
      graph.policyAssessments,
    );
    expect(() =>
      inspectCapturedPolicyAssessments(setup.input, graph, {
        ...exact,
        maxReferences: exact.maxReferences - 1,
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_limit_exceeded" }));
    expect(() =>
      inspectCapturedPolicyAssessments(setup.input, graph, {
        ...exact,
        maxReferenceBytes: exact.maxReferenceBytes - 1,
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
    const before = structuredClone(graph);
    const report = inspectCapturedPolicyAssessments(setup.input, graph, exact);
    if (report.status !== "inspected") throw new Error("Expected inspection");
    Object.assign(report.candidate.source.reference, { definitionSha256: "f".repeat(64) });
    expect(graph).toEqual(before);
  });
});

describe("original model endpoint graph mapping", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4000000 };
  const setup = (operation: "chat" | "generate_content" | "text_completion" = "chat") =>
    harness(undefined, {
      dataset: "matched",
      endpointProfile: true,
      modelEndpoint: true,
      modelCapture: (definition) => {
        const model = definition.interactionCapture.interactions[0];
        if (model?.kind !== "model" || !model.attempts[0]) throw new Error("Missing model fixture");
        model.attempts[0].provider.operation = operation;
        model.attempts.push({
          ...structuredClone(model.attempts[0]),
          attemptId: "attempt_repeated",
          sequence: 1,
        });
      },
    });
  type Graph = Awaited<ReturnType<typeof capturePolicyRecordGraph>>;
  const modelEdges = (graph: Graph) =>
    graph.edges.filter(({ reference }) => reference.kind === "endpoint_profile_selector");
  const kinds = ["provider_name", "operation", "boundary_kind", "configuration"];
  const checks = (status: string) => kinds.map((kind) => ({ kind, observation: { status } }));
  function changedEndpoint(
    record: EndpointProfileRecord,
    mutate: (r: EndpointProfileRecord) => void,
  ) {
    const changed = structuredClone(record);
    mutate(changed);
    const {
      registeredAt: _at,
      registeredByPrincipalId: _by,
      definitionSha256: _sha,
      schemaVersion: _version,
      scope,
      ...definition
    } = changed;
    changed.definitionSha256 = digestEndpointProfile(scope, definition);
    return changed;
  }

  it.each(["chat", "generate_content", "text_completion"] as const)(
    "retains both original %s attempts, independent data and four checks without asserting authority",
    async (operation) => {
      const h = await setup(operation);
      const record = h.endpointProfile;
      if (!record || !h.repositories.endpointProfiles)
        throw new Error("Missing independent endpoint");
      const lookup = vi.spyOn(h.repositories.endpointProfiles, "findEndpointProfile");
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const edges = modelEdges(graph);
      expect(edges).toHaveLength(2);
      expect(edges.map(({ reference }) => reference.path)).toEqual([
        "/interactionCapture/interactions/0/attempts/0/provider",
        "/interactionCapture/interactions/0/attempts/1/provider",
      ]);
      expect(lookup).toHaveBeenCalledTimes(2);
      for (const call of lookup.mock.calls)
        expect(call).toEqual([
          h.input.scope,
          record.endpointProfileId,
          record.endpointProfileVersion,
        ]);
      const nodes = graph.nodes.filter(({ read }) => read.source.kind === "endpoint_profile");
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.read).toMatchObject({
        record,
        observation: {
          status: "verified",
          recordSha256: createHash("sha256")
            .update(encodeEvaluationCanonicalJson(record))
            .digest("hex"),
        },
      });
      for (const edge of edges) {
        expect(edge.endpointChecks).toEqual(checks("matched"));
        expect(edge.endpointFailure).toBeUndefined();
        expect(edge.target).toEqual(nodes[0]?.read.source);
        expect(graph.recordClosure.frontier).toContainEqual({
          edgeIndex: graph.edges.indexOf(edge),
          kind: "retained_declaration",
        });
      }
      expect(deriveCapturedRecordClosure(h.input, graph, limits)).toEqual({
        entries: graph.entries,
        closure: graph.recordClosure,
      });
      expect(graph).not.toHaveProperty("sealed");
      expect(graph).not.toHaveProperty("authority");
    },
  );

  it.each(["provider", "operation", "boundary", "configuration"] as const)(
    "retains valid conflicting %s data with explicit context mismatch",
    async (field) => {
      const h = await setup();
      if (!h.endpointProfile) throw new Error("Missing independent endpoint");
      const record = changedEndpoint(h.endpointProfile, (r) => {
        if (field === "provider") r.provider = "different/provider";
        else if (field === "operation") r.operations = ["other.operation"];
        else if (field === "boundary") r.boundaryKinds = ["tool"];
        else r.configuration.artifactId = "artifact_configuration_other";
      });
      const graph = await capturePolicyRecordGraph(h.input, {
        ...h.repositories,
        endpointProfiles: new StaticEndpointProfileCatalogue([record]),
      });
      expect(
        graph.nodes.find(({ read }) => read.source.kind === "endpoint_profile")?.read.record,
      ).toEqual(record);
      for (const edge of modelEdges(graph)) {
        expect(edge.target?.kind).toBe("endpoint_profile");
        expect(edge.endpointFailure).toBeUndefined();
        expect(
          edge.endpointChecks
            ?.filter((c) => c.observation.status === "mismatch")
            .map((c) => c.kind),
        ).toEqual([
          field === "provider"
            ? "provider_name"
            : field === "operation"
              ? "operation"
              : field === "boundary"
                ? "boundary_kind"
                : "configuration",
        ]);
      }
      expect(deriveCapturedRecordClosure(h.input, graph, limits).entries).toEqual(graph.entries);
    },
  );

  it.each([
    "missing",
    "invalid",
    "future",
    "tenantId",
    "projectId",
    "environmentId",
    "id",
    "version",
    "optional",
  ] as const)(
    "retains original %s mapping failure and unavailable context without inventing a source",
    async (field) => {
      const h = await setup();
      if (!h.endpointProfile) throw new Error("Missing independent endpoint");
      let raw: EndpointProfileRecord | null = structuredClone(h.endpointProfile);
      if (field === "missing") raw = null;
      else if (field === "invalid") raw.definitionSha256 = "0".repeat(64);
      else if (field === "future") raw.registeredAt = "2026-10-02T00:00:00.000Z";
      else if (field !== "optional")
        raw = changedEndpoint(raw, (r) => {
          if (field === "id") r.endpointProfileId = "endpoint_other";
          else if (field === "version")
            r.endpointProfileVersion = r.endpointProfileVersion.toLowerCase();
          else r.scope[field] = "scope_other";
        });
      const { endpointProfiles: _absent, ...base } = h.repositories;
      const lookup = vi.fn(async () => raw);
      const graph = await capturePolicyRecordGraph(
        h.input,
        field === "optional"
          ? base
          : { ...base, endpointProfiles: { findEndpointProfile: lookup } },
      );
      expect(
        graph.nodes.filter(({ read }) => read.source.kind === "endpoint_profile"),
      ).toHaveLength(0);
      const failure =
        field === "missing" || field === "optional"
          ? { status: "missing" }
          : {
              status: "unavailable",
              reason:
                field === "invalid"
                  ? "record_invalid"
                  : field === "future"
                    ? "not_yet_available"
                    : "reference_mismatch",
            };
      for (const edge of modelEdges(graph)) {
        expect(edge.target).toBeNull();
        expect(edge.endpointFailure).toEqual(failure);
        expect(edge.endpointChecks).toEqual(checks("unavailable"));
        expect(edge.reference).not.toHaveProperty("definitionSha256");
      }
      if (field !== "optional") expect(lookup).toHaveBeenCalledTimes(2);
      expect(deriveCapturedRecordClosure(h.input, graph, limits).entries).toEqual(graph.entries);
    },
  );

  it("meters each whole-parent inspection and lookup at exact and one-below cumulative limits", async () => {
    const h = await setup();
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const exact = {
      ...h.input.limits,
      maxAcquisitionRecords: Math.max(graph.usage.records, graph.usage.references),
      maxAcquisitionRecordBytes: graph.usage.bytes + graph.usage.referenceBytes,
    };
    expect(
      (await capturePolicyRecordGraph(request(h.candidate, h.policy, exact), h.repositories)).usage,
    ).toEqual(graph.usage);
    for (const patch of [
      { maxAcquisitionRecords: exact.maxAcquisitionRecords - 1 },
      { maxAcquisitionRecordBytes: exact.maxAcquisitionRecordBytes - 1 },
    ])
      await expect(
        capturePolicyRecordGraph(
          request(h.candidate, h.policy, { ...exact, ...patch }),
          h.repositories,
        ),
      ).rejects.toThrow();
    for (const patch of [
      { maxReferences: graph.recordClosure.inspectionUsage.references - 1 },
      { maxReferenceBytes: graph.recordClosure.inspectionUsage.referenceBytes - 1 },
    ])
      expect(() => deriveCapturedRecordClosure(h.input, graph, { ...limits, ...patch })).toThrow();
  });

  it.each(["digest", "receipt", "absence"] as const)(
    "rejects intervening %s changes under one original model identity",
    async (field) => {
      const h = await setup();
      if (!h.endpointProfile) throw new Error("Missing independent endpoint");
      const record = h.endpointProfile;
      const changed = changedEndpoint(record, (r) => {
        if (field === "digest") r.destination.hostname = "other.provider.example";
        else r.registeredByPrincipalId = "operator_changed";
      });
      let calls = 0;
      await expect(
        capturePolicyRecordGraph(h.input, {
          ...h.repositories,
          endpointProfiles: {
            findEndpointProfile: async () =>
              ++calls === 1 ? (field === "absence" ? null : record) : changed,
          },
        }),
      ).rejects.toMatchObject({
        reason: field === "digest" ? "reference_conflict" : "observation_conflict",
      });
      expect(calls).toBe(2);
    },
  );

  it("independently rejects omitted/substituted model origins, sources, receipts and contextual projections", async () => {
    const h = await setup();
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const edgeIndex = graph.edges.findIndex(
      ({ reference }) => reference.kind === "endpoint_profile_selector",
    );
    const nodeIndex = graph.nodes.findIndex(({ read }) => read.source.kind === "endpoint_profile");
    for (const fault of [
      "omit_edge",
      "path",
      "parent_hash",
      "target",
      "omit_node",
      "receipt",
      "omit_checks",
      "checks_order",
      "checks_status",
      "checks_extra",
      "failure",
      "cross_kind",
    ]) {
      const changed = structuredClone(graph);
      const edge = changed.edges[edgeIndex];
      const node = changed.nodes[nodeIndex];
      if (!edge || !node) throw new Error("Missing retained model observation");
      if (fault === "omit_edge")
        Reflect.set(
          changed,
          "edges",
          changed.edges.filter((_, i) => i !== edgeIndex),
        );
      else if (fault === "path") Reflect.set(edge.reference, "path", "/source");
      else if (fault === "parent_hash") Reflect.set(edge, "parentRecordSha256", "0".repeat(64));
      else if (fault === "target") Reflect.set(edge, "target", null);
      else if (fault === "omit_node")
        Reflect.set(
          changed,
          "nodes",
          changed.nodes.filter((_, i) => i !== nodeIndex),
        );
      else if (fault === "receipt")
        Reflect.set(node.read.record as object, "registeredByPrincipalId", "operator_other");
      else if (fault === "omit_checks") Reflect.deleteProperty(edge, "endpointChecks");
      else if (fault === "checks_order")
        Reflect.set(edge, "endpointChecks", [...(edge.endpointChecks ?? [])].reverse());
      else if (fault === "checks_status")
        Reflect.set(edge.endpointChecks?.[0]?.observation as object, "status", "mismatch");
      else if (fault === "checks_extra")
        Reflect.set(edge.endpointChecks?.[0] as object, "authority", true);
      else if (fault === "failure") Reflect.set(edge, "endpointFailure", { status: "missing" });
      else {
        const other = changed.edges.find(
          ({ reference }) => reference.kind !== "endpoint_profile_selector",
        );
        if (!other) throw new Error("Missing non-model edge");
        Reflect.set(other, "endpointChecks", checks("unavailable"));
      }
      expect(() => deriveCapturedRecordClosure(h.input, changed, limits), fault).toThrow();
    }
  });

  it("reinspects mapping and original full receipts before following descendants, including absent creation", async () => {
    const h = await setup();
    if (!h.endpointProfile) throw new Error("Missing independent endpoint");
    const retained = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(
      await acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        retained,
      ),
    ).toEqual(retained);
    const missing = { ...h.repositories, endpointProfiles: new StaticEndpointProfileCatalogue([]) };
    for (const endpointProfiles of [
      missing.endpointProfiles,
      new StaticEndpointProfileCatalogue([
        { ...h.endpointProfile, registeredByPrincipalId: "operator_other" },
      ]),
      new StaticEndpointProfileCatalogue([
        changedEndpoint(h.endpointProfile, (r) => {
          r.provider = "other/provider";
        }),
      ]),
    ])
      await expect(
        acquirePolicyRecordGraph(
          h.input,
          { ...h.repositories, endpointProfiles },
          new AcquisitionBudget(h.input.limits),
          retained,
        ),
      ).rejects.toMatchObject({
        code: "policy_captured_observation_recheck_failed",
        reason: "source_revision_changed",
      });
    const absent = await capturePolicyRecordGraph(h.input, missing);
    await expect(
      acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        absent,
      ),
    ).rejects.toMatchObject({
      code: "policy_captured_observation_recheck_failed",
      reason: "source_revision_changed",
    });
  });
  it("rejects conflicting descriptors under one artifact identity instead of accepting a context-only mismatch", async () => {
    const h = await setup();
    if (!h.endpointProfile) throw new Error("Missing independent endpoint");
    const record = changedEndpoint(h.endpointProfile, (r) => {
      r.configuration.sizeBytes++;
    });
    await expect(
      capturePolicyRecordGraph(h.input, {
        ...h.repositories,
        endpointProfiles: new StaticEndpointProfileCatalogue([record]),
      }),
    ).rejects.toMatchObject({
      reason: "reference_conflict",
      identity: `artifact:${record.configuration.artifactId}`,
    });
  });

  it("rejects forged failure reasons/extra fields and checks even on absent mappings", async () => {
    const h = await setup();
    const graph = await capturePolicyRecordGraph(h.input, {
      ...h.repositories,
      endpointProfiles: new StaticEndpointProfileCatalogue([]),
    });
    const index = graph.edges.findIndex(
      ({ reference }) => reference.kind === "endpoint_profile_selector",
    );
    for (const fault of ["omit", "lineage", "extra", "matched", "selector", "registration"]) {
      const changed = structuredClone(graph);
      const edge = changed.edges[index];
      if (!edge) throw new Error("Missing model occurrence");
      if (fault === "omit") Reflect.deleteProperty(edge, "endpointFailure");
      else if (fault === "lineage")
        Reflect.set(edge, "endpointFailure", { status: "unavailable", reason: "lineage_mismatch" });
      else if (fault === "extra")
        Reflect.set(edge, "endpointFailure", { status: "missing", authority: true });
      else if (fault === "matched") Reflect.set(edge, "endpointChecks", checks("matched"));
      else
        Reflect.set(edge, fault === "selector" ? "selectorFailure" : "registrationFailure", {
          status: "missing",
        });
      expect(() => deriveCapturedRecordClosure(h.input, changed, limits), fault).toThrow();
    }
  });

  it("propagates operational endpoint port failures without a fabricated missing mapping", async () => {
    const h = await setup();
    const failure = new Error("endpoint storage unavailable");
    await expect(
      capturePolicyRecordGraph(h.input, {
        ...h.repositories,
        endpointProfiles: {
          findEndpointProfile: async () => {
            throw failure;
          },
        },
      }),
    ).rejects.toBe(failure);
  });
});

describe("retained live endpoint profile graph acquisition", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4000000 };
  const setup = () =>
    harness("valid", {
      dataset: "matched",
      replayBindings: true,
      endpointProfile: true,
      plan: (plan) => {
        const live = plan.boundaries.find((b) => b.mode === "live_provider");
        if (!live) throw new Error("Missing independently bound live endpoint");
        plan.boundaries.push({
          ...structuredClone(live),
          boundaryId: "boundary_2_endpoint_repeat",
        });
      },
    });
  type Graph = Awaited<ReturnType<typeof capturePolicyRecordGraph>>;
  const endpointEdges = (graph: Graph) =>
    graph.edges.filter(
      ({ reference }) =>
        reference.kind === "replay_declaration" &&
        reference.declaration.kind === "endpoint_profile",
    );

  it("retains both original live declarations, one exact read and the complete configuration descriptor without closing current authority", async () => {
    const h = await setup();
    const record = h.endpointProfile;
    if (!record || !h.repositories.endpointProfiles) throw new Error("Missing endpoint catalogue");
    const lookup = vi.spyOn(h.repositories.endpointProfiles, "findEndpointProfile");
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(
      h.input.scope,
      record.endpointProfileId,
      record.endpointProfileVersion,
    );
    const edges = endpointEdges(graph);
    expect(edges.map(({ reference }) => reference.path)).toEqual([
      "/boundaries/1/endpointProfile",
      "/boundaries/2/endpointProfile",
    ]);
    const target = {
      kind: "endpoint_profile",
      reference: {
        endpointProfileId: record.endpointProfileId,
        endpointProfileVersion: record.endpointProfileVersion,
        definitionSha256: record.definitionSha256,
      },
    };
    const nodes = graph.nodes.filter(({ read }) => read.source.kind === "endpoint_profile");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      read: { source: target, record, observation: { status: "verified" } },
      references: [{ kind: "artifact", path: "/configuration", reference: record.configuration }],
    });
    for (const edge of edges) {
      expect(edge.parent.kind).toBe("replay_plan");
      expect(edge.target).toEqual(target);
      expect(graph.recordClosure.frontier).toContainEqual({
        edgeIndex: graph.edges.indexOf(edge),
        kind: "retained_declaration",
      });
    }
    const checks = graph.replayPlans.plans[0]?.checks.filter((c) => c.kind.startsWith("endpoint_"));
    expect(checks).toHaveLength(6);
    expect(checks?.every((c) => c.observation.status === "matched")).toBe(true);
    const derived = deriveCapturedRecordClosure(h.input, graph, limits);
    expect(derived.entries).toEqual(graph.entries);
    expect(derived.closure).toEqual(graph.recordClosure);
    expect(graph).not.toHaveProperty("sealed");
    expect(graph).not.toHaveProperty("authority");

    const exact = {
      ...h.input.limits,
      maxAcquisitionRecords: Math.max(graph.usage.records, graph.usage.references),
      maxAcquisitionRecordBytes: graph.usage.bytes + graph.usage.referenceBytes,
    };
    expect(
      (await capturePolicyRecordGraph(request(h.candidate, h.policy, exact), h.repositories)).usage,
    ).toEqual(graph.usage);
    for (const patch of [
      { maxAcquisitionRecords: exact.maxAcquisitionRecords - 1 },
      { maxAcquisitionRecordBytes: exact.maxAcquisitionRecordBytes - 1 },
    ])
      await expect(
        capturePolicyRecordGraph(
          request(h.candidate, h.policy, { ...exact, ...patch }),
          h.repositories,
        ),
      ).rejects.toThrow();
  });

  it("retains known exact targets for missing, future and invalid profiles, including an absent optional catalogue", async () => {
    const h = await setup();
    const record = h.endpointProfile;
    if (!record) throw new Error("Missing independently defined endpoint");
    for (const [raw, observation] of [
      [null, { status: "missing" }],
      [
        { ...record, registeredAt: "2026-10-02T00:00:00.001Z" },
        { status: "unavailable", reason: "not_yet_available" },
      ],
      [
        { ...record, authority: "approved" },
        { status: "unavailable", reason: "record_invalid" },
      ],
      [
        { ...record, definitionSha256: "0".repeat(64) },
        { status: "unavailable", reason: "record_invalid" },
      ],
    ]) {
      const lookup = vi.fn(async () => raw);
      const graph = await capturePolicyRecordGraph(h.input, {
        ...h.repositories,
        endpointProfiles: { findEndpointProfile: lookup },
      });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(graph.nodes.find(({ read }) => read.source.kind === "endpoint_profile")).toMatchObject(
        {
          read: { observation, record: null },
          references: null,
        },
      );
      expect(endpointEdges(graph)).toHaveLength(2);
      expect(endpointEdges(graph).every(({ target }) => target?.kind === "endpoint_profile")).toBe(
        true,
      );
      expect(
        graph.replayPlans.plans[0]?.checks
          .filter((c) => c.kind.startsWith("endpoint_"))
          .every((c) => c.observation.status === "unavailable"),
      ).toBe(true);
      expect(deriveCapturedRecordClosure(h.input, graph, limits).entries).toEqual(graph.entries);
    }
    const { endpointProfiles: _absent, ...repositories } = h.repositories;
    const graph = await capturePolicyRecordGraph(h.input, repositories);
    expect(
      graph.nodes.find(({ read }) => read.source.kind === "endpoint_profile")?.read.observation,
    ).toEqual({ status: "missing" });
  });

  it("rejects conflicting original expected hashes instead of selecting a body", async () => {
    const h = await harness("valid", {
      dataset: "matched",
      replayBindings: true,
      endpointProfile: true,
      plan: (plan) => {
        const live = plan.boundaries.find((b) => b.mode === "live_provider");
        if (!live || live.mode !== "live_provider") throw new Error("Missing live boundary");
        plan.boundaries.push({
          ...structuredClone(live),
          boundaryId: "boundary_2_conflict",
          endpointProfile: { ...live.endpointProfile, definitionSha256: "0".repeat(64) },
        });
      },
    });
    await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toMatchObject({
      reason: "reference_conflict",
    });
  });

  it("rejects changed full receipts, disappearing profiles and formerly missing creation on reinspection", async () => {
    const h = await setup();
    const record = h.endpointProfile;
    if (!record) throw new Error("Missing independent endpoint fixture");
    const retained = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(
      await acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        retained,
      ),
    ).toEqual(retained);
    const missing = { ...h.repositories, endpointProfiles: new StaticEndpointProfileCatalogue([]) };
    for (const repositories of [
      missing,
      {
        ...h.repositories,
        endpointProfiles: new StaticEndpointProfileCatalogue([
          { ...record, registeredByPrincipalId: "operator_changed" },
        ]),
      },
      {
        ...h.repositories,
        endpointProfiles: new StaticEndpointProfileCatalogue([
          { ...record, registeredAt: "2026-10-02T00:00:00.001Z" },
        ]),
      },
    ])
      await expect(
        acquirePolicyRecordGraph(
          h.input,
          repositories,
          new AcquisitionBudget(h.input.limits),
          retained,
        ),
      ).rejects.toMatchObject({
        code: "policy_captured_observation_recheck_failed",
        reason: "source_revision_changed",
      });
    const absent = await capturePolicyRecordGraph(h.input, missing);
    await expect(
      acquirePolicyRecordGraph(
        h.input,
        h.repositories,
        new AcquisitionBudget(h.input.limits),
        absent,
      ),
    ).rejects.toMatchObject({ reason: "source_revision_changed" });
  });

  it("independently rejects omitted endpoint nodes, original declarations, targets and observations", async () => {
    const h = await setup();
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const nodeIndex = graph.nodes.findIndex(({ read }) => read.source.kind === "endpoint_profile");
    const edgeIndex = graph.edges.indexOf(endpointEdges(graph)[0] as Graph["edges"][number]);
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(edgeIndex).toBeGreaterThanOrEqual(0);
    for (const mutate of [
      (copy: Graph) => (copy.nodes as unknown[]).splice(nodeIndex, 1),
      (copy: Graph) => (copy.edges as unknown[]).splice(edgeIndex, 1),
      (copy: Graph) => Reflect.set(copy.edges[edgeIndex] as object, "target", null),
      (copy: Graph) =>
        Reflect.set(copy.edges[edgeIndex] as object, "selectorFailure", { status: "missing" }),
      (copy: Graph) =>
        Reflect.set(
          copy.nodes[nodeIndex]?.read.observation as object,
          "recordSha256",
          "0".repeat(64),
        ),
    ]) {
      const copy = structuredClone(graph);
      mutate(copy);
      expect(() => deriveCapturedRecordClosure(h.input, copy, limits)).toThrow();
    }
  });
});

describe("retained qualification policy graph acquisition", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4000000 };

  it("reads one exact independent policy for repeated original report declarations and retains authority frontiers", async () => {
    const setup = await harness(undefined, { qualificationPolicy: true });
    const record = setup.qualificationPolicy;
    if (!record) throw new Error("Missing independently defined policy");
    const catalogue = new StaticQualificationPolicyCatalogue([record]);
    const lookup = vi.fn((...args: Parameters<typeof catalogue.findQualificationPolicy>) =>
      catalogue.findQualificationPolicy(...args),
    );
    const graph = await capturePolicyRecordGraph(setup.input, {
      ...setup.repositories,
      qualificationPolicies: { findQualificationPolicy: lookup },
    });
    const edges = graph.edges.filter(({ reference }) => reference.kind === "qualification_policy");
    expect(edges).toHaveLength(2);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(
      setup.input.scope,
      record.policyId,
      record.policyVersionId,
    );
    const target = {
      kind: "qualification_policy",
      reference: {
        policyId: record.policyId,
        policyVersionId: record.policyVersionId,
        definitionSha256: record.definitionSha256,
      },
    };
    const nodes = graph.nodes.filter(({ read }) => read.source.kind === "qualification_policy");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      read: { source: target, record, observation: { status: "verified" } },
      references: [],
    });
    for (const edge of edges) {
      expect(edge.parent.kind).toBe("qualification_report");
      expect(edge.target).toEqual(target);
      expect(graph.recordClosure.frontier).toContainEqual({
        edgeIndex: graph.edges.indexOf(edge),
        kind: "retained_declaration",
      });
    }
    const derived = deriveCapturedRecordClosure(setup.input, graph, limits);
    expect(derived.entries).toEqual(graph.entries);
    expect(derived.closure).toEqual(graph.recordClosure);
    expect(graph).not.toHaveProperty("sealed");
    expect(graph).not.toHaveProperty("qualified");

    // Every occurrence and unique read is included in the shared finite admission meter.
    const exactLimits = {
      ...setup.input.limits,
      maxAcquisitionRecords: Math.max(graph.usage.records, graph.usage.references),
      maxAcquisitionRecordBytes: graph.usage.bytes + graph.usage.referenceBytes,
    };
    expect(
      (
        await capturePolicyRecordGraph(
          request(setup.candidate, setup.policy, exactLimits),
          setup.repositories,
        )
      ).usage,
    ).toEqual(graph.usage);
    for (const patch of [
      { maxAcquisitionRecords: exactLimits.maxAcquisitionRecords - 1 },
      { maxAcquisitionRecordBytes: exactLimits.maxAcquisitionRecordBytes - 1 },
    ]) {
      await expect(
        capturePolicyRecordGraph(
          request(setup.candidate, setup.policy, { ...exactLimits, ...patch }),
          setup.repositories,
        ),
      ).rejects.toThrow();
    }
  });

  it("retains exact declared targets and explicit missing/future/invalid observations without fabricated bodies", async () => {
    const setup = await harness(undefined, { qualificationPolicy: true });
    const record = setup.qualificationPolicy;
    if (!record) throw new Error("Missing independently defined policy");
    for (const [raw, observation] of [
      [null, { status: "missing" }],
      [
        { ...record, publishedAt: "2026-10-02T00:00:00.000Z" },
        { status: "unavailable", reason: "not_yet_available" },
      ],
      [
        { ...record, approved: true },
        { status: "unavailable", reason: "record_invalid" },
      ],
      [
        { ...record, definitionSha256: "0".repeat(64) },
        { status: "unavailable", reason: "record_invalid" },
      ],
    ]) {
      const lookup = vi.fn(async () => raw);
      const graph = await capturePolicyRecordGraph(setup.input, {
        ...setup.repositories,
        qualificationPolicies: { findQualificationPolicy: lookup },
      });
      expect(lookup).toHaveBeenCalledTimes(1);
      const node = graph.nodes.find(({ read }) => read.source.kind === "qualification_policy");
      expect(node).toMatchObject({ read: { observation, record: null }, references: null });
      const edges = graph.edges.filter(
        ({ reference }) => reference.kind === "qualification_policy",
      );
      expect(edges).toHaveLength(2);
      expect(edges.every(({ target }) => target?.kind === "qualification_policy")).toBe(true);
      expect(deriveCapturedRecordClosure(setup.input, graph, limits).entries).toEqual(
        graph.entries,
      );
    }
    const { qualificationPolicies: _absent, ...repositories } = setup.repositories;
    const graph = await capturePolicyRecordGraph(setup.input, repositories);
    expect(
      graph.nodes.find(({ read }) => read.source.kind === "qualification_policy")?.read.observation,
    ).toEqual({ status: "missing" });
  });

  it("rejects conflicting expected digests under one policy identity instead of selecting a latest body", async () => {
    const setup = await harness(undefined, {
      qualificationPolicy: true,
      mutate: (item) => {
        if (item.kind === "qualification_report" && item.record.subject.kind === "oracle")
          item.record.policy.definitionSha256 = "0".repeat(64);
      },
    });
    await expect(capturePolicyRecordGraph(setup.input, setup.repositories)).rejects.toMatchObject({
      reason: "reference_conflict",
    });
  });

  it("requires the same independent policy data during reinspection, including changed receipts and absent creation", async () => {
    const setup = await harness(undefined, { qualificationPolicy: true });
    const record = setup.qualificationPolicy;
    if (!record) throw new Error("Missing independent policy fixture");
    const retained = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const reread = await acquirePolicyRecordGraph(
      setup.input,
      setup.repositories,
      new AcquisitionBudget(setup.input.limits),
      retained,
    );
    expect(reread).toEqual(retained);
    const missingRepositories = {
      ...setup.repositories,
      qualificationPolicies: new StaticQualificationPolicyCatalogue([]),
    };
    for (const repositories of [
      missingRepositories,
      {
        ...setup.repositories,
        qualificationPolicies: new StaticQualificationPolicyCatalogue([
          { ...record, publishedByPrincipalId: "operator_other" },
        ]),
      },
      {
        ...setup.repositories,
        qualificationPolicies: new StaticQualificationPolicyCatalogue([
          { ...record, publishedAt: "2026-10-02T00:00:00.000Z" },
        ]),
      },
    ]) {
      await expect(
        acquirePolicyRecordGraph(
          setup.input,
          repositories,
          new AcquisitionBudget(setup.input.limits),
          retained,
        ),
      ).rejects.toMatchObject({
        code: "policy_captured_observation_recheck_failed",
        reason: "source_revision_changed",
      });
    }
    const missing = await capturePolicyRecordGraph(setup.input, missingRepositories);
    await expect(
      acquirePolicyRecordGraph(
        setup.input,
        setup.repositories,
        new AcquisitionBudget(setup.input.limits),
        missing,
      ),
    ).rejects.toMatchObject({
      code: "policy_captured_observation_recheck_failed",
      reason: "source_revision_changed",
    });
  });

  it("independently rejects omitted/substituted policies, original edges, targets and full observations", async () => {
    const setup = await harness(undefined, { qualificationPolicy: true });
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const nodeIndex = graph.nodes.findIndex(
      ({ read }) => read.source.kind === "qualification_policy",
    );
    const edgeIndex = graph.edges.findIndex(
      ({ reference }) => reference.kind === "qualification_policy",
    );
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(edgeIndex).toBeGreaterThanOrEqual(0);
    for (const mutate of [
      (copy: typeof graph) => (copy.nodes as unknown[]).splice(nodeIndex, 1),
      (copy: typeof graph) => (copy.edges as unknown[]).splice(edgeIndex, 1),
      (copy: typeof graph) => Reflect.set(copy.edges[edgeIndex] as object, "target", null),
      (copy: typeof graph) =>
        Reflect.set(copy.edges[edgeIndex] as object, "target", {
          kind: "qualification_policy",
          reference: {
            ...(copy.edges[edgeIndex]?.target?.reference ?? {}),
            policyVersionId: "other_version",
          },
        }),
      (copy: typeof graph) =>
        Reflect.set(
          copy.nodes[nodeIndex]?.read.observation as object,
          "recordSha256",
          "0".repeat(64),
        ),
      (copy: typeof graph) =>
        Reflect.set(copy.edges[edgeIndex] as object, "selectorFailure", { status: "missing" }),
      (copy: typeof graph) =>
        Reflect.set(copy.edges[edgeIndex] as object, "registrationFailure", { status: "missing" }),
    ]) {
      const copy = structuredClone(graph);
      mutate(copy);
      expect(() => deriveCapturedRecordClosure(setup.input, copy, limits)).toThrow();
    }
    expect(deriveCapturedRecordClosure(setup.input, graph, limits).entries).toEqual(graph.entries);
  });
});

describe("retained registration graph acquisition", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4000000 };
  it("retains unique owning records, every repeated origin and unresolved installed authority", async () => {
    const setup = await harness();
    const records = retainedRegistrations(setup);
    const catalogue = new StaticEvaluationImplementationRegistrationCatalogue(records);
    const calls: unknown[][] = [];
    const graph = await capturePolicyRecordGraph(setup.input, {
      ...setup.repositories,
      implementationRegistrations: {
        findEvaluationImplementationRegistration: async (...args) => {
          calls.push(structuredClone(args));
          return catalogue.findEvaluationImplementationRegistration(...args);
        },
      },
    });
    const edges = graph.edges.filter(
      ({ reference }) => reference.kind === "registered_implementation",
    );
    expect(edges.length).toBeGreaterThan(records.length);
    expect(calls).toHaveLength(edges.length);
    expect(
      edges.every(
        ({ target, registrationFailure }) =>
          target?.kind === "evaluation_implementation_registration" &&
          registrationFailure === undefined,
      ),
    ).toBe(true);
    expect(
      graph.nodes.filter(
        ({ read }) => read.source.kind === "evaluation_implementation_registration",
      ),
    ).toHaveLength(records.length);
    for (const edge of edges) {
      const index = graph.edges.indexOf(edge);
      expect(graph.recordClosure.frontier).toContainEqual({
        edgeIndex: index,
        kind: "retained_declaration",
      });
    }
    expect(graph.unresolved.references).toBe(graph.recordClosure.frontier.length);
    expect(deriveCapturedRecordClosure(setup.input, graph, limits).entries).toEqual(graph.entries);
    expect(graph).not.toHaveProperty("sealed");
    expect(graph).not.toHaveProperty("verdict");
  });

  it("retains missing and future registration failures without fabricating child sources", async () => {
    const setup = await harness();
    const records = retainedRegistrations(setup);
    for (const future of [false, true]) {
      const catalogue = new StaticEvaluationImplementationRegistrationCatalogue(
        future
          ? records.map((record) => ({ ...record, registeredAt: "2026-10-02T00:00:00.000Z" }))
          : [],
      );
      const graph = await capturePolicyRecordGraph(setup.input, {
        ...setup.repositories,
        implementationRegistrations: catalogue,
      });
      const edges = graph.edges.filter(
        ({ reference }) => reference.kind === "registered_implementation",
      );
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.target).toBeNull();
        expect(edge.registrationFailure).toEqual(
          future ? { status: "unavailable", reason: "not_yet_available" } : { status: "missing" },
        );
      }
      expect(
        graph.nodes.some(
          ({ read }) => read.source.kind === "evaluation_implementation_registration",
        ),
      ).toBe(false);
    }
  });

  it("rejects missing/substituted registration nodes and origin edges during independent closure derivation", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, {
      ...setup.repositories,
      implementationRegistrations: new StaticEvaluationImplementationRegistrationCatalogue(
        retainedRegistrations(setup),
      ),
    });
    const nodeIndex = graph.nodes.findIndex(
      ({ read }) => read.source.kind === "evaluation_implementation_registration",
    );
    const edgeIndex = graph.edges.findIndex(
      ({ reference }) => reference.kind === "registered_implementation",
    );
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(edgeIndex).toBeGreaterThanOrEqual(0);
    const missingNode = structuredClone(graph);
    (missingNode.nodes as unknown[]).splice(nodeIndex, 1);
    expect(() => deriveCapturedRecordClosure(setup.input, missingNode, limits)).toThrow();
    const missingEdge = structuredClone(graph);
    (missingEdge.edges as unknown[]).splice(edgeIndex, 1);
    expect(() => deriveCapturedRecordClosure(setup.input, missingEdge, limits)).toThrow();
    const changed = structuredClone(graph);
    const node = changed.nodes[nodeIndex];
    if (!node || node.read.observation.status !== "verified")
      throw new Error("Missing registered body");
    expect(Reflect.set(node.read.observation, "recordSha256", "d".repeat(64))).toBe(true);
    expect(() => deriveCapturedRecordClosure(setup.input, changed, limits)).toThrow();
    const falseMissing = structuredClone(graph);
    const edge = falseMissing.edges[edgeIndex];
    if (!edge) throw new Error("Missing origin");
    expect(Reflect.set(edge, "target", null)).toBe(true);
    expect(Reflect.set(edge, "registrationFailure", { status: "missing" })).toBe(true);
    expect(() => deriveCapturedRecordClosure(setup.input, falseMissing, limits)).toThrow();
  });
});
