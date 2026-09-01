import type {
  Assessment,
  AssessmentDefinition,
  CriterionSet,
  CriterionSetDefinition,
  CriterionSetStatusDefinition,
  CriterionSetStatusRecord,
  DiscoveryRecord,
  DiscoveryRecordDefinition,
  EvaluationAggregate,
  EvaluationAggregateDefinition,
  EvaluationAggregationPolicy,
  EvaluationAggregationPolicyDefinition,
  EvaluationDefinitionPublicationKind,
  EvaluationRun,
  EvaluationRunDefinition,
  EvaluationRunRejection,
  EvaluationRunRejectionDefinition,
  EvaluationRunResult,
  EvaluationRunResultDefinition,
  EvaluatorSpec,
  EvaluatorSpecDefinition,
  EvidenceScope,
  OracleSpec,
  OracleSpecDefinition,
  PrincipalContext,
  QualificationFixtureSet,
  QualificationFixtureSetDefinition,
  QualificationReport,
  QualificationReportDefinition,
  RawObservation,
  RawObservationDefinition,
  SourceReviewDefinition,
  SourceReviewRecord,
  SourceSnapshot,
  SourceSnapshotDefinition,
} from "@proofstack/contracts";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PrincipalContextSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import {
  EvaluationRecordConflictError,
  EvaluationRecordNotFoundError,
  EvaluationRepositoryContractError,
  InvalidEvaluationRecordInputError,
  type EvaluationRecordKind,
} from "./evaluation-repository-errors.js";
import type {
  EvaluationRecord,
  EvaluationRepository,
  PublishEvaluationRecordResult,
} from "./evaluation-repository.js";
import {
  digestEvaluationRecordDefinition,
  evaluationRecordId,
  validateEvaluationRecord,
} from "./evaluation-record-validation.js";

export interface EvaluationDefinitionByKind {
  readonly aggregation_policy: EvaluationAggregationPolicyDefinition;
  readonly assessment: AssessmentDefinition;
  readonly criterion_set: CriterionSetDefinition;
  readonly criterion_set_status: CriterionSetStatusDefinition;
  readonly discovery_record: DiscoveryRecordDefinition;
  readonly evaluation_aggregate: EvaluationAggregateDefinition;
  readonly evaluation_run: EvaluationRunDefinition;
  readonly evaluation_run_rejection: EvaluationRunRejectionDefinition;
  readonly evaluation_run_result: EvaluationRunResultDefinition;
  readonly evaluator_spec: EvaluatorSpecDefinition;
  readonly oracle_spec: OracleSpecDefinition;
  readonly qualification_fixture_set: QualificationFixtureSetDefinition;
  readonly qualification_report: QualificationReportDefinition;
  readonly raw_observation: RawObservationDefinition;
  readonly source_review: SourceReviewDefinition;
  readonly source_snapshot: SourceSnapshotDefinition;
}

export interface EvaluationRecordByKind {
  readonly aggregation_policy: EvaluationAggregationPolicy;
  readonly assessment: Assessment;
  readonly criterion_set: CriterionSet;
  readonly criterion_set_status: CriterionSetStatusRecord;
  readonly discovery_record: DiscoveryRecord;
  readonly evaluation_aggregate: EvaluationAggregate;
  readonly evaluation_run: EvaluationRun;
  readonly evaluation_run_rejection: EvaluationRunRejection;
  readonly evaluation_run_result: EvaluationRunResult;
  readonly evaluator_spec: EvaluatorSpec;
  readonly oracle_spec: OracleSpec;
  readonly qualification_fixture_set: QualificationFixtureSet;
  readonly qualification_report: QualificationReport;
  readonly raw_observation: RawObservation;
  readonly source_review: SourceReviewRecord;
  readonly source_snapshot: SourceSnapshot;
}

interface EvaluationRoute {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly recordId: string;
}

export interface RecordEvaluationCommand<Kind extends EvaluationRecordKind>
  extends EvaluationRoute {
  readonly definition: EvaluationDefinitionByKind[Kind];
  readonly kind: Kind;
}

export interface ReadEvaluationRecordCommand extends EvaluationRoute {
  readonly kind: EvaluationRecordKind;
}

export interface RecordEvaluationDependencies {
  readonly clock: Clock;
  readonly repository: EvaluationRepository;
}

export interface RecordEvaluationResult<Kind extends EvaluationRecordKind> {
  readonly created: boolean;
  readonly record: EvaluationRecordByKind[Kind];
}

function invalidInput(message: string, cause?: unknown): InvalidEvaluationRecordInputError {
  return new InvalidEvaluationRecordInputError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function authorizedRoute(
  command: EvaluationRoute,
  capability: "evaluation:manage" | "evaluation:read" | "evaluation:run",
): {
  readonly principal: PrincipalContext;
  readonly scope: EvidenceScope;
  readonly recordId: string;
} {
  let principal: PrincipalContext;
  try {
    principal = PrincipalContextSchema.parse(command.principal);
  } catch (cause) {
    throw invalidInput("Evaluation principal is invalid", cause);
  }
  requireCapability(principal, capability);
  requireEnvironmentAccess(principal, command.projectId, command.environmentId);

  const scope = EvidenceScopeSchema.safeParse({
    environmentId: command.environmentId,
    projectId: command.projectId,
    tenantId: principal.tenantId,
  });
  const recordId = OpaqueIdSchema.safeParse(command.recordId);
  if (!scope.success || !recordId.success) {
    throw invalidInput("Evaluation route is invalid", scope.success ? recordId.error : scope.error);
  }
  return { principal, recordId: recordId.data, scope: scope.data };
}

function serverTimestamp(clock: Clock): string {
  let value: string;
  try {
    value = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Evaluation clock is invalid", cause);
  }
  const parsed = UtcMillisecondTimestampSchema.safeParse(value);
  if (!parsed.success) throw invalidInput("Evaluation clock is invalid", parsed.error);
  return parsed.data;
}

function receipt(
  kind: EvaluationRecordKind,
  principal: PrincipalContext,
  timestamp: string,
): Record<string, unknown> {
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      return { publishedAt: timestamp, publishedByPrincipalId: principal.principalId };
    case "assessment":
    case "evaluation_aggregate":
    case "evaluation_run":
      return { createdAt: timestamp, createdByPrincipalId: principal.principalId };
    case "criterion_set_status":
    case "discovery_record":
    case "evaluation_run_result":
      return { recordedAt: timestamp, recordedByPrincipalId: principal.principalId };
    case "evaluation_run_rejection":
      return { recordedAt: timestamp, requestedByPrincipalId: principal.principalId };
    case "qualification_report":
      return { executedByPrincipalId: principal.principalId, recordedAt: timestamp };
    case "raw_observation":
      return { recordedAt: timestamp };
    case "source_review":
      return {
        reviewedAt: timestamp,
        reviewedByPrincipalId: principal.principalId,
        reviewerRole: `Authenticated roles: ${[...principal.roles].sort().join(", ")}`,
      };
    case "source_snapshot":
      return { publishedByPrincipalId: principal.principalId, recordedAt: timestamp };
  }
}

function createCandidate<Kind extends EvaluationRecordKind>(
  kind: Kind,
  definitionInput: unknown,
  principal: PrincipalContext,
  scope: EvidenceScope,
  timestamp: string,
): EvaluationRecordByKind[Kind] {
  let definition: EvaluationDefinitionByKind[Kind];
  try {
    definition = structuredClone(definitionInput) as EvaluationDefinitionByKind[Kind];
    if (
      kind === "raw_observation" &&
      (definition as RawObservationDefinition).executedByPrincipalId !== principal.principalId
    ) {
      throw invalidInput("Raw observation executor must match the authenticated principal");
    }
    const candidate = {
      ...definition,
      ...receipt(kind, principal, timestamp),
      definitionSha256: digestEvaluationRecordDefinition(kind, scope, definition),
      schemaVersion: "0.1",
      scope,
    };
    return validateEvaluationRecord(kind, candidate) as EvaluationRecordByKind[Kind];
  } catch (cause) {
    if (cause instanceof InvalidEvaluationRecordInputError) throw cause;
    throw invalidInput(`Invalid ${kind} definition`, cause);
  }
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

async function findRecord(
  repository: EvaluationRepository,
  kind: EvaluationRecordKind,
  scope: EvidenceScope,
  recordId: string,
): Promise<EvaluationRecord | null> {
  switch (kind) {
    case "aggregation_policy":
      return repository.findAggregationPolicy(scope, recordId);
    case "assessment":
      return repository.findAssessment(scope, recordId);
    case "criterion_set":
      return repository.findCriterionSet(scope, recordId);
    case "criterion_set_status":
      return repository.findCriterionSetStatus(scope, recordId);
    case "discovery_record":
      return repository.findDiscoveryRecord(scope, recordId);
    case "evaluation_aggregate":
      return repository.findEvaluationAggregate(scope, recordId);
    case "evaluation_run":
      return repository.findEvaluationRun(scope, recordId);
    case "evaluation_run_rejection":
      return repository.findEvaluationRunRejection(scope, recordId);
    case "evaluation_run_result":
      return repository.findEvaluationRunResult(scope, recordId);
    case "evaluator_spec":
      return repository.findEvaluatorSpec(scope, recordId);
    case "oracle_spec":
      return repository.findOracleSpec(scope, recordId);
    case "qualification_fixture_set":
      return repository.findQualificationFixtureSet(scope, recordId);
    case "qualification_report":
      return repository.findQualificationReport(scope, recordId);
    case "raw_observation":
      return repository.findRawObservation(scope, recordId);
    case "source_review":
      return repository.findSourceReview(scope, recordId);
    case "source_snapshot":
      return repository.findSourceSnapshot(scope, recordId);
  }
}

async function publishRecord(
  repository: EvaluationRepository,
  kind: EvaluationRecordKind,
  record: EvaluationRecord,
): Promise<PublishEvaluationRecordResult<EvaluationRecord>> {
  switch (kind) {
    case "aggregation_policy":
      return repository.publishAggregationPolicy(record as EvaluationAggregationPolicy);
    case "assessment":
      return repository.publishAssessment(record as Assessment);
    case "criterion_set":
      return repository.publishCriterionSet(record as CriterionSet);
    case "criterion_set_status":
      return repository.publishCriterionSetStatus(record as CriterionSetStatusRecord);
    case "discovery_record":
      return repository.publishDiscoveryRecord(record as DiscoveryRecord);
    case "evaluation_aggregate":
      return repository.publishEvaluationAggregate(record as EvaluationAggregate);
    case "evaluation_run":
      return repository.publishEvaluationRun(record as EvaluationRun);
    case "evaluation_run_rejection":
      return repository.publishEvaluationRunRejection(record as EvaluationRunRejection);
    case "evaluation_run_result":
      return repository.publishEvaluationRunResult(record as EvaluationRunResult);
    case "evaluator_spec":
      return repository.publishEvaluatorSpec(record as EvaluatorSpec);
    case "oracle_spec":
      return repository.publishOracleSpec(record as OracleSpec);
    case "qualification_fixture_set":
      return repository.publishQualificationFixtureSet(record as QualificationFixtureSet);
    case "qualification_report":
      return repository.publishQualificationReport(record as QualificationReport);
    case "raw_observation":
      return repository.publishRawObservation(record as RawObservation);
    case "source_review":
      return repository.publishSourceReview(record as SourceReviewRecord);
    case "source_snapshot":
      return repository.publishSourceSnapshot(record as SourceSnapshot);
  }
}

function validateRepositoryRecord(
  input: unknown,
  kind: EvaluationRecordKind,
  scope: EvidenceScope,
  recordId: string,
): EvaluationRecord {
  let record: EvaluationRecord;
  try {
    record = validateEvaluationRecord(kind, input);
  } catch (cause) {
    throw new EvaluationRepositoryContractError(
      "Evaluation repository returned an invalid record",
      {
        cause,
      },
    );
  }
  if (evaluationRecordId(kind, record) !== recordId || !scopesEqual(record.scope, scope)) {
    throw new EvaluationRepositoryContractError(
      "Evaluation repository substituted a record outside the exact query",
    );
  }
  return record;
}

function validatePublicationResult(
  input: unknown,
  kind: EvaluationRecordKind,
  scope: EvidenceScope,
  recordId: string,
): PublishEvaluationRecordResult<EvaluationRecord> {
  if (typeof input !== "object" || input === null) {
    throw new EvaluationRepositoryContractError("Evaluation repository returned an invalid result");
  }
  let keys: readonly PropertyKey[];
  let created: unknown;
  let record: unknown;
  try {
    keys = Reflect.ownKeys(input);
    created = Reflect.get(input, "created");
    record = Reflect.get(input, "record");
  } catch (cause) {
    throw new EvaluationRepositoryContractError("Evaluation repository result is unreadable", {
      cause,
    });
  }
  if (
    keys.length !== 2 ||
    !keys.includes("created") ||
    !keys.includes("record") ||
    typeof created !== "boolean"
  ) {
    throw new EvaluationRepositoryContractError("Evaluation repository returned an invalid result");
  }
  return {
    created,
    record: validateRepositoryRecord(record, kind, scope, recordId),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function recordEvaluation<Kind extends EvaluationRecordKind>(
  dependencies: RecordEvaluationDependencies,
  command: RecordEvaluationCommand<Kind>,
  capability: "evaluation:manage" | "evaluation:run",
): Promise<RecordEvaluationResult<Kind>> {
  const { principal, recordId, scope } = authorizedRoute(command, capability);
  const candidate = createCandidate(
    command.kind,
    command.definition,
    principal,
    scope,
    serverTimestamp(dependencies.clock),
  );
  if (evaluationRecordId(command.kind, candidate) !== recordId) {
    throw invalidInput("Evaluation route identifier and immutable definition do not match");
  }

  const existingInput = await findRecord(
    dependencies.repository,
    command.kind,
    structuredClone(scope),
    recordId,
  );
  if (existingInput !== null) {
    const existing = validateRepositoryRecord(existingInput, command.kind, scope, recordId);
    if (existing.definitionSha256 !== candidate.definitionSha256) {
      throw new EvaluationRecordConflictError(command.kind, recordId);
    }
    const retry = validatePublicationResult(
      await publishRecord(dependencies.repository, command.kind, structuredClone(existing)),
      command.kind,
      scope,
      recordId,
    );
    if (retry.created || !sameJson(retry.record, existing)) {
      throw new EvaluationRepositoryContractError("Evaluation retry violated repository semantics");
    }
    return {
      created: false,
      record: structuredClone(retry.record) as EvaluationRecordByKind[Kind],
    };
  }

  const result = validatePublicationResult(
    await publishRecord(dependencies.repository, command.kind, structuredClone(candidate)),
    command.kind,
    scope,
    recordId,
  );
  if (result.record.definitionSha256 !== candidate.definitionSha256) {
    throw new EvaluationRepositoryContractError("Evaluation publication substituted semantics");
  }
  return {
    created: result.created,
    record: structuredClone(result.record) as EvaluationRecordByKind[Kind],
  };
}

export class ReadEvaluationRecord {
  constructor(private readonly repository: EvaluationRepository) {}

  async execute(command: ReadEvaluationRecordCommand): Promise<EvaluationRecord> {
    const { recordId, scope } = authorizedRoute(command, "evaluation:read");
    const record = await findRecord(
      this.repository,
      command.kind,
      structuredClone(scope),
      recordId,
    );
    if (record === null) {
      throw new EvaluationRecordNotFoundError(command.kind, recordId);
    }
    return structuredClone(validateRepositoryRecord(record, command.kind, scope, recordId));
  }
}

export class PublishEvaluationDefinition {
  constructor(private readonly dependencies: RecordEvaluationDependencies) {}

  execute<Kind extends EvaluationDefinitionPublicationKind>(
    command: RecordEvaluationCommand<Kind>,
  ): Promise<RecordEvaluationResult<Kind>> {
    return recordEvaluation(this.dependencies, command, "evaluation:manage");
  }
}

export class RecordCriterionSetStatus {
  constructor(private readonly dependencies: RecordEvaluationDependencies) {}

  execute(command: RecordEvaluationCommand<"criterion_set_status">) {
    return recordEvaluation(this.dependencies, command, "evaluation:manage");
  }
}

export class RecordEvaluationRunDecision {
  constructor(private readonly dependencies: RecordEvaluationDependencies) {}

  execute<Kind extends "evaluation_run" | "evaluation_run_rejection">(
    command: RecordEvaluationCommand<Kind>,
  ) {
    return recordEvaluation(this.dependencies, command, "evaluation:run");
  }
}

export class RecordRawObservation {
  constructor(private readonly dependencies: RecordEvaluationDependencies) {}

  execute(command: RecordEvaluationCommand<"raw_observation">) {
    return recordEvaluation(this.dependencies, command, "evaluation:run");
  }
}

export class RecordEvaluationRunResult {
  constructor(private readonly dependencies: RecordEvaluationDependencies) {}

  execute(command: RecordEvaluationCommand<"evaluation_run_result">) {
    return recordEvaluation(this.dependencies, command, "evaluation:run");
  }
}

export class CreateEvaluationAggregate {
  constructor(private readonly dependencies: RecordEvaluationDependencies) {}

  execute(command: RecordEvaluationCommand<"evaluation_aggregate">) {
    return recordEvaluation(this.dependencies, command, "evaluation:run");
  }
}

export class CreateAssessment {
  constructor(private readonly dependencies: RecordEvaluationDependencies) {}

  execute(command: RecordEvaluationCommand<"assessment">) {
    return recordEvaluation(this.dependencies, command, "evaluation:manage");
  }
}
