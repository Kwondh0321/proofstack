import type {
  BlindedEvaluationPlanDefinition,
  BlindedEvaluationResultDefinition,
  CalibrationReportDefinition,
  EvidenceScope,
  HumanReviewerIndependenceDefinition,
  HumanReviewProtocolDefinition,
  HumanReviewRecordDefinition,
  IndependenceDeclarationDefinition,
  IndependentCritiqueDefinition,
  ModelAssistedEvaluatorSpecDefinition,
  ModelEvaluatorProfileDefinition,
  ModelQualificationReportDefinition,
  ModelQualificationSuiteDefinition,
  PrincipalContext,
} from "@proofstack/contracts";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PrincipalContextSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import { ForbiddenError } from "../errors.js";
import {
  digestModelAssuranceRecordDefinition,
  modelAssuranceRecordId,
  validateModelAssuranceRecord,
} from "./model-assurance-record-validation.js";
import {
  InvalidModelAssuranceRecordInputError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordByKind,
  ModelAssuranceRecordConflictError,
  type ModelAssuranceRecordKind,
  ModelAssuranceRecordNotFoundError,
  type ModelAssuranceRepository,
  ModelAssuranceRepositoryContractError,
  type PublishModelAssuranceRecordResult,
} from "./model-assurance-repository.js";

export interface ModelAssuranceDefinitionByKind {
  readonly blinded_evaluation_plan: BlindedEvaluationPlanDefinition;
  readonly blinded_evaluation_result: BlindedEvaluationResultDefinition;
  readonly calibration_report: CalibrationReportDefinition;
  readonly human_review_protocol: HumanReviewProtocolDefinition;
  readonly human_review_record: HumanReviewRecordDefinition;
  readonly human_reviewer_independence: HumanReviewerIndependenceDefinition;
  readonly independence_declaration: IndependenceDeclarationDefinition;
  readonly independent_critique: IndependentCritiqueDefinition;
  readonly model_assisted_evaluator: ModelAssistedEvaluatorSpecDefinition;
  readonly model_evaluator_profile: ModelEvaluatorProfileDefinition;
  readonly model_qualification_report: ModelQualificationReportDefinition;
  readonly model_qualification_suite: ModelQualificationSuiteDefinition;
}

export type ModelAssurancePublicationKind = keyof ModelAssuranceDefinitionByKind;
export type ModelAssuranceManagementKind = Exclude<
  ModelAssurancePublicationKind,
  | "blinded_evaluation_result"
  | "human_review_record"
  | "independent_critique"
  | "model_qualification_report"
>;
export type ModelAssuranceExecutionKind = Extract<
  ModelAssurancePublicationKind,
  "blinded_evaluation_result" | "independent_critique" | "model_qualification_report"
>;

interface ModelAssuranceRoute {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly recordId: string;
}

export interface RecordModelAssuranceCommand<Kind extends ModelAssurancePublicationKind>
  extends ModelAssuranceRoute {
  readonly definition: ModelAssuranceDefinitionByKind[Kind];
  readonly kind: Kind;
}

export interface ReadModelAssuranceRecordCommand extends ModelAssuranceRoute {
  readonly kind: ModelAssuranceRecordKind;
}

export interface RecordModelAssuranceDependencies {
  readonly clock: Clock;
  readonly repository: ModelAssuranceRepository;
}

export interface RecordModelAssuranceResult<Kind extends ModelAssurancePublicationKind> {
  readonly created: boolean;
  readonly record: ModelAssuranceRecordByKind[Kind];
}

function invalidInput(message: string, cause?: unknown): InvalidModelAssuranceRecordInputError {
  return new InvalidModelAssuranceRecordInputError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function authorizedRoute(
  command: ModelAssuranceRoute,
  capability:
    | "evaluation:human:review"
    | "evaluation:manage"
    | "evaluation:model:run"
    | "evaluation:read",
  userOnly = false,
): {
  readonly principal: PrincipalContext;
  readonly recordId: string;
  readonly scope: EvidenceScope;
} {
  let principal: PrincipalContext;
  try {
    principal = PrincipalContextSchema.parse(command.principal);
  } catch (cause) {
    throw invalidInput("Model-assurance principal is invalid", cause);
  }
  requireCapability(principal, capability);
  if (userOnly && principal.principalType !== "user") {
    throw new ForbiddenError("Human review requires an authenticated user principal");
  }
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
  return { principal, recordId: recordId.data, scope: scope.data };
}

function serverTimestamp(clock: Clock): string {
  let value: string;
  try {
    value = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Model-assurance clock is invalid", cause);
  }
  const parsed = UtcMillisecondTimestampSchema.safeParse(value);
  if (!parsed.success) throw invalidInput("Model-assurance clock is invalid", parsed.error);
  return parsed.data;
}

function receipt(
  kind: ModelAssurancePublicationKind,
  principal: PrincipalContext,
  timestamp: string,
): Readonly<Record<string, string>> {
  switch (kind) {
    case "blinded_evaluation_plan":
    case "human_review_protocol":
    case "model_assisted_evaluator":
    case "model_evaluator_profile":
    case "model_qualification_suite":
      return { publishedAt: timestamp, publishedByPrincipalId: principal.principalId };
    case "blinded_evaluation_result":
    case "independent_critique":
      return { recordedAt: timestamp, recordedByPrincipalId: principal.principalId };
    case "calibration_report":
    case "human_review_record":
    case "human_reviewer_independence":
    case "independence_declaration":
    case "model_qualification_report":
      return { recordedAt: timestamp };
  }
}

function createCandidate<Kind extends ModelAssurancePublicationKind>(
  kind: Kind,
  definitionInput: unknown,
  principal: PrincipalContext,
  scope: EvidenceScope,
  timestamp: string,
): ModelAssuranceRecordByKind[Kind] {
  try {
    const definition = structuredClone(definitionInput) as ModelAssuranceDefinitionByKind[Kind];
    if (
      kind === "model_qualification_report" &&
      (definition as ModelQualificationReportDefinition).executedByPrincipalId !==
        principal.principalId
    ) {
      throw invalidInput("Model qualification executor must match the authenticated principal");
    }
    if (kind === "human_review_record") {
      const reviewer = (definition as HumanReviewRecordDefinition).reviewer;
      if (
        reviewer.principalId !== principal.principalId ||
        reviewer.principalType !== principal.principalType ||
        reviewer.requestId !== principal.requestId ||
        reviewer.authenticationMethod !== principal.authentication.method ||
        reviewer.authenticatedAt !== principal.authentication.authenticatedAt ||
        reviewer.credentialId !== principal.authentication.credentialId
      ) {
        throw invalidInput("Human reviewer session must match the authenticated principal");
      }
    }
    const candidate = {
      ...definition,
      ...receipt(kind, principal, timestamp),
      definitionSha256: digestModelAssuranceRecordDefinition(kind, scope, definition),
      schemaVersion: "0.1",
      scope,
    };
    return validateModelAssuranceRecord(kind, candidate) as ModelAssuranceRecordByKind[Kind];
  } catch (cause) {
    if (cause instanceof InvalidModelAssuranceRecordInputError) throw cause;
    throw invalidInput(`Invalid ${kind} definition`, cause);
  }
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function validateRepositoryRecord<Kind extends ModelAssuranceRecordKind>(
  input: unknown,
  kind: Kind,
  scope: EvidenceScope,
  recordId: string,
): ModelAssuranceRecordByKind[Kind] {
  let record: ModelAssuranceRecord;
  try {
    record = validateModelAssuranceRecord(kind, input);
  } catch (cause) {
    throw new ModelAssuranceRepositoryContractError(
      "Model-assurance repository returned an invalid record",
      { cause },
    );
  }
  if (modelAssuranceRecordId(kind, record) !== recordId || !sameScope(record.scope, scope)) {
    throw new ModelAssuranceRepositoryContractError(
      "Model-assurance repository substituted a record outside the exact query",
    );
  }
  return record as ModelAssuranceRecordByKind[Kind];
}

function validatePublicationResult<Kind extends ModelAssuranceRecordKind>(
  input: unknown,
  kind: Kind,
  scope: EvidenceScope,
  recordId: string,
): PublishModelAssuranceRecordResult<ModelAssuranceRecordByKind[Kind]> {
  if (typeof input !== "object" || input === null) {
    throw new ModelAssuranceRepositoryContractError(
      "Model-assurance repository returned an invalid result",
    );
  }
  let keys: readonly PropertyKey[];
  let created: unknown;
  let record: unknown;
  try {
    keys = Reflect.ownKeys(input);
    created = Reflect.get(input, "created");
    record = Reflect.get(input, "record");
  } catch (cause) {
    throw new ModelAssuranceRepositoryContractError(
      "Model-assurance repository result is unreadable",
      { cause },
    );
  }
  if (
    keys.length !== 2 ||
    !keys.includes("created") ||
    !keys.includes("record") ||
    typeof created !== "boolean"
  ) {
    throw new ModelAssuranceRepositoryContractError(
      "Model-assurance repository returned an invalid result",
    );
  }
  return { created, record: validateRepositoryRecord(record, kind, scope, recordId) };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function recordModelAssurance<Kind extends ModelAssurancePublicationKind>(
  dependencies: RecordModelAssuranceDependencies,
  command: RecordModelAssuranceCommand<Kind>,
  capability: "evaluation:human:review" | "evaluation:manage" | "evaluation:model:run",
  userOnly = false,
): Promise<RecordModelAssuranceResult<Kind>> {
  const { principal, recordId, scope } = authorizedRoute(command, capability, userOnly);
  const candidate = createCandidate(
    command.kind,
    command.definition,
    principal,
    scope,
    serverTimestamp(dependencies.clock),
  );
  if (modelAssuranceRecordId(command.kind, candidate) !== recordId) {
    throw invalidInput("Model-assurance route identifier and immutable definition do not match");
  }

  const existingInput = await dependencies.repository.find(
    structuredClone(scope),
    command.kind,
    recordId,
  );
  if (existingInput !== null) {
    const existing = validateRepositoryRecord(existingInput, command.kind, scope, recordId);
    if (existing.definitionSha256 !== candidate.definitionSha256) {
      throw new ModelAssuranceRecordConflictError(command.kind, recordId);
    }
    const retry = validatePublicationResult(
      await dependencies.repository.publish(command.kind, structuredClone(existing)),
      command.kind,
      scope,
      recordId,
    );
    if (retry.created || !sameJson(retry.record, existing)) {
      throw new ModelAssuranceRepositoryContractError(
        "Model-assurance retry violated repository semantics",
      );
    }
    return { created: false, record: structuredClone(retry.record) };
  }

  const result = validatePublicationResult(
    await dependencies.repository.publish(command.kind, structuredClone(candidate)),
    command.kind,
    scope,
    recordId,
  );
  if (result.record.definitionSha256 !== candidate.definitionSha256) {
    throw new ModelAssuranceRepositoryContractError(
      "Model-assurance publication substituted semantics",
    );
  }
  return { created: result.created, record: structuredClone(result.record) };
}

export class ReadModelAssuranceRecord {
  constructor(private readonly repository: ModelAssuranceRepository) {}

  async execute(command: ReadModelAssuranceRecordCommand): Promise<ModelAssuranceRecord> {
    const { recordId, scope } = authorizedRoute(command, "evaluation:read");
    const record = await this.repository.find(structuredClone(scope), command.kind, recordId);
    if (record === null) {
      throw new ModelAssuranceRecordNotFoundError(command.kind, recordId);
    }
    return structuredClone(validateRepositoryRecord(record, command.kind, scope, recordId));
  }
}

export class PublishModelAssuranceDefinition {
  constructor(private readonly dependencies: RecordModelAssuranceDependencies) {}

  execute<Kind extends ModelAssuranceManagementKind>(
    command: RecordModelAssuranceCommand<Kind>,
  ): Promise<RecordModelAssuranceResult<Kind>> {
    return recordModelAssurance(this.dependencies, command, "evaluation:manage");
  }
}

export class RecordModelAssuranceExecution {
  constructor(private readonly dependencies: RecordModelAssuranceDependencies) {}

  execute<Kind extends ModelAssuranceExecutionKind>(
    command: RecordModelAssuranceCommand<Kind>,
  ): Promise<RecordModelAssuranceResult<Kind>> {
    return recordModelAssurance(this.dependencies, command, "evaluation:model:run");
  }
}

export class RecordHumanReview {
  constructor(private readonly dependencies: RecordModelAssuranceDependencies) {}

  execute(
    command: RecordModelAssuranceCommand<"human_review_record">,
  ): Promise<RecordModelAssuranceResult<"human_review_record">> {
    return recordModelAssurance(this.dependencies, command, "evaluation:human:review", true);
  }
}
