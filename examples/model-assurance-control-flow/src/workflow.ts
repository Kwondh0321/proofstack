import { createHash } from "node:crypto";
import type {
  EvaluationRecordKind,
  HumanReviewRecord,
  ModelAssuranceAssessment,
  ModelAssuranceRecordEnvelope,
  ModelAssuranceRecordKind,
  ModelEvaluatorProfile,
  ModelQualificationReport,
  PrincipalContext,
} from "@proofstack/contracts";
import {
  compareEvaluatorIndependence,
  type EvaluationDefinitionByKind,
  evaluationRecordId,
  type ModelAssuranceDefinitionByKind,
  modelAssuranceRecordId,
  type RecordEvaluationCommand,
  type RecordModelAssuranceCommand,
} from "@proofstack/core";
import {
  createModelAssuranceRepositoryTestHarness,
  type EvaluationRepositoryFixtureRecord,
  type ModelAssuranceRepositoryFixtureRecord,
} from "@proofstack/core/testing";
import type { EvaluationWorkerOperations } from "@proofstack/evaluation-worker";
import {
  computeLocalModelRequestSha256,
  type LocalModelHarnessRequest,
  type LocalModelHarnessResult,
  type ModelEvaluationWorkerOperations,
  runBoundedLocalModelProvider,
} from "@proofstack/model-evaluation-worker";
import type { ProofStackEvaluationClient, ProofStackModelAssuranceClient } from "@proofstack/sdk";
import {
  correlatedCriticQualificationDefinition,
  correlatedCritiqueDefinition,
  correlatedIndependenceDefinition,
  criticalBaseAssessmentDefinition,
  humanReviewVariantDefinition,
  reversedBlindResultDefinition,
  unavailableCalibrationDefinition,
  unqualifiedModelReportDefinition,
} from "./scenario.js";

type EvaluationClient = Pick<
  ProofStackEvaluationClient,
  | "createAssessment"
  | "publishDefinition"
  | "readRecord"
  | "recordCriterionSetStatus"
  | "recordRunDecision"
>;

type ModelClient = Pick<
  ProofStackModelAssuranceClient,
  "createAssessment" | "publishDefinition" | "readRecord" | "recordHumanReview"
>;

type EvaluationWorkerKind =
  | "evaluation_aggregate"
  | "evaluation_run_result"
  | "qualification_report"
  | "raw_observation";

type ModelWorkerKind =
  | "blinded_evaluation_result"
  | "independent_critique"
  | "model_qualification_report";

export interface ModelAssuranceControlFlowOptions {
  readonly evaluationClient: EvaluationClient;
  readonly evaluationWorker: EvaluationWorkerOperations;
  readonly modelClient: ModelClient;
  readonly modelWorker: ModelEvaluationWorkerOperations;
  readonly namespace: string;
  readonly selectApiPrincipal: (principal: PrincipalContext) => void;
}

export interface ModelAssuranceControlFlowSummary {
  readonly assessment: {
    readonly assessmentExtensionId: string;
    readonly definitionSha256: string;
    readonly eligibility: ModelAssuranceAssessment["eligibility"];
    readonly reasons: ModelAssuranceAssessment["reasons"];
  };
  readonly localProvider: {
    readonly requestSha256: string;
    readonly responseSha256: string;
    readonly status: LocalModelHarnessResult["status"];
    readonly recordedToolRequestCount: number;
  };
  readonly readBack: {
    readonly evaluationRecordCount: number;
    readonly modelRecordCount: number;
  };
  readonly safeguards: {
    readonly calibrationStatus: "unavailable";
    readonly criticIndependence: "correlated";
    readonly humanActions: readonly ["oppose", "recuse", "support", "support"];
    readonly qualificationStatus: "unqualified";
    readonly reversalStatus: "disagreement";
  };
}

const evaluationWorkerKinds = new Set<EvaluationRecordKind>([
  "evaluation_aggregate",
  "evaluation_run_result",
  "qualification_report",
  "raw_observation",
]);
const modelWorkerKinds = new Set<ModelAssuranceRecordKind>([
  "blinded_evaluation_result",
  "independent_critique",
  "model_qualification_report",
]);

function userPrincipal(tenantId: string, principalId: string, requestId: string): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-02T05:59:00.000Z", method: "development" },
    capabilities: [
      "evaluation:human:review",
      "evaluation:manage",
      "evaluation:model:run",
      "evaluation:read",
      "evaluation:run",
    ],
    principalId,
    principalType: "user",
    requestId,
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId,
  };
}

function servicePrincipal(
  tenantId: string,
  projectId: string,
  environmentId: string,
  principalId: string,
  requestId: string,
): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-09-02T05:59:00.000Z",
      credentialId: `cred_${principalId}`,
      method: "service_token",
    },
    capabilities: ["evaluation:model:run", "evaluation:run"],
    principalId,
    principalType: "service",
    requestId,
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: [environmentId], projectId }],
    },
    roles: ["member"],
    tenantId,
  };
}

function humanPrincipal(review: HumanReviewRecord, tenantId: string): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: review.reviewer.authenticatedAt,
      ...(review.reviewer.credentialId === undefined
        ? {}
        : { credentialId: review.reviewer.credentialId }),
      method: review.reviewer.authenticationMethod,
    },
    capabilities: ["evaluation:human:review", "evaluation:read"],
    principalId: review.reviewer.principalId,
    principalType: review.reviewer.principalType,
    requestId: review.reviewer.requestId,
    resourceScope: { mode: "tenant" },
    roles: ["member"],
    tenantId,
  };
}

function withoutKeys(source: object, keys: readonly string[]): Record<string, unknown> {
  const definition = structuredClone(source) as Record<string, unknown>;
  for (const key of keys) Reflect.deleteProperty(definition, key);
  return definition;
}

function evaluationDefinition(fixture: EvaluationRepositoryFixtureRecord): object {
  const common = ["definitionSha256", "schemaVersion", "scope"];
  const receipts: Record<EvaluationRecordKind, readonly string[]> = {
    aggregation_policy: ["publishedAt", "publishedByPrincipalId"],
    assessment: ["createdAt", "createdByPrincipalId"],
    criterion_set: ["publishedAt", "publishedByPrincipalId"],
    criterion_set_status: ["recordedAt", "recordedByPrincipalId"],
    discovery_record: ["recordedAt", "recordedByPrincipalId"],
    evaluation_aggregate: ["createdAt", "createdByPrincipalId"],
    evaluation_run: ["createdAt", "createdByPrincipalId"],
    evaluation_run_rejection: ["recordedAt", "requestedByPrincipalId"],
    evaluation_run_result: ["recordedAt", "recordedByPrincipalId"],
    evaluator_spec: ["publishedAt", "publishedByPrincipalId"],
    oracle_spec: ["publishedAt", "publishedByPrincipalId"],
    qualification_fixture_set: ["publishedAt", "publishedByPrincipalId"],
    qualification_report: ["executedByPrincipalId", "recordedAt"],
    raw_observation: ["recordedAt"],
    source_review: ["reviewedAt", "reviewedByPrincipalId", "reviewerRole"],
    source_snapshot: ["publishedByPrincipalId", "recordedAt"],
  };
  return withoutKeys(fixture.record, [...common, ...receipts[fixture.kind]]);
}

function modelDefinition(fixture: ModelAssuranceRepositoryFixtureRecord): object {
  const common = ["definitionSha256", "schemaVersion", "scope"];
  const receipts: Record<ModelAssuranceRecordKind, readonly string[]> = {
    blinded_evaluation_plan: ["publishedAt", "publishedByPrincipalId"],
    blinded_evaluation_result: ["recordedAt", "recordedByPrincipalId"],
    calibration_report: ["recordedAt"],
    human_review_protocol: ["publishedAt", "publishedByPrincipalId"],
    human_review_record: ["recordedAt"],
    human_reviewer_independence: ["recordedAt"],
    independence_declaration: ["recordedAt"],
    independent_critique: ["recordedAt", "recordedByPrincipalId"],
    model_assisted_evaluator: ["publishedAt", "publishedByPrincipalId"],
    model_assurance_assessment: ["recordedAt"],
    model_evaluator_profile: ["publishedAt", "publishedByPrincipalId"],
    model_qualification_report: ["recordedAt"],
    model_qualification_suite: ["publishedAt", "publishedByPrincipalId"],
  };
  return withoutKeys(fixture.record, [...common, ...receipts[fixture.kind]]);
}

function evaluationWorkerCommand(
  fixture: EvaluationRepositoryFixtureRecord & { readonly kind: EvaluationWorkerKind },
  principal: PrincipalContext,
): RecordEvaluationCommand<EvaluationWorkerKind> {
  return {
    definition: evaluationDefinition(fixture) as EvaluationDefinitionByKind[EvaluationWorkerKind],
    environmentId: fixture.record.scope.environmentId,
    kind: fixture.kind,
    principal,
    projectId: fixture.record.scope.projectId,
    recordId: evaluationRecordId(fixture.kind, fixture.record),
  };
}

function modelWorkerCommand<Kind extends ModelWorkerKind>(
  kind: Kind,
  definition: ModelAssuranceDefinitionByKind[Kind],
  recordId: string,
  scope: { readonly environmentId: string; readonly projectId: string; readonly tenantId: string },
  principalId: string,
  namespace: string,
): RecordModelAssuranceCommand<Kind> {
  return {
    definition,
    environmentId: scope.environmentId,
    kind,
    principal: servicePrincipal(
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
      principalId,
      `req_${namespace}_${recordId}`,
    ),
    projectId: scope.projectId,
    recordId,
  };
}

async function publishEvaluationFixture(
  options: ModelAssuranceControlFlowOptions,
  fixture: EvaluationRepositoryFixtureRecord,
): Promise<void> {
  const scope = fixture.record.scope;
  const principal = userPrincipal(
    scope.tenantId,
    "usr_repository_conformance",
    `req_${options.namespace}_evaluation_${fixture.kind}`,
  );
  const recordId = evaluationRecordId(fixture.kind, fixture.record);
  if (evaluationWorkerKinds.has(fixture.kind)) {
    const recordedExecutor = (
      fixture.record as unknown as { readonly executedByPrincipalId?: unknown }
    ).executedByPrincipalId;
    const workerPrincipalId =
      typeof recordedExecutor === "string" ? recordedExecutor : "usr_repository_conformance";
    const command = evaluationWorkerCommand(
      fixture as EvaluationRepositoryFixtureRecord & { readonly kind: EvaluationWorkerKind },
      servicePrincipal(
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
        workerPrincipalId,
        `req_${options.namespace}_evaluation_worker_${recordId}`,
      ),
    );
    switch (command.kind) {
      case "evaluation_aggregate":
        await options.evaluationWorker.createEvaluationAggregate(command as never);
        return;
      case "evaluation_run_result":
        await options.evaluationWorker.recordEvaluationRunResult(command as never);
        return;
      case "qualification_report":
        await options.evaluationWorker.recordQualificationReport(command as never);
        return;
      case "raw_observation":
        await options.evaluationWorker.recordRawObservation(command as never);
        return;
    }
  }
  options.selectApiPrincipal(principal);
  const request = { definition: evaluationDefinition(fixture), kind: fixture.kind };
  if (fixture.kind === "criterion_set_status") {
    await options.evaluationClient.recordCriterionSetStatus({
      recordId,
      request: request as never,
    });
  } else if (fixture.kind === "evaluation_run" || fixture.kind === "evaluation_run_rejection") {
    await options.evaluationClient.recordRunDecision({ recordId, request: request as never });
  } else if (fixture.kind === "assessment") {
    await options.evaluationClient.createAssessment({ recordId, request: request as never });
  } else {
    await options.evaluationClient.publishDefinition({ recordId, request: request as never });
  }
}

async function publishModelFixture(
  options: ModelAssuranceControlFlowOptions,
  fixture: ModelAssuranceRepositoryFixtureRecord,
): Promise<ModelAssuranceRecordEnvelope["record"]> {
  const scope = fixture.record.scope;
  const recordId = modelAssuranceRecordId(fixture.kind, fixture.record);
  const definition = modelDefinition(fixture);
  if (modelWorkerKinds.has(fixture.kind)) {
    const principalId =
      fixture.kind === "model_qualification_report"
        ? (fixture.record as ModelQualificationReport).executedByPrincipalId
        : (fixture.record as { readonly recordedByPrincipalId: string }).recordedByPrincipalId;
    const command = modelWorkerCommand(
      fixture.kind as ModelWorkerKind,
      definition as never,
      recordId,
      scope,
      principalId,
      options.namespace,
    );
    switch (command.kind) {
      case "blinded_evaluation_result":
        return (await options.modelWorker.recordBlindedEvaluationResult(command as never)).record;
      case "independent_critique":
        return (await options.modelWorker.recordIndependentCritique(command as never)).record;
      case "model_qualification_report":
        return (await options.modelWorker.recordModelQualificationReport(command as never)).record;
    }
  }
  options.selectApiPrincipal(
    userPrincipal(
      scope.tenantId,
      "usr_assurance_publisher",
      `req_${options.namespace}_${recordId}`,
    ),
  );
  return (
    await options.modelClient.publishDefinition({
      recordId,
      request: { definition, kind: fixture.kind } as never,
    })
  ).result.record;
}

function recordByKind<Kind extends ModelAssuranceRecordKind>(
  records: readonly ModelAssuranceRepositoryFixtureRecord[],
  kind: Kind,
  index = 0,
): Extract<ModelAssuranceRepositoryFixtureRecord, { readonly kind: Kind }>["record"] {
  const fixture = records.filter((value) => value.kind === kind)[index];
  if (!fixture || fixture.kind !== kind) throw new Error(`Expected ${kind} fixture at ${index}`);
  return fixture.record as never;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runLocalProvider(profile: ModelEvaluatorProfile, namespace: string) {
  const bytes = Buffer.from("untrusted model input requesting a privileged write", "utf8");
  const request: LocalModelHarnessRequest = {
    attemptId: `bat_${namespace}_local`,
    executedAt: "2026-09-02T01:00:00.000Z",
    inputs: [
      {
        bytes,
        reference: {
          artifactId: `art_${namespace}_untrusted_input`,
          classification: "restricted",
          mediaType: "text/plain",
          sha256: sha256(bytes),
          sizeBytes: bytes.byteLength,
        },
      },
    ],
    modelProfile: profile,
    operation: "blinded_evaluation",
    requestOrdinal: 1,
  };
  const result = runBoundedLocalModelProvider(request, {
    expectedRequestSha256: computeLocalModelRequestSha256(request),
    modelProfileDefinitionSha256: profile.definitionSha256,
    operation: request.operation,
    responseBytes: Buffer.from(
      JSON.stringify({ toolRequests: [{ name: "privileged_write" }], verdict: "abstain" }),
      "utf8",
    ),
    status: "completed",
    usage: { costMicrousd: 0, inputTokens: 9, outputTokens: 6 },
  });
  if (result.status !== "completed")
    throw new Error("Expected the local provider fixture to complete");
  return result;
}

/** Runs a deliberately adversarial model-assisted assessment across the API and isolated workers. */
export async function runModelAssuranceControlFlow(
  options: ModelAssuranceControlFlowOptions,
): Promise<ModelAssuranceControlFlowSummary> {
  const harness = await createModelAssuranceRepositoryTestHarness(options.namespace);
  const scope = harness.evaluation.scope;
  for (const fixture of harness.evaluation.records) {
    await publishEvaluationFixture(options, fixture);
  }

  const baseAssessment = harness.evaluation.records.find(
    (fixture): fixture is Extract<EvaluationRepositoryFixtureRecord, { kind: "assessment" }> =>
      fixture.kind === "assessment",
  );
  if (!baseAssessment) throw new Error("Expected an evaluation assessment fixture");
  options.selectApiPrincipal(
    userPrincipal(scope.tenantId, "usr_assurance_manager", `req_${options.namespace}_critical`),
  );
  const critical = (
    await options.evaluationClient.createAssessment({
      recordId: `asm_${options.namespace}_critical`,
      request: {
        definition: criticalBaseAssessmentDefinition(baseAssessment.record, options.namespace),
        kind: "assessment",
      },
    })
  ).result;
  if (critical.kind !== "assessment") throw new Error("Expected the critical base assessment");

  const published = new Map<string, ModelAssuranceRecordEnvelope["record"]>();
  for (const fixture of harness.records) {
    if (fixture.kind === "human_review_record") continue;
    const record = await publishModelFixture(options, fixture);
    published.set(
      `${fixture.kind}:${modelAssuranceRecordId(fixture.kind, fixture.record)}`,
      record,
    );
  }

  const primaryCalibration = recordByKind(harness.records, "calibration_report", 0);
  options.selectApiPrincipal(
    userPrincipal(
      scope.tenantId,
      "usr_assurance_publisher",
      `req_${options.namespace}_calibration`,
    ),
  );
  const unavailable = (
    await options.modelClient.publishDefinition({
      recordId: `cal_${options.namespace}_incompatible`,
      request: {
        definition: unavailableCalibrationDefinition(primaryCalibration, options.namespace),
        kind: "calibration_report",
      },
    })
  ).result;
  if (unavailable.kind !== "calibration_report")
    throw new Error("Expected unavailable calibration");

  const primaryIndependence = recordByKind(harness.records, "independence_declaration", 0);
  const criticIndependence = recordByKind(harness.records, "independence_declaration", 1);
  const correlatedDefinition = correlatedIndependenceDefinition(
    primaryIndependence,
    criticIndependence,
    options.namespace,
  );
  options.selectApiPrincipal(
    userPrincipal(scope.tenantId, "usr_assurance_publisher", `req_${options.namespace}_correlated`),
  );
  const correlated = (
    await options.modelClient.publishDefinition({
      recordId: correlatedDefinition.independenceDeclarationId,
      request: { definition: correlatedDefinition, kind: "independence_declaration" },
    })
  ).result;
  if (correlated.kind !== "independence_declaration") {
    throw new Error("Expected correlated independence declaration");
  }

  const reversedDefinition = reversedBlindResultDefinition(
    recordByKind(harness.records, "blinded_evaluation_result"),
    options.namespace,
  );
  const reversed = (
    await options.modelWorker.recordBlindedEvaluationResult(
      modelWorkerCommand(
        "blinded_evaluation_result",
        reversedDefinition,
        reversedDefinition.resultId,
        scope,
        "wrk_model_runner",
        options.namespace,
      ),
    )
  ).record;

  const primaryQualificationDefinition = unqualifiedModelReportDefinition(
    recordByKind(harness.records, "model_qualification_report", 0),
    options.namespace,
  );
  const unqualified = (
    await options.modelWorker.recordModelQualificationReport(
      modelWorkerCommand(
        "model_qualification_report",
        primaryQualificationDefinition,
        primaryQualificationDefinition.reportId,
        scope,
        primaryQualificationDefinition.executedByPrincipalId,
        options.namespace,
      ),
    )
  ).record;

  const criticReportDefinition = correlatedCriticQualificationDefinition(
    recordByKind(harness.records, "model_qualification_report", 1),
    correlated.record,
    options.namespace,
  );
  const criticReport = (
    await options.modelWorker.recordModelQualificationReport(
      modelWorkerCommand(
        "model_qualification_report",
        criticReportDefinition,
        criticReportDefinition.reportId,
        scope,
        criticReportDefinition.executedByPrincipalId,
        options.namespace,
      ),
    )
  ).record;

  const critiqueDefinition = correlatedCritiqueDefinition(
    recordByKind(harness.records, "independent_critique"),
    correlated.record,
    criticReport,
    options.namespace,
  );
  const correlatedCritique = (
    await options.modelWorker.recordIndependentCritique(
      modelWorkerCommand(
        "independent_critique",
        critiqueDefinition,
        critiqueDefinition.critiqueId,
        scope,
        "wrk_independent_critic",
        options.namespace,
      ),
    )
  ).record;

  const reviewSources = harness.records.filter(
    (
      fixture,
    ): fixture is Extract<ModelAssuranceRepositoryFixtureRecord, { kind: "human_review_record" }> =>
      fixture.kind === "human_review_record",
  );
  const reviews: HumanReviewRecord[] = [];
  for (const fixture of reviewSources) {
    const definition = modelDefinition(fixture) as unknown as HumanReviewRecord;
    definition.assessment = {
      assessmentId: critical.record.assessmentId,
      definitionSha256: critical.record.definitionSha256,
    };
    definition.critiques = [
      {
        critiqueId: correlatedCritique.critiqueId,
        definitionSha256: correlatedCritique.definitionSha256,
      },
    ];
    const principal = humanPrincipal(definition, scope.tenantId);
    options.selectApiPrincipal(principal);
    const result = await options.modelClient.recordHumanReview({
      recordId: definition.reviewId,
      request: { definition, kind: "human_review_record" } as never,
    });
    if (result.result.kind !== "human_review_record") throw new Error("Expected human review");
    reviews.push(result.result.record);
  }
  const firstReview = reviews[0];
  const secondReview = reviews[1];
  if (!firstReview || !secondReview) throw new Error("Expected two supporting reviews");
  for (const [source, action] of [
    [firstReview, "oppose"],
    [secondReview, "recuse"],
  ] as const) {
    const definition = humanReviewVariantDefinition(source, options.namespace, action);
    options.selectApiPrincipal(humanPrincipal(definition as HumanReviewRecord, scope.tenantId));
    const result = await options.modelClient.recordHumanReview({
      recordId: definition.reviewId,
      request: { definition, kind: "human_review_record" },
    });
    if (result.result.kind !== "human_review_record") throw new Error("Expected review variant");
    reviews.push(result.result.record);
  }

  const finalDefinition = structuredClone(harness.command.definition);
  finalDefinition.assessmentExtensionId = `maa_${options.namespace}_adversarial`;
  finalDefinition.baseAssessment = {
    assessmentId: critical.record.assessmentId,
    definitionSha256: critical.record.definitionSha256,
  };
  finalDefinition.blindedResult = {
    definitionSha256: reversed.definitionSha256,
    resultId: reversed.resultId,
  };
  finalDefinition.calibrationReport = {
    calibrationReportId: unavailable.record.calibrationReportId,
    definitionSha256: unavailable.record.definitionSha256,
  };
  finalDefinition.critiques = [
    {
      critiqueId: correlatedCritique.critiqueId,
      definitionSha256: correlatedCritique.definitionSha256,
    },
  ];
  finalDefinition.humanReviews = reviews
    .map(({ definitionSha256, reviewId }) => ({ definitionSha256, reviewId }))
    .sort((left, right) => left.reviewId.localeCompare(right.reviewId));
  finalDefinition.independenceDeclarations = [
    {
      definitionSha256: primaryIndependence.definitionSha256,
      independenceDeclarationId: primaryIndependence.independenceDeclarationId,
    },
    {
      definitionSha256: correlated.record.definitionSha256,
      independenceDeclarationId: correlated.record.independenceDeclarationId,
    },
  ].sort((left, right) =>
    left.independenceDeclarationId.localeCompare(right.independenceDeclarationId),
  );
  finalDefinition.modelQualificationReport = {
    definitionSha256: unqualified.definitionSha256,
    reportId: unqualified.reportId,
  };
  finalDefinition.nonModelEvidence.observations = critical.record.observations.map((value) =>
    structuredClone(value),
  );

  options.selectApiPrincipal(
    userPrincipal(scope.tenantId, "usr_assurance_manager", `req_${options.namespace}_final`),
  );
  const assessment = await options.modelClient.createAssessment({
    recordId: finalDefinition.assessmentExtensionId,
    request: { definition: finalDefinition, kind: "model_assurance_assessment" },
  });
  if (assessment.result.kind !== "model_assurance_assessment") {
    throw new Error("Expected model-assurance assessment");
  }

  for (const fixture of harness.evaluation.records) {
    await options.evaluationClient.readRecord({
      kind: fixture.kind,
      recordId: evaluationRecordId(fixture.kind, fixture.record),
    });
  }
  const modelReferences = [
    ...published.entries(),
    ["calibration_report:unavailable", unavailable.record],
    ["independence_declaration:correlated", correlated.record],
    ["blinded_evaluation_result:reversed", reversed],
    ["model_qualification_report:unqualified", unqualified],
    ["model_qualification_report:correlated", criticReport],
    ["independent_critique:correlated", correlatedCritique],
    ...reviews.map((record) => [`human_review_record:${record.reviewId}`, record] as const),
    ["model_assurance_assessment:final", assessment.result.record],
  ] as const;
  for (const [, record] of modelReferences) {
    const kind = Object.entries({
      blinded_evaluation_plan: "blindedPlanVersionId",
      blinded_evaluation_result: "resultId",
      calibration_report: "calibrationReportId",
      human_review_protocol: "protocolVersionId",
      human_review_record: "reviewId",
      human_reviewer_independence: "declarationId",
      independence_declaration: "independenceDeclarationId",
      independent_critique: "critiqueId",
      model_assisted_evaluator: "evaluatorVersionId",
      model_assurance_assessment: "assessmentExtensionId",
      model_evaluator_profile: "modelProfileVersionId",
      model_qualification_report: "reportId",
      model_qualification_suite: "suiteVersionId",
    } satisfies Record<ModelAssuranceRecordKind, string>).find(
      ([, field]) => field in record,
    )?.[0] as ModelAssuranceRecordKind | undefined;
    if (!kind) throw new Error("Could not identify model-assurance record kind");
    await options.modelClient.readRecord({
      kind,
      recordId: modelAssuranceRecordId(kind, record as never),
    });
  }

  const comparison = compareEvaluatorIndependence(
    primaryIndependence,
    correlated.record,
    assessment.result.record.evaluatedAt,
  );
  if (comparison.status !== "correlated") throw new Error("Expected correlated critic lineage");
  const localProvider = runLocalProvider(
    recordByKind(harness.records, "model_evaluator_profile", 0),
    options.namespace,
  );
  if (unavailable.record.status !== "unavailable") {
    throw new Error("Expected unavailable calibration status");
  }
  if (unqualified.status !== "unqualified") {
    throw new Error("Expected unqualified model status");
  }
  if (reversed.status !== "disagreement") {
    throw new Error("Expected order disagreement status");
  }

  return {
    assessment: {
      assessmentExtensionId: assessment.result.record.assessmentExtensionId,
      definitionSha256: assessment.result.record.definitionSha256,
      eligibility: assessment.result.record.eligibility,
      reasons: assessment.result.record.reasons,
    },
    localProvider: {
      recordedToolRequestCount: localProvider.recordedToolRequests.length,
      requestSha256: localProvider.requestSha256,
      responseSha256: localProvider.responseSha256,
      status: localProvider.status,
    },
    readBack: {
      evaluationRecordCount: harness.evaluation.records.length,
      modelRecordCount: modelReferences.length,
    },
    safeguards: {
      calibrationStatus: unavailable.record.status,
      criticIndependence: comparison.status,
      humanActions: ["oppose", "recuse", "support", "support"],
      qualificationStatus: unqualified.status,
      reversalStatus: reversed.status,
    },
  };
}
