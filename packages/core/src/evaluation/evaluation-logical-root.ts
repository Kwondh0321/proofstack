import type {
  CriterionSet,
  EvaluationAggregationPolicy,
  EvaluatorSpec,
  EvidenceScope,
  OracleSpec,
  QualificationFixtureSet,
} from "@proofstack/contracts";
import { InvalidEvaluationRecordInputError } from "./evaluation-repository-errors.js";

/** Only these owning record kinds have retained logical-resource bindings. */
export interface EvaluationLogicalRootRecordByKind {
  readonly aggregation_policy: EvaluationAggregationPolicy;
  readonly criterion_set: CriterionSet;
  readonly evaluator_spec: EvaluatorSpec;
  readonly oracle_spec: OracleSpec;
  readonly qualification_fixture_set: QualificationFixtureSet;
}

export type EvaluationLogicalRootKind = keyof EvaluationLogicalRootRecordByKind;

export function requireEvaluationLogicalRootKind(kind: unknown): EvaluationLogicalRootKind {
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      return kind;
    default:
      throw new InvalidEvaluationRecordInputError(
        "Evaluation logical-root reads require a supported resource record kind",
      );
  }
}

/**
 * Own the complete original root of an exact stored resource definition. The owning binding,
 * rather than predecessor traversal, receipt order or latest lookup, selects the root. Absence
 * and foreign scope return null; corrupt in-scope storage fails. Receipts and returned values
 * are preserved and owned. This read establishes neither current authority nor a sealed input.
 */
export interface EvaluationLogicalRootReader {
  findEvaluationLogicalRoot<K extends EvaluationLogicalRootKind>(
    scope: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<EvaluationLogicalRootRecordByKind[K] | null>;
}
