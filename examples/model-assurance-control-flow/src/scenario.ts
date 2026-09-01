import type {
  Assessment,
  AssessmentDefinition,
  BlindedEvaluationResult,
  BlindedEvaluationResultDefinition,
  CalibrationReport,
  CalibrationReportDefinition,
  HumanReviewRecord,
  HumanReviewRecordDefinition,
  IndependenceDeclaration,
  IndependenceDeclarationDefinition,
  IndependentCritique,
  IndependentCritiqueDefinition,
  ModelQualificationReport,
  ModelQualificationReportDefinition,
} from "@proofstack/contracts";

export function criticalBaseAssessmentDefinition(
  source: Assessment,
  namespace: string,
): AssessmentDefinition {
  const {
    createdAt: _createdAt,
    createdByPrincipalId: _createdByPrincipalId,
    definitionSha256: _definitionSha256,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(source);
  definition.assessmentId = `asm_${namespace}_critical`;
  const artifactEvidence = {
    artifact: {
      artifactId: `art_${namespace}_critical_counterevidence`,
      classification: "restricted" as const,
      mediaType: "application/json",
      sha256: "1".repeat(64),
      sizeBytes: 1024,
    },
    kind: "artifact" as const,
  };
  const oracleEvidence = {
    artifact: {
      artifactId: `art_${namespace}_deterministic_counterevidence`,
      classification: "restricted" as const,
      mediaType: "application/json",
      sha256: "2".repeat(64),
      sizeBytes: 1024,
    },
    kind: "artifact" as const,
  };
  const sourceEvidence = {
    artifact: {
      artifactId: `art_${namespace}_source_counterevidence`,
      classification: "restricted" as const,
      mediaType: "application/json",
      sha256: "4".repeat(64),
      sizeBytes: 1024,
    },
    kind: "artifact" as const,
  };
  definition.conflicts = [
    {
      conflictId: `cnf_${namespace}_critical`,
      evidence: [artifactEvidence, oracleEvidence, sourceEvidence],
      severity: "critical",
      status: "unresolved",
      summary: "Applicable deterministic evidence conflicts with the model-favored interpretation.",
    },
  ];
  definition.counterevidence = [artifactEvidence, sourceEvidence];
  definition.eligibility = { reasons: ["critical_counterevidence"], status: "ineligible" };
  return definition;
}

export function unavailableCalibrationDefinition(
  source: CalibrationReport,
  namespace: string,
): CalibrationReportDefinition {
  const {
    definitionSha256: _definitionSha256,
    recordedAt: _recordedAt,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(source);
  definition.calibrationReportId = `cal_${namespace}_incompatible`;
  definition.status = "unavailable";
  definition.statusReasons = ["The requested population is outside the calibrated slice"];
  return definition;
}

export function correlatedIndependenceDefinition(
  primary: IndependenceDeclaration,
  critic: IndependenceDeclaration,
  namespace: string,
): IndependenceDeclarationDefinition {
  const {
    definitionSha256: _definitionSha256,
    recordedAt: _recordedAt,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(critic);
  definition.independenceDeclarationId = `ind_${namespace}_correlated_alias`;
  const sharedProvider = primary.dimensions.providers;
  if (sharedProvider.status !== "declared") {
    throw new TypeError("The primary independence declaration omitted provider lineage");
  }
  definition.dimensions.providers = structuredClone(sharedProvider);
  return definition;
}

export function correlatedCriticQualificationDefinition(
  source: ModelQualificationReport,
  declaration: IndependenceDeclaration,
  namespace: string,
): ModelQualificationReportDefinition {
  const definition = recordDefinition(source) as ModelQualificationReportDefinition;
  definition.reportId = `mqr_${namespace}_correlated_critic`;
  definition.independenceDeclaration = {
    definitionSha256: declaration.definitionSha256,
    independenceDeclarationId: declaration.independenceDeclarationId,
  };
  return definition;
}

export function correlatedCritiqueDefinition(
  source: IndependentCritique,
  declaration: IndependenceDeclaration,
  report: ModelQualificationReport,
  namespace: string,
): IndependentCritiqueDefinition {
  const definition = recordDefinition(source) as IndependentCritiqueDefinition;
  definition.critiqueId = `crt_${namespace}_correlated`;
  definition.independenceDeclaration = {
    definitionSha256: declaration.definitionSha256,
    independenceDeclarationId: declaration.independenceDeclarationId,
  };
  definition.modelQualificationReport = {
    definitionSha256: report.definitionSha256,
    reportId: report.reportId,
  };
  return definition;
}

function recordDefinition(source: object): Record<string, unknown> {
  const definition = structuredClone(source) as Record<string, unknown>;
  for (const key of [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "recordedAt",
    "recordedByPrincipalId",
    "schemaVersion",
    "scope",
  ]) {
    Reflect.deleteProperty(definition, key);
  }
  return definition;
}

export function reversedBlindResultDefinition(
  source: BlindedEvaluationResult,
  namespace: string,
): BlindedEvaluationResultDefinition {
  const {
    definitionSha256: _definitionSha256,
    recordedAt: _recordedAt,
    recordedByPrincipalId: _recordedByPrincipalId,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(source);
  definition.resultId = `blr_${namespace}_order_reversal`;
  const second = definition.attempts[1];
  if (second?.status !== "completed") {
    throw new TypeError("The blinded fixture omitted its second completed order");
  }
  second.verdict = second.verdict === "pass" ? "fail" : "pass";
  definition.disagreementEvidence = [
    {
      artifactId: `art_${namespace}_order_reversal`,
      classification: "restricted",
      mediaType: "application/json",
      sha256: "3".repeat(64),
      sizeBytes: 1024,
    },
  ];
  definition.disagreementReasons = ["order_verdict_variance"];
  definition.status = "disagreement";
  return definition;
}

export function unqualifiedModelReportDefinition(
  source: ModelQualificationReport,
  namespace: string,
): ModelQualificationReportDefinition {
  const {
    definitionSha256: _definitionSha256,
    recordedAt: _recordedAt,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(source);
  definition.reportId = `mqr_${namespace}_injection_failure`;
  definition.status = "unqualified";
  definition.criticalScenarioFailures = ["direct_prompt_injection", "forged_citation"];
  definition.failureReasons = [
    "A forged citation survived validation",
    "A prompt injection changed the bounded judgment",
  ];
  definition.statusSummary.matchedCaseCount -= 2;
  definition.statusSummary.mismatchedCaseCount += 2;
  return definition;
}

export function humanReviewVariantDefinition(
  source: HumanReviewRecord,
  namespace: string,
  action: "oppose" | "recuse",
): HumanReviewRecordDefinition {
  const {
    definitionSha256: _definitionSha256,
    recordedAt: _recordedAt,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(source);
  definition.action = action;
  definition.reviewId = `hrr_${namespace}_${action}`;
  definition.reviewer.requestId = `req_${namespace}_${action}`;
  definition.reviewer.sessionId = `ses_${namespace}_${action}`;
  definition.structuredReasons = [
    action === "recuse" ? "material_conflict_disclosed" : "critical_counterevidence_unresolved",
  ];
  definition.conflicts = action === "recuse" ? ["shared_operating_organization"] : [];
  return definition;
}
