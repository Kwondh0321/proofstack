import type {
  Assessment,
  ComparisonDefinitionReference,
  ComparisonEvidenceSnapshot,
  ComparisonRecordKind,
  ComparisonResult,
  EvidenceScope,
  PrincipalContext,
} from "@proofstack/contracts";
import {
  type DurableReplayExampleSummary,
  type RunDurableReplayExampleOptions,
  runDurableReplayExample,
} from "@proofstack/example-durable-replay/workflow";
import {
  type EvaluationControlFlowSummary,
  runEvaluationControlFlow,
} from "@proofstack/example-evaluation-control-flow/workflow";
import {
  type ModelAssuranceControlFlowSummary,
  runModelAssuranceControlFlow,
} from "@proofstack/example-model-assurance-control-flow/workflow";
import type { ProofStackComparisonClient } from "@proofstack/sdk";
import { createWorkflow1ComparisonDefinition } from "./comparison-definition.js";

type EvaluationOptions = Parameters<typeof runEvaluationControlFlow>[0];
type ModelAssuranceOptions = Parameters<typeof runModelAssuranceControlFlow>[0];
type ComparisonClient = Pick<
  ProofStackComparisonClient,
  "createEvidenceSnapshot" | "deriveResult" | "publishDefinition" | "readRecord"
>;
type EvaluationClient = EvaluationOptions["client"] & ModelAssuranceOptions["evaluationClient"];
type ModelClient = ModelAssuranceOptions["modelClient"];

export interface PrepareWorkflow1AcceptanceOptions {
  readonly comparisonClient: ComparisonClient;
  readonly controlPrincipal: PrincipalContext;
  readonly durableReplay: RunDurableReplayExampleOptions;
  readonly evaluationClient: EvaluationClient;
  readonly evaluationWorker: EvaluationOptions["worker"];
  readonly modelClient: ModelClient;
  readonly modelWorker: ModelAssuranceOptions["modelWorker"];
  readonly namespace: string;
  readonly selectApiPrincipal: (principal: PrincipalContext) => void;
}

export interface PreparedWorkflow1Acceptance {
  readonly comparison: ComparisonDefinitionReference;
  readonly comparisonRecordId: string;
  readonly durableReplay: DurableReplayExampleSummary;
  readonly evaluation: EvaluationControlFlowSummary;
  readonly modelAssurance: ModelAssuranceControlFlowSummary;
  readonly namespace: string;
  readonly resultId: string;
  readonly scope: EvidenceScope;
  readonly snapshotIds: {
    readonly baseline: string;
    readonly candidate: string;
  };
}

export interface Workflow1AcceptanceSummary extends PreparedWorkflow1Acceptance {
  readonly result: ComparisonResult;
  readonly snapshots: {
    readonly baseline: ComparisonEvidenceSnapshot;
    readonly candidate: ComparisonEvidenceSnapshot;
  };
  readonly verifiedComparisonRecords: readonly {
    readonly definitionSha256: string;
    readonly kind: ComparisonRecordKind;
    readonly recordId: string;
  }[];
}

function expectedScope(namespace: string): EvidenceScope {
  return {
    environmentId: `env_${namespace}_primary`,
    projectId: `prj_${namespace}_primary`,
    tenantId: `ten_${namespace}`,
  };
}

function assertSameScope(actual: EvidenceScope, expected: EvidenceScope, label: string): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.projectId !== expected.projectId ||
    actual.environmentId !== expected.environmentId
  ) {
    throw new TypeError(`${label} must use the exact Workflow 1 acceptance scope`);
  }
}

/**
 * Retains the complete upstream graph and comparison definition.
 * Callers intentionally restart the API before creating resolver-backed evidence snapshots.
 */
export async function prepareWorkflow1Acceptance(
  options: PrepareWorkflow1AcceptanceOptions,
): Promise<PreparedWorkflow1Acceptance> {
  const scope = expectedScope(options.namespace);
  assertSameScope(
    {
      environmentId: options.durableReplay.environmentId,
      projectId: options.durableReplay.projectId,
      tenantId: options.durableReplay.tenantId,
    },
    scope,
    "Durable replay",
  );
  options.selectApiPrincipal(options.controlPrincipal);
  const durableReplay = await runDurableReplayExample(options.durableReplay);
  assertSameScope(durableReplay.scope, scope, "Retained replay evidence");

  const evidenceSubject = (
    replay: DurableReplayExampleSummary["jobs"]["success"]["evidenceReference"],
  ) => ({
    dataset: structuredClone(durableReplay.dataset),
    fixture: structuredClone(durableReplay.fixture),
    replay: structuredClone(replay),
  });
  const evidenceSubjects = {
    abstain: evidenceSubject(durableReplay.jobs.success.evidenceReference),
    error: evidenceSubject(durableReplay.jobs.staleFenceRecovery.evidenceReference),
    fail: evidenceSubject(durableReplay.jobs.success.evidenceReference),
    not_applicable: evidenceSubject(durableReplay.jobs.staleFenceRecovery.evidenceReference),
    pass: evidenceSubject(durableReplay.jobs.success.evidenceReference),
  } as const;
  const evaluation = await runEvaluationControlFlow({
    client: options.evaluationClient,
    environmentId: scope.environmentId,
    evidenceSubjects,
    namespace: options.namespace,
    projectId: scope.projectId,
    tenantId: scope.tenantId,
    worker: options.evaluationWorker,
  });
  const baseAssessmentEnvelope = (
    await options.evaluationClient.readRecord({
      kind: "assessment",
      recordId: evaluation.assessment.assessmentId,
    })
  ).result;
  if (baseAssessmentEnvelope.kind !== "assessment") {
    throw new TypeError("Evaluation assessment read-back changed record kind");
  }
  const baseAssessment: Assessment = baseAssessmentEnvelope.record;
  if (baseAssessment.definitionSha256 !== evaluation.assessment.definitionSha256) {
    throw new TypeError("Evaluation assessment read-back changed semantic digest");
  }

  const modelAssurance = await runModelAssuranceControlFlow({
    baseAssessment,
    evaluationClient: options.evaluationClient,
    evaluationWorker: options.evaluationWorker,
    modelClient: options.modelClient,
    modelWorker: options.modelWorker,
    namespace: options.namespace,
    selectApiPrincipal: options.selectApiPrincipal,
  });
  options.selectApiPrincipal(options.controlPrincipal);

  const definition = createWorkflow1ComparisonDefinition(options.namespace, {
    assessment: {
      assessmentId: modelAssurance.assessment.baseAssessmentId,
      definitionSha256: modelAssurance.assessment.baseAssessmentSha256,
    },
    baselineReplay: durableReplay.jobs.success.evidenceReference,
    candidateReplay: durableReplay.jobs.staleFenceRecovery.evidenceReference,
    dataset: durableReplay.dataset,
    fixture: durableReplay.fixture,
    modelAssuranceAssessment: {
      assessmentExtensionId: modelAssurance.assessment.assessmentExtensionId,
      definitionSha256: modelAssurance.assessment.definitionSha256,
    },
  });
  const published = await options.comparisonClient.publishDefinition({
    comparisonId: definition.comparisonId,
    request: definition.request,
  });
  if (published.result.kind !== "comparison_definition") {
    throw new TypeError("Comparison publication changed record kind");
  }
  const comparison = {
    comparisonId: published.result.record.comparisonId,
    comparisonVersionId: published.result.record.comparisonVersionId,
    definitionSha256: published.result.record.definitionSha256,
  };

  return {
    comparison,
    comparisonRecordId: published.result.record.comparisonVersionId,
    durableReplay,
    evaluation,
    modelAssurance,
    namespace: options.namespace,
    resultId: definition.resultId,
    scope,
    snapshotIds: definition.snapshotIds,
  };
}

async function exactComparisonReadBack(
  client: ComparisonClient,
  expected: readonly {
    readonly definitionSha256: string;
    readonly kind: ComparisonRecordKind;
    readonly recordId: string;
  }[],
): Promise<Workflow1AcceptanceSummary["verifiedComparisonRecords"]> {
  for (const reference of expected) {
    const response = await client.readRecord(reference);
    if (
      response.result.kind !== reference.kind ||
      response.result.record.definitionSha256 !== reference.definitionSha256
    ) {
      throw new TypeError(`Comparison read-back changed ${reference.kind}:${reference.recordId}`);
    }
  }
  return expected;
}

/** Creates repository-resolved snapshots and one derived result after the caller restarts the API. */
export async function completeWorkflow1Acceptance(
  client: ComparisonClient,
  prepared: PreparedWorkflow1Acceptance,
): Promise<Workflow1AcceptanceSummary> {
  const baselineEnvelope = await client.createEvidenceSnapshot({
    request: {
      comparison: prepared.comparison,
      role: "baseline",
      snapshotId: prepared.snapshotIds.baseline,
    },
    snapshotId: prepared.snapshotIds.baseline,
  });
  const candidateEnvelope = await client.createEvidenceSnapshot({
    request: {
      comparison: prepared.comparison,
      role: "candidate",
      snapshotId: prepared.snapshotIds.candidate,
    },
    snapshotId: prepared.snapshotIds.candidate,
  });
  if (
    baselineEnvelope.result.kind !== "comparison_evidence_snapshot" ||
    candidateEnvelope.result.kind !== "comparison_evidence_snapshot"
  ) {
    throw new TypeError("Comparison snapshot creation changed record kind");
  }
  const baseline = baselineEnvelope.result.record;
  const candidate = candidateEnvelope.result.record;
  const resultEnvelope = await client.deriveResult({
    request: {
      baselineSnapshot: {
        definitionSha256: baseline.definitionSha256,
        role: "baseline",
        snapshotId: baseline.snapshotId,
      },
      candidateSnapshot: {
        definitionSha256: candidate.definitionSha256,
        role: "candidate",
        snapshotId: candidate.snapshotId,
      },
      comparison: prepared.comparison,
      resultId: prepared.resultId,
    },
    resultId: prepared.resultId,
  });
  if (resultEnvelope.result.kind !== "comparison_result") {
    throw new TypeError("Comparison result derivation changed record kind");
  }
  const result = resultEnvelope.result.record;
  const verifiedComparisonRecords = await exactComparisonReadBack(client, [
    {
      definitionSha256: prepared.comparison.definitionSha256,
      kind: "comparison_definition",
      recordId: prepared.comparisonRecordId,
    },
    {
      definitionSha256: baseline.definitionSha256,
      kind: "comparison_evidence_snapshot",
      recordId: baseline.snapshotId,
    },
    {
      definitionSha256: candidate.definitionSha256,
      kind: "comparison_evidence_snapshot",
      recordId: candidate.snapshotId,
    },
    {
      definitionSha256: result.definitionSha256,
      kind: "comparison_result",
      recordId: result.resultId,
    },
  ]);

  return {
    ...prepared,
    result,
    snapshots: { baseline, candidate },
    verifiedComparisonRecords,
  };
}
