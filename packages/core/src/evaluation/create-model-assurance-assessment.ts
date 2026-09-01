import type {
  Assessment,
  EvaluationAggregationPolicy,
  EvaluationRun,
  EvidenceScope,
  HumanReviewerIndependence,
  HumanReviewRecord,
  ModelAssuranceAssessment,
  ModelAssuranceAssessmentDefinition,
  ModelAssuranceIneligibilityReason,
  OracleSpec,
  PrincipalContext,
  RawObservation,
} from "@proofstack/contracts";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PrincipalContextSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import { evaluateBlindedResultIntegrity } from "./model-assurance-blinded-result.js";
import { evaluateCalibrationCompatibility } from "./model-assurance-calibration.js";
import { evaluateIndependentCritiqueIntegrity } from "./model-assurance-critique.js";
import { evaluateHumanReviewQuorum } from "./model-assurance-human-review.js";
import { evaluateModelQualificationApplicability } from "./model-assurance-qualification.js";
import {
  digestModelAssuranceRecordDefinition,
  validateModelAssuranceRecord,
} from "./model-assurance-record-validation.js";
import {
  InvalidModelAssuranceRecordInputError,
  type ModelAssuranceRecordByKind,
  ModelAssuranceRecordConflictError,
  type ModelAssuranceRecordKind,
  type ModelAssuranceRepository,
  ModelAssuranceRepositoryContractError,
} from "./model-assurance-repository.js";
import type { EvaluationRepository } from "./evaluation-repository.js";
import { validateEvaluationRecord } from "./evaluation-record-validation.js";

export type ModelAssuranceAssessmentInput = Omit<
  ModelAssuranceAssessmentDefinition,
  "eligibility" | "evaluatedAt" | "reasons"
>;

export interface CreateModelAssuranceAssessmentCommand {
  readonly definition: ModelAssuranceAssessmentInput;
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly recordId: string;
}

export interface CreateModelAssuranceAssessmentDependencies {
  readonly clock: Clock;
  readonly evaluationRepository: EvaluationRepository;
  readonly modelAssuranceRepository: ModelAssuranceRepository;
}

export interface CreateModelAssuranceAssessmentResult {
  readonly created: boolean;
  readonly record: ModelAssuranceAssessment;
}

export class ModelAssuranceDependencyError extends Error {
  readonly code = "model_assurance_dependency_invalid";

  constructor(readonly dependency: string) {
    super(`Model-assurance dependency ${dependency} is absent, corrupt, or not exact`);
    this.name = "ModelAssuranceDependencyError";
  }
}

function invalidInput(message: string, cause?: unknown): InvalidModelAssuranceRecordInputError {
  return new InvalidModelAssuranceRecordInputError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function authorize(command: CreateModelAssuranceAssessmentCommand): {
  readonly recordId: string;
  readonly scope: EvidenceScope;
} {
  let principal: PrincipalContext;
  try {
    principal = PrincipalContextSchema.parse(command.principal);
  } catch (cause) {
    throw invalidInput("Model-assurance principal is invalid", cause);
  }
  requireCapability(principal, "evaluation:manage");
  requireEnvironmentAccess(principal, command.projectId, command.environmentId);
  const scope = EvidenceScopeSchema.safeParse({
    environmentId: command.environmentId,
    projectId: command.projectId,
    tenantId: principal.tenantId,
  });
  const recordId = OpaqueIdSchema.safeParse(command.recordId);
  if (!scope.success || !recordId.success) {
    throw invalidInput(
      "Model-assurance route is invalid",
      scope.success ? recordId.error : scope.error,
    );
  }
  return { recordId: recordId.data, scope: scope.data };
}

function now(clock: Clock): string {
  let timestamp: string;
  try {
    timestamp = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Model-assurance clock is invalid", cause);
  }
  const parsed = UtcMillisecondTimestampSchema.safeParse(timestamp);
  if (!parsed.success) throw invalidInput("Model-assurance clock is invalid", parsed.error);
  return parsed.data;
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

async function assuranceRecord<K extends ModelAssuranceRecordKind>(
  repository: ModelAssuranceRepository,
  scope: EvidenceScope,
  kind: K,
  recordId: string,
  definitionSha256: string,
): Promise<ModelAssuranceRecordByKind[K]> {
  const input = await repository.find(structuredClone(scope), kind, recordId);
  if (input === null) throw new ModelAssuranceDependencyError(`${kind}:${recordId}`);
  let record: ModelAssuranceRecordByKind[K];
  try {
    record = validateModelAssuranceRecord(kind, input) as ModelAssuranceRecordByKind[K];
  } catch {
    throw new ModelAssuranceDependencyError(`${kind}:${recordId}`);
  }
  if (record.definitionSha256 !== definitionSha256 || !sameScope(record.scope, scope)) {
    throw new ModelAssuranceDependencyError(`${kind}:${recordId}`);
  }
  return record;
}

function exactEvaluationRecord<
  T extends { readonly definitionSha256: string; readonly scope: EvidenceScope },
>(
  input: unknown,
  kind:
    | "aggregation_policy"
    | "assessment"
    | "evaluation_run"
    | "oracle_spec"
    | "qualification_report"
    | "raw_observation",
  scope: EvidenceScope,
  definitionSha256: string,
  dependency: string,
): T {
  let record: T;
  try {
    record = validateEvaluationRecord(kind, input) as unknown as T;
  } catch {
    throw new ModelAssuranceDependencyError(dependency);
  }
  if (record.definitionSha256 !== definitionSha256 || !sameScope(record.scope, scope)) {
    throw new ModelAssuranceDependencyError(dependency);
  }
  return record;
}

async function baseAssessmentGraph(
  repository: EvaluationRepository,
  scope: EvidenceScope,
  definition: ModelAssuranceAssessmentInput,
): Promise<{
  readonly assessment: Assessment;
  readonly observations: readonly RawObservation[];
  readonly oracles: readonly OracleSpec[];
  readonly policy: EvaluationAggregationPolicy;
}> {
  const baseInput = await repository.findAssessment(scope, definition.baseAssessment.assessmentId);
  if (baseInput === null) throw new ModelAssuranceDependencyError("base_assessment");
  const assessment = exactEvaluationRecord<Assessment>(
    baseInput,
    "assessment",
    scope,
    definition.baseAssessment.definitionSha256,
    "base_assessment",
  );
  const policyInput = await repository.findAggregationPolicy(
    scope,
    assessment.aggregationPolicy.policyVersionId,
  );
  if (policyInput === null) throw new ModelAssuranceDependencyError("aggregation_policy");
  const policy = exactEvaluationRecord<EvaluationAggregationPolicy>(
    policyInput,
    "aggregation_policy",
    scope,
    assessment.aggregationPolicy.definitionSha256,
    "aggregation_policy",
  );

  const baseObservations = new Map(
    assessment.observations.map((reference) => [reference.observationId, reference]),
  );
  const observations: RawObservation[] = [];
  const observedOracleKeys = new Set<string>();
  for (const reference of definition.nonModelEvidence.observations) {
    const baseReference = baseObservations.get(reference.observationId);
    if (!baseReference || baseReference.definitionSha256 !== reference.definitionSha256) {
      throw new ModelAssuranceDependencyError(`raw_observation:${reference.observationId}`);
    }
    const observationInput = await repository.findRawObservation(scope, reference.observationId);
    if (observationInput === null) {
      throw new ModelAssuranceDependencyError(`raw_observation:${reference.observationId}`);
    }
    const observation = exactEvaluationRecord<RawObservation>(
      observationInput,
      "raw_observation",
      scope,
      reference.definitionSha256,
      `raw_observation:${reference.observationId}`,
    );
    const runInput = await repository.findEvaluationRun(scope, observation.run.evaluationRunId);
    if (runInput === null) {
      throw new ModelAssuranceDependencyError(`evaluation_run:${observation.run.evaluationRunId}`);
    }
    const run = exactEvaluationRecord<EvaluationRun>(
      runInput,
      "evaluation_run",
      scope,
      observation.run.definitionSha256,
      `evaluation_run:${observation.run.evaluationRunId}`,
    );
    observedOracleKeys.add(
      `${run.oracle.oracleId}:${run.oracle.oracleVersionId}:${run.oracle.definitionSha256}`,
    );
    observations.push(observation);
  }

  const oracles: OracleSpec[] = [];
  for (const reference of definition.nonModelEvidence.oracles) {
    const key = `${reference.oracleId}:${reference.oracleVersionId}:${reference.definitionSha256}`;
    if (!observedOracleKeys.has(key)) {
      throw new ModelAssuranceDependencyError(`oracle_spec:${reference.oracleVersionId}`);
    }
    const input = await repository.findOracleSpec(scope, reference.oracleVersionId);
    if (input === null) {
      throw new ModelAssuranceDependencyError(`oracle_spec:${reference.oracleVersionId}`);
    }
    oracles.push(
      exactEvaluationRecord<OracleSpec>(
        input,
        "oracle_spec",
        scope,
        reference.definitionSha256,
        `oracle_spec:${reference.oracleVersionId}`,
      ),
    );
  }
  return { assessment, observations, oracles, policy };
}

function criterionKey(value: {
  readonly criterionId: string;
  readonly criterionSet: {
    readonly criterionSetId: string;
    readonly criterionSetVersionId: string;
    readonly definitionSha256: string;
  };
}): string {
  return `${value.criterionSet.criterionSetId}:${value.criterionSet.criterionSetVersionId}:${value.criterionId}:${value.criterionSet.definitionSha256}`;
}

function exactReferenceSet(
  values: readonly { readonly definitionSha256: string; readonly [key: string]: unknown }[],
  id: string,
): Set<string> {
  return new Set(values.map((value) => `${String(value[id])}:${value.definitionSha256}`));
}

export function addQualificationReasons(
  reasons: Set<ModelAssuranceIneligibilityReason>,
  values: readonly string[],
): void {
  for (const value of values) {
    if (value === "scope_mismatch") reasons.add("assurance_scope_mismatch");
    else if (value === "calibration_not_current") reasons.add("calibration_stale");
    else if (value === "independence_not_current") reasons.add("independence_unverified");
    else if (value.includes("not_current")) reasons.add("model_qualification_stale");
    else if (value === "report_unqualified") reasons.add("model_qualification_unqualified");
    else if (value === "calibration_unavailable") reasons.add("calibration_unavailable");
    else if (value === "independence_not_verified") reasons.add("independence_unverified");
    else if (value === "blinded_plan_invalid") reasons.add("blind_invalid");
    else reasons.add("model_qualification_invalid");
  }
}

export function addCalibrationReasons(
  reasons: Set<ModelAssuranceIneligibilityReason>,
  values: readonly string[],
): void {
  for (const value of values) {
    if (value === "scope_mismatch") reasons.add("assurance_scope_mismatch");
    else if (value === "calibration_not_current" || value === "profile_not_current") {
      reasons.add("calibration_stale");
    } else if (value === "calibration_unavailable") reasons.add("calibration_unavailable");
    else reasons.add("calibration_incompatible");
  }
}

export function addBlindReasons(
  reasons: Set<ModelAssuranceIneligibilityReason>,
  values: readonly string[],
): void {
  if (values.some((value) => value === "attempt_failed" || value === "attempt_missing")) {
    reasons.add("blind_incomplete");
  }
  if (values.includes("order_verdict_variance")) reasons.add("order_sensitive_result");
  if (values.some((value) => value === "label_leakage" || value === "order_rationale_variance")) {
    reasons.add("unresolved_disagreement");
  }
  if (values.includes("scope_mismatch")) reasons.add("assurance_scope_mismatch");
  if (
    values.some(
      (value) =>
        ![
          "attempt_failed",
          "attempt_missing",
          "label_leakage",
          "order_rationale_variance",
          "order_verdict_variance",
          "scope_mismatch",
        ].includes(value),
    )
  ) {
    reasons.add("blind_invalid");
  }
}

export function addCritiqueReasons(
  reasons: Set<ModelAssuranceIneligibilityReason>,
  values: readonly string[],
): void {
  for (const value of values) {
    if (value === "scope_mismatch") reasons.add("assurance_scope_mismatch");
    else if (value === "critique_correlated") reasons.add("independence_correlated");
    else if (
      value === "critique_unverifiable" ||
      value === "declaration_mismatch" ||
      value === "primary_declaration_missing"
    ) {
      reasons.add("independence_unverified");
    } else if (value === "opposing_finding" || value === "uncertain_finding") {
      reasons.add("unresolved_disagreement");
    } else reasons.add("critique_invalid");
  }
}

export function addHumanReasons(
  reasons: Set<ModelAssuranceIneligibilityReason>,
  values: readonly string[],
): void {
  for (const value of values) {
    if (value === "scope_mismatch") reasons.add("assurance_scope_mismatch");
    else if (value === "review_expired" || value === "independence_not_current") {
      reasons.add("human_review_expired");
    } else if (value === "protocol_mismatch" || value === "protocol_not_current") {
      reasons.add("human_review_protocol_mismatch");
    } else if (
      value === "quorum_shortfall" ||
      value === "role_requirement_shortfall" ||
      value === "independence_group_shortfall"
    ) {
      reasons.add("human_review_quorum_shortfall");
    } else if (
      value === "conflicted_reviewer" ||
      value === "opposing_review" ||
      value === "unresolved_escalation"
    ) {
      reasons.add("human_review_conflicted");
    } else reasons.add("human_review_invalid");
  }
}

export function minimumEligibleValidity(requested: string, values: readonly string[]): string {
  return [requested, ...values].reduce((minimum, value) =>
    Date.parse(value) < Date.parse(minimum) ? value : minimum,
  );
}

export class CreateModelAssuranceAssessment {
  constructor(private readonly dependencies: CreateModelAssuranceAssessmentDependencies) {}

  async execute(
    command: CreateModelAssuranceAssessmentCommand,
  ): Promise<CreateModelAssuranceAssessmentResult> {
    const { recordId, scope } = authorize(command);
    const evaluatedAt = now(this.dependencies.clock);
    const definition = structuredClone(command.definition);
    if (definition.assessmentExtensionId !== recordId) {
      throw invalidInput("Model-assurance route identifier and immutable definition do not match");
    }

    const base = await baseAssessmentGraph(
      this.dependencies.evaluationRepository,
      scope,
      definition,
    );
    const repository = this.dependencies.modelAssuranceRepository;
    const plan = await assuranceRecord(
      repository,
      scope,
      "blinded_evaluation_plan",
      definition.blindedPlan.blindedPlanVersionId,
      definition.blindedPlan.definitionSha256,
    );
    const blindResult = await assuranceRecord(
      repository,
      scope,
      "blinded_evaluation_result",
      definition.blindedResult.resultId,
      definition.blindedResult.definitionSha256,
    );
    const calibration = await assuranceRecord(
      repository,
      scope,
      "calibration_report",
      definition.calibrationReport.calibrationReportId,
      definition.calibrationReport.definitionSha256,
    );
    const qualification = await assuranceRecord(
      repository,
      scope,
      "model_qualification_report",
      definition.modelQualificationReport.reportId,
      definition.modelQualificationReport.definitionSha256,
    );
    const suite = await assuranceRecord(
      repository,
      scope,
      "model_qualification_suite",
      qualification.suite.suiteVersionId,
      qualification.suite.definitionSha256,
    );
    const profile = await assuranceRecord(
      repository,
      scope,
      "model_evaluator_profile",
      qualification.modelProfile.modelProfileVersionId,
      qualification.modelProfile.definitionSha256,
    );
    const primaryIndependence = await assuranceRecord(
      repository,
      scope,
      "independence_declaration",
      qualification.independenceDeclaration.independenceDeclarationId,
      qualification.independenceDeclaration.definitionSha256,
    );
    const protocol = await assuranceRecord(
      repository,
      scope,
      "human_review_protocol",
      definition.humanReviewProtocol.protocolVersionId,
      definition.humanReviewProtocol.definitionSha256,
    );
    const critiques = await Promise.all(
      definition.critiques.map((reference) =>
        assuranceRecord(
          repository,
          scope,
          "independent_critique",
          reference.critiqueId,
          reference.definitionSha256,
        ),
      ),
    );
    const declarations = await Promise.all(
      definition.independenceDeclarations.map((reference) =>
        assuranceRecord(
          repository,
          scope,
          "independence_declaration",
          reference.independenceDeclarationId,
          reference.definitionSha256,
        ),
      ),
    );
    const reviews = await Promise.all(
      definition.humanReviews.map((reference) =>
        assuranceRecord(
          repository,
          scope,
          "human_review_record",
          reference.reviewId,
          reference.definitionSha256,
        ),
      ),
    );
    const humanDeclarations: HumanReviewerIndependence[] = await Promise.all(
      reviews.map((review) =>
        assuranceRecord(
          repository,
          scope,
          "human_reviewer_independence",
          review.independenceDeclaration.declarationId,
          review.independenceDeclaration.definitionSha256,
        ),
      ),
    );

    const baseQualificationInput =
      await this.dependencies.evaluationRepository.findQualificationReport(
        scope,
        qualification.baseQualificationReport.qualificationReportId,
      );
    if (baseQualificationInput === null) {
      throw new ModelAssuranceDependencyError("base_qualification_report");
    }
    exactEvaluationRecord(
      baseQualificationInput,
      "qualification_report",
      scope,
      qualification.baseQualificationReport.definitionSha256,
      "base_qualification_report",
    );

    const reasons = new Set<ModelAssuranceIneligibilityReason>();
    if (base.assessment.eligibility.status !== "eligible") {
      reasons.add("base_assessment_ineligible");
    }
    if (base.assessment.dimensions.sourceFreshness !== "current") reasons.add("source_stale");
    if (base.assessment.riskTier !== definition.riskTier) {
      reasons.add("assurance_lineage_mismatch");
    }
    if (definition.nonModelEvidence.observations.length === 0 || base.oracles.length === 0) {
      reasons.add("non_model_evidence_missing");
    }

    const qualificationResult = evaluateModelQualificationApplicability(
      suite,
      qualification,
      profile,
      primaryIndependence,
      calibration,
      plan,
      evaluatedAt,
    );
    if (qualificationResult.status === "inapplicable") {
      addQualificationReasons(reasons, qualificationResult.reasons);
    }
    const calibrationResult = evaluateCalibrationCompatibility(profile, calibration, {
      at: evaluatedAt,
      criteria: [base.assessment.criterion],
      dataset: base.policy.dataset,
      evaluator: calibration.evaluator,
      locale: definition.calibrationContext.locale,
      populationTags: definition.calibrationContext.populationTags,
      qualificationReport: calibration.qualificationReport,
      riskTier: definition.riskTier,
      scope,
      taskKindId: definition.calibrationContext.taskKindId,
    });
    if (calibrationResult.status === "incompatible") {
      addCalibrationReasons(reasons, calibrationResult.reasons);
    }
    const blindResultIntegrity = evaluateBlindedResultIntegrity(plan, blindResult);
    if (blindResultIntegrity.status !== "consistent") {
      addBlindReasons(reasons, blindResultIntegrity.reasons);
    }
    if (definition.critiques.length === 0) reasons.add("unresolved_disagreement");
    const critiqueIntegrity = evaluateIndependentCritiqueIntegrity(
      plan,
      definition.critiques,
      critiques,
      declarations,
      evaluatedAt,
    );
    if (critiqueIntegrity.status === "unsatisfied") {
      addCritiqueReasons(reasons, critiqueIntegrity.reasons);
    }
    if (reviews.length === 0) reasons.add("human_review_missing");
    const humanQuorum = evaluateHumanReviewQuorum(
      protocol,
      reviews,
      humanDeclarations,
      evaluatedAt,
    );
    if (humanQuorum.status === "unsatisfied") addHumanReasons(reasons, humanQuorum.reasons);

    if (
      protocol.claim.riskTier !== definition.riskTier ||
      !protocol.claim.criteria.some(
        (criterion) => criterionKey(criterion) === criterionKey(base.assessment.criterion),
      )
    ) {
      reasons.add("human_review_protocol_mismatch");
    }
    const selectedObservationKeys = exactReferenceSet(
      definition.nonModelEvidence.observations,
      "observationId",
    );
    const critiqueKeys = exactReferenceSet(definition.critiques, "critiqueId");
    for (const critique of critiques) {
      if (
        !selectedObservationKeys.has(
          `${critique.observation.observationId}:${critique.observation.definitionSha256}`,
        )
      ) {
        reasons.add("critique_invalid");
      }
    }
    for (const review of reviews) {
      if (
        review.assessment.assessmentId !== base.assessment.assessmentId ||
        review.assessment.definitionSha256 !== base.assessment.definitionSha256
      ) {
        reasons.add("human_review_invalid");
      }
      const reviewedObservations = exactReferenceSet(review.observations, "observationId");
      const reviewedCritiques = exactReferenceSet(review.critiques, "critiqueId");
      if (
        [...selectedObservationKeys].some((key) => !reviewedObservations.has(key)) ||
        [...critiqueKeys].some((key) => !reviewedCritiques.has(key))
      ) {
        reasons.add("human_review_invalid");
      }
    }

    const eligibility = reasons.size === 0 ? "eligible" : "ineligible";
    const validUntil =
      eligibility === "eligible"
        ? minimumEligibleValidity(definition.validUntil, [
            calibration.validUntil,
            plan.validUntil,
            primaryIndependence.validUntil,
            profile.validUntil,
            protocol.validUntil,
            qualification.validUntil,
            suite.validUntil,
            ...humanDeclarations.map((value) => value.validUntil),
            ...reviews.map((value: HumanReviewRecord) => value.expiresAt),
          ])
        : definition.validUntil;
    const derivedDefinition: ModelAssuranceAssessmentDefinition = {
      ...definition,
      eligibility,
      evaluatedAt,
      reasons: [...reasons].sort(),
      validUntil,
    };
    const candidate = validateModelAssuranceRecord("model_assurance_assessment", {
      ...derivedDefinition,
      definitionSha256: digestModelAssuranceRecordDefinition(
        "model_assurance_assessment",
        scope,
        derivedDefinition,
      ),
      recordedAt: evaluatedAt,
      schemaVersion: "0.1",
      scope,
    }) as ModelAssuranceAssessment;

    const existingInput = await repository.find(scope, "model_assurance_assessment", recordId);
    if (existingInput !== null) {
      const existing = validateModelAssuranceRecord(
        "model_assurance_assessment",
        existingInput,
      ) as ModelAssuranceAssessment;
      if (
        !sameScope(existing.scope, scope) ||
        existing.assessmentExtensionId !== recordId ||
        existing.definitionSha256 !== candidate.definitionSha256
      ) {
        throw new ModelAssuranceRecordConflictError("model_assurance_assessment", recordId);
      }
      const retry = await repository.publish("model_assurance_assessment", existing);
      if (retry.created || JSON.stringify(retry.record) !== JSON.stringify(existing)) {
        throw new ModelAssuranceRepositoryContractError(
          "Model-assurance assessment retry violated repository semantics",
        );
      }
      return { created: false, record: structuredClone(existing) };
    }
    const result = await repository.publish("model_assurance_assessment", candidate);
    const record = validateModelAssuranceRecord(
      "model_assurance_assessment",
      result.record,
    ) as ModelAssuranceAssessment;
    if (
      !sameScope(record.scope, scope) ||
      record.assessmentExtensionId !== recordId ||
      record.definitionSha256 !== candidate.definitionSha256
    ) {
      throw new ModelAssuranceRepositoryContractError(
        "Model-assurance assessment publication substituted semantics",
      );
    }
    return { created: result.created, record: structuredClone(record) };
  }
}
