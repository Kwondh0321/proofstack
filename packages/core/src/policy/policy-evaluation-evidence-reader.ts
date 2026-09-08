import { createHash } from "node:crypto";
import {
  type EvaluationRecordKind,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationManifestEntry,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationSourceReferenceKey,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import { validateEvaluationRecord } from "../evaluation/evaluation-record-validation.js";
import type {
  EvaluationRecord,
  EvaluationRepository,
} from "../evaluation/evaluation-repository.js";
import { InvalidEvaluationRecordInputError } from "../evaluation/evaluation-repository-errors.js";
import { validateModelAssuranceRecord } from "../evaluation/model-assurance-record-validation.js";
import {
  InvalidModelAssuranceRecordInputError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordKind,
  type ModelAssuranceRepository,
} from "../evaluation/model-assurance-repository.js";

type EvaluationReadRepository = Pick<
  EvaluationRepository,
  Extract<keyof EvaluationRepository, `find${string}`>
>;
type ReceiptField = "createdAt" | "publishedAt" | "recordedAt" | "reviewedAt";

interface EvaluationReadDescriptor {
  readonly read: (
    repository: EvaluationReadRepository,
    scope: EvidenceScope,
    recordId: string,
  ) => Promise<unknown>;
  readonly receipt: ReceiptField;
}

const evaluationReads = {
  aggregation_policy: {
    read: (repository, scope, id) => repository.findAggregationPolicy(scope, id),
    receipt: "publishedAt",
  },
  assessment: {
    read: (repository, scope, id) => repository.findAssessment(scope, id),
    receipt: "createdAt",
  },
  criterion_set: {
    read: (repository, scope, id) => repository.findCriterionSet(scope, id),
    receipt: "publishedAt",
  },
  criterion_set_status: {
    read: (repository, scope, id) => repository.findCriterionSetStatus(scope, id),
    receipt: "recordedAt",
  },
  discovery_record: {
    read: (repository, scope, id) => repository.findDiscoveryRecord(scope, id),
    receipt: "recordedAt",
  },
  evaluation_aggregate: {
    read: (repository, scope, id) => repository.findEvaluationAggregate(scope, id),
    receipt: "createdAt",
  },
  evaluation_run: {
    read: (repository, scope, id) => repository.findEvaluationRun(scope, id),
    receipt: "createdAt",
  },
  evaluation_run_rejection: {
    read: (repository, scope, id) => repository.findEvaluationRunRejection(scope, id),
    receipt: "recordedAt",
  },
  evaluation_run_result: {
    read: (repository, scope, id) => repository.findEvaluationRunResult(scope, id),
    receipt: "recordedAt",
  },
  evaluator_spec: {
    read: (repository, scope, id) => repository.findEvaluatorSpec(scope, id),
    receipt: "publishedAt",
  },
  oracle_spec: {
    read: (repository, scope, id) => repository.findOracleSpec(scope, id),
    receipt: "publishedAt",
  },
  qualification_fixture_set: {
    read: (repository, scope, id) => repository.findQualificationFixtureSet(scope, id),
    receipt: "publishedAt",
  },
  qualification_report: {
    read: (repository, scope, id) => repository.findQualificationReport(scope, id),
    receipt: "recordedAt",
  },
  raw_observation: {
    read: (repository, scope, id) => repository.findRawObservation(scope, id),
    receipt: "recordedAt",
  },
  source_review: {
    read: (repository, scope, id) => repository.findSourceReview(scope, id),
    receipt: "reviewedAt",
  },
  source_reviewer_qualification: {
    read: (repository, scope, id) => repository.findSourceReviewerQualification(scope, id),
    receipt: "recordedAt",
  },
  source_snapshot: {
    read: (repository, scope, id) => repository.findSourceSnapshot(scope, id),
    receipt: "recordedAt",
  },
} satisfies Record<EvaluationRecordKind, EvaluationReadDescriptor>;

type ModelSourceKind =
  | Exclude<
      ModelAssuranceRecordKind,
      "blinded_evaluation_plan" | "blinded_evaluation_result" | "model_assisted_evaluator"
    >
  | "blinded_plan"
  | "blinded_result"
  | "model_assisted_evaluator_spec";

const modelReads = {
  blinded_plan: { kind: "blinded_evaluation_plan", receipt: "publishedAt" },
  blinded_result: { kind: "blinded_evaluation_result", receipt: "recordedAt" },
  calibration_report: { kind: "calibration_report", receipt: "recordedAt" },
  human_review_protocol: { kind: "human_review_protocol", receipt: "publishedAt" },
  human_review_record: { kind: "human_review_record", receipt: "recordedAt" },
  human_reviewer_independence: { kind: "human_reviewer_independence", receipt: "recordedAt" },
  independence_declaration: { kind: "independence_declaration", receipt: "recordedAt" },
  independent_critique: { kind: "independent_critique", receipt: "recordedAt" },
  model_assisted_evaluator_spec: { kind: "model_assisted_evaluator", receipt: "publishedAt" },
  model_assurance_assessment: { kind: "model_assurance_assessment", receipt: "recordedAt" },
  model_evaluator_profile: { kind: "model_evaluator_profile", receipt: "publishedAt" },
  model_qualification_report: { kind: "model_qualification_report", receipt: "recordedAt" },
  model_qualification_suite: { kind: "model_qualification_suite", receipt: "publishedAt" },
} as const satisfies Record<
  ModelSourceKind,
  { readonly kind: ModelAssuranceRecordKind; readonly receipt: ReceiptField }
>;

export type PolicyEvaluationEvidenceSourceKind = EvaluationRecordKind | keyof typeof modelReads;
export type PolicyEvaluationEvidenceSource = Extract<
  PolicyEvaluationManifestEntry["source"],
  { readonly kind: PolicyEvaluationEvidenceSourceKind }
>;

export interface ReadPolicyEvaluationEvidenceInput {
  /** Internal acquisition context, derived from previously authorized and validated roots. */
  readonly evaluationTime: string;
  readonly scope: EvidenceScope;
  readonly source: PolicyEvaluationEvidenceSource;
}

export interface PolicyEvaluationEvidenceReaderDependencies {
  /** Read-only authority: no author, execution, or reviewer impersonation is required. */
  readonly evaluation: EvaluationReadRepository;
  readonly modelAssurance: Pick<ModelAssuranceRepository, "find">;
}

type EvidenceRecord = EvaluationRecord | ModelAssuranceRecord;
type UnverifiedObservation = Exclude<
  PolicyEvaluationManifestEntry["observation"],
  { readonly status: "verified" }
>;

export type PolicyEvaluationEvidenceRead = {
  readonly source: PolicyEvaluationEvidenceSource;
} & (
  | {
      readonly observation: { readonly recordSha256: string; readonly status: "verified" };
      readonly record: EvidenceRecord;
    }
  | { readonly observation: UnverifiedObservation; readonly record: null }
);

export class PolicyEvaluationEvidenceReadInputError extends TypeError {
  readonly code = "policy_evaluation_evidence_read_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyEvaluationEvidenceReadInputError";
  }
}

function parseInput(input: ReadPolicyEvaluationEvidenceInput): ReadPolicyEvaluationEvidenceInput {
  try {
    const scope = EvidenceScopeSchema.parse(input.scope);
    const evaluationTime = PolicyEvaluationTimeSchema.parse(input.evaluationTime);
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    if (!Object.hasOwn(evaluationReads, source.kind) && !Object.hasOwn(modelReads, source.kind)) {
      throw new TypeError("Unsupported policy evaluation evidence source kind");
    }
    return { evaluationTime, scope, source: source as PolicyEvaluationEvidenceSource };
  } catch (cause) {
    throw new PolicyEvaluationEvidenceReadInputError(
      "Policy evaluation evidence reads require an exact supported source, scope, and UTC time",
      { cause },
    );
  }
}

function routeFor(
  source: PolicyEvaluationEvidenceSource,
  dependencies: PolicyEvaluationEvidenceReaderDependencies,
): {
  readonly read: (scope: EvidenceScope, id: string) => Promise<unknown>;
} {
  if (Object.hasOwn(evaluationReads, source.kind)) {
    const kind = source.kind as EvaluationRecordKind;
    const descriptor = evaluationReads[kind];
    return {
      read: (scope, id) => descriptor.read(dependencies.evaluation, scope, id),
    };
  }
  const descriptor = modelReads[source.kind as keyof typeof modelReads];
  return {
    read: (scope, id) => dependencies.modelAssurance.find(scope, descriptor.kind, id),
  };
}

function validationFor(source: PolicyEvaluationEvidenceSource): {
  readonly receipt: ReceiptField;
  readonly validate: (raw: unknown) => EvidenceRecord;
} {
  if (Object.hasOwn(evaluationReads, source.kind)) {
    const kind = source.kind as EvaluationRecordKind;
    return {
      receipt: evaluationReads[kind].receipt,
      validate: (raw) => validateEvaluationRecord(kind, raw),
    };
  }
  const descriptor = modelReads[source.kind as keyof typeof modelReads];
  return {
    receipt: descriptor.receipt,
    validate: (raw) => validateModelAssuranceRecord(descriptor.kind, raw),
  };
}

/**
 * Reads one immutable evaluation/assurance record; this is not a public authorization boundary.
 * "verified" binds this record only, not its dependencies, artifact bytes, qualification, policy
 * satisfaction, or a sealed snapshot. The enclosing capture owns cumulative I/O/time budgets,
 * complete recursive enumeration, parent-child checks, and lifecycle revision guards.
 * Repository exceptions propagate; an outage is never a fabricated missing/invalid observation.
 */
export async function readPolicyEvaluationEvidence(
  input: ReadPolicyEvaluationEvidenceInput,
  dependencies: PolicyEvaluationEvidenceReaderDependencies,
): Promise<PolicyEvaluationEvidenceRead> {
  // Own all context before awaiting repository code, including a separate copy passed to the port.
  const { evaluationTime, scope, source } = parseInput(input);
  const recordId = policyEvaluationSourceReferenceKey(source).slice(source.kind.length + 1);
  const route = routeFor(source, dependencies);
  const raw = await route.read(structuredClone(scope), recordId);
  return inspectPolicyEvaluationEvidenceRecord({ evaluationTime, scope, source }, raw);
}

/** Pure record-level revalidation; no repository access or authorization is implied. */
export function inspectPolicyEvaluationEvidenceRecord(
  input: ReadPolicyEvaluationEvidenceInput,
  raw: unknown,
): PolicyEvaluationEvidenceRead {
  const { evaluationTime, scope, source } = parseInput(input);
  const route = validationFor(source);
  const unavailable = (observation: UnverifiedObservation): PolicyEvaluationEvidenceRead => ({
    observation,
    record: null,
    source,
  });
  if (raw === null) return unavailable({ status: "missing" });

  let record: EvidenceRecord;
  try {
    record = route.validate(raw);
  } catch (cause) {
    if (
      !(cause instanceof InvalidEvaluationRecordInputError) &&
      !(cause instanceof InvalidModelAssuranceRecordInputError)
    ) {
      throw cause;
    }
    return unavailable({ reason: "record_invalid", status: "unavailable" });
  }
  const fields = record as unknown as Readonly<Record<string, unknown>>;
  // All admitted references are strict scalar projections. Check every field, not merely the ID
  // used for lookup: logical parent IDs and run IDs are part of the immutable reference too.
  if (
    record.scope.tenantId !== scope.tenantId ||
    record.scope.projectId !== scope.projectId ||
    record.scope.environmentId !== scope.environmentId ||
    !Object.entries(source.reference).every(([key, value]) => fields[key] === value)
  ) {
    return unavailable({ reason: "reference_mismatch", status: "unavailable" });
  }
  const receipt = fields[route.receipt];
  if (typeof receipt !== "string")
    throw new TypeError("Validated evidence record omitted its receipt time");
  if (
    policyEvaluationTimestampOrderKey(receipt) > policyEvaluationTimestampOrderKey(evaluationTime)
  ) {
    return unavailable({ reason: "not_yet_available", status: "unavailable" });
  }
  return {
    observation: {
      recordSha256: createHash("sha256")
        .update(encodeEvaluationCanonicalJson(record))
        .digest("hex"),
      status: "verified",
    },
    record,
    source,
  };
}
