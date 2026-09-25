import {
  type ComparisonDefinition,
  type CriterionSet,
  type EvaluationRun,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  type ModelAssistedEvaluatorSpec,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
} from "@proofstack/contracts";
import { validateComparisonRecord } from "../evaluation/comparison-record-validation.js";
import type { ComparisonRepository } from "../evaluation/comparison-repository.js";
import { InvalidComparisonRecordInputError } from "../evaluation/comparison-repository-errors.js";
import { validateEvaluationRecord } from "../evaluation/evaluation-record-validation.js";
import type { EvaluationRepository } from "../evaluation/evaluation-repository.js";
import { InvalidEvaluationRecordInputError } from "../evaluation/evaluation-repository-errors.js";
import { validateModelAssuranceRecord } from "../evaluation/model-assurance-record-validation.js";
import { InvalidModelAssuranceRecordInputError } from "../evaluation/model-assurance-repository.js";
import type { PolicyEvaluationControlDeclaration } from "./policy-evaluation-control-declaration.js";
import {
  inspectPolicyEvaluationControlRecord,
  type PolicyEvaluationControlRead,
} from "./policy-evaluation-control-record-reader.js";
import { enumeratePolicyEvaluationControlReferences } from "./policy-evaluation-control-references.js";
import {
  inspectPolicyEvaluationEvidenceRecord,
  type PolicyEvaluationEvidenceRead,
} from "./policy-evaluation-evidence-reader.js";
import { enumeratePolicyEvaluationEvidenceReferences } from "./policy-evaluation-evidence-references.js";
import type {
  PolicyEvaluationEvidenceReference,
  PolicyEvaluationEvidenceReferenceLimits,
} from "./policy-evaluation-reference-collector.js";

const parentKinds = [
  "comparison_definition",
  "evaluation_run_result",
  "evaluator_spec",
  "oracle_spec",
  "qualification_fixture_set",
  "model_assisted_evaluator_spec",
  "model_evaluator_profile",
  "model_qualification_suite",
] as const;

export type PolicyEvaluationSelectorParentRead =
  | PolicyEvaluationControlRead
  | PolicyEvaluationEvidenceRead;
export type PolicyEvaluationSelectorParentSource = Extract<
  PolicyEvaluationSelectorParentRead["source"],
  { kind: (typeof parentKinds)[number] }
>;
export type PolicyEvaluationResolvableSelector =
  | Extract<
      PolicyEvaluationEvidenceReference,
      { kind: "criterion_selector" | "model_evaluator_selector" | "evaluation_run_identity" }
    >
  | {
      readonly kind: "control_declaration";
      readonly path: string;
      readonly declaration: Extract<
        PolicyEvaluationControlDeclaration,
        { kind: "comparison_predecessor" }
      >;
    };

export interface ReadPolicyEvaluationSelectorInput {
  readonly evaluationTime: string;
  readonly scope: EvidenceScope;
  readonly source: PolicyEvaluationSelectorParentSource;
  /** Exact occurrence in the captured parent, not a caller-supplied selector or fetch URL. */
  readonly path: string;
  /** The entire parent frontier must fit, even when only one occurrence is being resolved. */
  readonly limits: PolicyEvaluationEvidenceReferenceLimits;
}

export interface PolicyEvaluationSelectorReaderDependencies {
  readonly evaluation: Pick<EvaluationRepository, "findCriterionSet" | "findEvaluationRun">;
  readonly modelAssurance: {
    find(scope: EvidenceScope, kind: "model_assisted_evaluator", id: string): Promise<unknown>;
  };
  readonly comparison: Pick<ComparisonRepository, "findComparisonDefinition">;
}

type VerifiedChild = {
  readonly source: Extract<
    PolicyEvaluationSelectorParentRead["source"],
    {
      kind:
        | "criterion_set"
        | "evaluation_run"
        | "model_assisted_evaluator_spec"
        | "comparison_definition";
    }
  >;
  readonly observation: { readonly status: "verified"; readonly recordSha256: string };
  readonly record: CriterionSet | EvaluationRun | ModelAssistedEvaluatorSpec | ComparisonDefinition;
};
type Resolution =
  | { readonly status: "resolved"; readonly evidence: VerifiedChild }
  | { readonly status: "missing"; readonly evidence: null }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "record_invalid"
        | "reference_mismatch"
        | "lineage_mismatch"
        | "not_yet_available";
      readonly evidence: null;
    };

export type PolicyEvaluationSelectorRead = Resolution & {
  readonly parent: {
    readonly source: PolicyEvaluationSelectorParentSource;
    readonly recordSha256: string;
  };
  readonly reference: PolicyEvaluationResolvableSelector;
};

export class PolicyEvaluationSelectorReadInputError extends TypeError {
  readonly code = "policy_evaluation_selector_read_input_invalid";

  constructor(options?: ErrorOptions) {
    super("Expected a supported selector occurrence in an exact captured parent", options);
    this.name = "PolicyEvaluationSelectorReadInputError";
  }
}

function parseInput(input: ReadPolicyEvaluationSelectorInput): ReadPolicyEvaluationSelectorInput {
  try {
    if (
      !input ||
      Object.keys(input).some(
        (key) => !["evaluationTime", "scope", "source", "path", "limits"].includes(key),
      )
    )
      throw new TypeError("Unexpected selector read fields");
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    const path = input.path;
    if (
      !parentKinds.some((kind) => kind === source.kind) ||
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.length > 1024
    )
      throw new TypeError("Unsupported selector parent or path");
    return {
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
      limits: structuredClone(input.limits),
      path,
      scope: EvidenceScopeSchema.parse(input.scope),
      source: source as PolicyEvaluationSelectorParentSource,
    };
  } catch (cause) {
    throw new PolicyEvaluationSelectorReadInputError({ cause });
  }
}

function isResolvable(
  reference: PolicyEvaluationEvidenceReference,
): reference is PolicyEvaluationResolvableSelector {
  return (
    reference.kind === "criterion_selector" ||
    reference.kind === "model_evaluator_selector" ||
    reference.kind === "evaluation_run_identity" ||
    (reference.kind === "control_declaration" &&
      reference.declaration.kind === "comparison_predecessor")
  );
}

function readChild(
  scope: EvidenceScope,
  reference: PolicyEvaluationResolvableSelector,
  dependencies: PolicyEvaluationSelectorReaderDependencies,
): Promise<unknown> {
  switch (reference.kind) {
    case "criterion_selector":
      return dependencies.evaluation.findCriterionSet(
        scope,
        reference.selector.criterionSetVersionId,
      );
    case "model_evaluator_selector":
      return dependencies.modelAssurance.find(
        scope,
        "model_assisted_evaluator",
        reference.selector.evaluatorVersionId,
      );
    case "evaluation_run_identity":
      return dependencies.evaluation.findEvaluationRun(scope, reference.evaluationRunId);
    case "control_declaration":
      return dependencies.comparison.findComparisonDefinition(
        scope,
        reference.declaration.reference.comparisonVersionId,
      );
  }
}

function unavailable(reason: Extract<Resolution, { status: "unavailable" }>["reason"]): Resolution {
  return { evidence: null, reason, status: "unavailable" };
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function inspectChild(
  input: ReadPolicyEvaluationSelectorInput,
  reference: PolicyEvaluationResolvableSelector,
  raw: unknown,
): Resolution {
  if (raw === null) return { evidence: null, status: "missing" };
  let source: VerifiedChild["source"];
  let record: VerifiedChild["record"];
  try {
    switch (reference.kind) {
      case "criterion_selector": {
        const child = validateEvaluationRecord("criterion_set", raw) as CriterionSet;
        const selector = reference.selector;
        if (
          child.criterionSetId !== selector.criterionSetId ||
          child.criterionSetVersionId !== selector.criterionSetVersionId
        )
          return unavailable("reference_mismatch");
        if (!child.criteria.some(({ criterionId }) => criterionId === selector.criterionId))
          return unavailable("lineage_mismatch");
        source = {
          kind: "criterion_set",
          reference: {
            criterionSetId: child.criterionSetId,
            criterionSetVersionId: child.criterionSetVersionId,
            definitionSha256: child.definitionSha256,
          },
        };
        record = child;
        break;
      }
      case "model_evaluator_selector": {
        const child = validateModelAssuranceRecord(
          "model_assisted_evaluator",
          raw,
        ) as ModelAssistedEvaluatorSpec;
        if (
          child.evaluatorId !== reference.selector.evaluatorId ||
          child.evaluatorVersionId !== reference.selector.evaluatorVersionId
        )
          return unavailable("reference_mismatch");
        if (
          input.source.kind !== "model_evaluator_profile" ||
          !same(child.modelProfile, input.source.reference)
        )
          return unavailable("lineage_mismatch");
        source = {
          kind: "model_assisted_evaluator_spec",
          reference: {
            evaluatorId: child.evaluatorId,
            evaluatorVersionId: child.evaluatorVersionId,
            definitionSha256: child.definitionSha256,
          },
        };
        record = child;
        break;
      }
      case "evaluation_run_identity": {
        const child = validateEvaluationRecord("evaluation_run", raw) as EvaluationRun;
        if (child.evaluationRunId !== reference.evaluationRunId)
          return unavailable("reference_mismatch");
        source = {
          kind: "evaluation_run",
          reference: {
            evaluationRunId: child.evaluationRunId,
            definitionSha256: child.definitionSha256,
          },
        };
        record = child;
        break;
      }
      case "control_declaration": {
        const child = validateComparisonRecord(
          "comparison_definition",
          raw,
        ) as ComparisonDefinition;
        if (
          child.comparisonVersionId !== reference.declaration.reference.comparisonVersionId ||
          child.definitionSha256 !== reference.declaration.reference.definitionSha256
        )
          return unavailable("reference_mismatch");
        if (
          input.source.kind !== "comparison_definition" ||
          child.comparisonId !== input.source.reference.comparisonId
        )
          return unavailable("lineage_mismatch");
        source = {
          kind: "comparison_definition",
          reference: {
            comparisonId: child.comparisonId,
            comparisonVersionId: child.comparisonVersionId,
            definitionSha256: child.definitionSha256,
          },
        };
        record = child;
        break;
      }
    }
  } catch (cause) {
    if (
      cause instanceof InvalidEvaluationRecordInputError ||
      cause instanceof InvalidModelAssuranceRecordInputError ||
      cause instanceof InvalidComparisonRecordInputError
    )
      return unavailable("record_invalid");
    throw cause;
  }
  // The exact reference is derived only from a schema- and digest-validated retained body.
  // Fixed inspectors then enforce scope, original receipt cut, and complete record hashing.
  const checked =
    source.kind === "comparison_definition"
      ? inspectPolicyEvaluationControlRecord(
          { evaluationTime: input.evaluationTime, scope: input.scope, source },
          record,
        )
      : inspectPolicyEvaluationEvidenceRecord(
          { evaluationTime: input.evaluationTime, scope: input.scope, source },
          record,
        );
  if (checked.observation.status !== "verified" || checked.record === null) {
    if (checked.observation.status === "unavailable")
      return unavailable(checked.observation.reason);
    throw new TypeError("A validated selector child lost its retained record");
  }
  return {
    evidence: {
      observation: checked.observation,
      record: checked.record as VerifiedChild["record"],
      source,
    },
    status: "resolved",
  };
}

/**
 * Resolves one parent-bound occurrence through fixed read-only ports. Parent reinspection and
 * whole-frontier budgets precede I/O; no latest lookup, synthetic digest, validator plugin, or
 * missing-as-success fallback exists. Storage exceptions (including typed errors) propagate.
 * This is not authorization, complete graph/byte/authority capture, or policy satisfaction.
 */
export async function readPolicyEvaluationSelector(
  input: ReadPolicyEvaluationSelectorInput,
  evidence: PolicyEvaluationSelectorParentRead,
  dependencies: PolicyEvaluationSelectorReaderDependencies,
): Promise<PolicyEvaluationSelectorRead> {
  const fixed = parseInput(input);
  const context = {
    evaluationTime: fixed.evaluationTime,
    scope: fixed.scope,
    source: fixed.source,
  };
  const frontier =
    fixed.source.kind === "comparison_definition"
      ? enumeratePolicyEvaluationControlReferences(
          { ...context, source: fixed.source },
          evidence as PolicyEvaluationControlRead,
          fixed.limits,
        )
      : enumeratePolicyEvaluationEvidenceReferences(
          { ...context, source: fixed.source },
          evidence as PolicyEvaluationEvidenceRead,
          fixed.limits,
        );
  const reference = frontier.references.find((value) => value.path === fixed.path);
  if (!reference || !isResolvable(reference)) throw new PolicyEvaluationSelectorReadInputError();
  const raw = await readChild(structuredClone(fixed.scope), reference, dependencies);
  return {
    parent: { recordSha256: frontier.recordSha256, source: fixed.source },
    reference,
    ...inspectChild(fixed, reference, raw),
  };
}
