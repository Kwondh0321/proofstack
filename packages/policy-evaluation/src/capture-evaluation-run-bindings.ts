import {
  type CriterionSet,
  type CriterionSetStatusRecord,
  type EvaluationAggregationPolicy,
  type EvaluationRun,
  type EvaluatorSpec,
  type OracleSpec,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  type QualificationFixtureSet,
  type QualificationReport,
  encodeEvaluationCanonicalJson,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import { digestApplicabilityContext, evaluateApplicability } from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordRead } from "./record-routing.js";
import {
  type PolicyRelationshipMaterial,
  semanticRelationshipRead,
} from "./relationship-material.js";

export interface PolicyEvaluationRunBindingCheck {
  readonly kind:
    | "run_criterion"
    | "run_applicability_context"
    | "run_applicability_result"
    | "run_criterion_receipt"
    | "run_status"
    | "run_aggregation"
    | "run_source_reviews"
    | "run_criterion_reference"
    | "run_specification"
    | "run_budget"
    | "run_qualification_subject"
    | "run_qualification_fixture_set"
    | "run_qualification_cases"
    | "run_qualification_coverage"
    | "run_qualification_outcome"
    | "run_qualification_window"
    | "run_qualification_receipts";
  readonly path: string;
  readonly observation: { readonly status: "matched" | "mismatch" | "unavailable" };
}

type ReadDependency = (
  parent: PolicyRelationshipMaterial,
  path: string,
  kind: PolicyEvaluationSourceReference["kind"],
) => PolicyRelationshipMaterial | undefined;

/** Keep the existing semantic helper's verified-only access and original callback records. */
export function inspectCapturedEvaluationRun(
  parent: PolicyRecordRead,
  read: (
    owner: PolicyRecordRead,
    path: string,
    kind: PolicyEvaluationSourceReference["kind"],
  ) => PolicyRecordRead | undefined,
): readonly PolicyEvaluationRunBindingCheck[] {
  const originals = new Map([[policyEvaluationSourceReferenceKey(parent.source), parent]]);
  return inspectEvaluationRunMaterial(semanticRelationshipRead(parent), (owner, path, kind) => {
    const original = originals.get(policyEvaluationSourceReferenceKey(owner.source));
    if (!original) throw new PolicyRecordGraphError("reference_conflict");
    const child = read(original, path, kind);
    if (!child) return undefined;
    originals.set(policyEvaluationSourceReferenceKey(child.source), child);
    return semanticRelationshipRead(child);
  });
}

function body<T>(read: PolicyRelationshipMaterial | undefined): T | undefined {
  return read?.body ? (read.body.record as T) : undefined;
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function beforeOrAt(left: string, right: string): boolean {
  return policyEvaluationTimestampOrderKey(left) <= policyEvaluationTimestampOrderKey(right);
}

/** Shared body rules; the owning semantic/stored wrapper controls availability and admission. */
export function inspectEvaluationRunMaterial(
  parent: PolicyRelationshipMaterial,
  read: ReadDependency,
): readonly PolicyEvaluationRunBindingCheck[] {
  if (!parent.body) throw new PolicyRecordGraphError("reference_conflict");
  const run = parent.body.record as EvaluationRun;
  const checks: PolicyEvaluationRunBindingCheck[] = [];
  const check = (
    kind: PolicyEvaluationRunBindingCheck["kind"],
    path: string,
    matches: boolean | undefined,
  ) => {
    checks.push({
      kind,
      path,
      observation: {
        status: matches === undefined ? "unavailable" : matches ? "matched" : "mismatch",
      },
    });
  };
  const criterionSet = body<CriterionSet>(read(parent, "/criterion/criterionSet", "criterion_set"));
  const criterion = criterionSet?.criteria.find((c) => c.criterionId === run.criterion.criterionId);
  const selector = {
    criterionId: run.criterion.criterionId,
    criterionSetId: run.criterion.criterionSet.criterionSetId,
    criterionSetVersionId: run.criterion.criterionSet.criterionSetVersionId,
  };
  check(
    "run_criterion",
    "/criterion",
    criterionSet === undefined ? undefined : criterion !== undefined,
  );
  const context = run.applicability.context;
  check(
    "run_applicability_context",
    "/applicability/context",
    digestApplicabilityContext(context) === run.applicability.contextSha256 &&
      (context.environmentId === undefined || context.environmentId === run.scope.environmentId),
  );
  check(
    "run_applicability_result",
    "/applicability/result",
    criterion === undefined
      ? undefined
      : evaluateApplicability(criterion.applicability, context).result === run.applicability.result,
  );
  check(
    "run_criterion_receipt",
    "/criterion",
    criterionSet === undefined
      ? undefined
      : beforeOrAt(criterionSet.publishedAt, run.applicability.evaluatedAt),
  );
  const status = body<CriterionSetStatusRecord>(
    read(parent, "/criterionStatus", "criterion_set_status"),
  );
  check(
    "run_status",
    "/criterionStatus",
    status === undefined
      ? undefined
      : same(status.criterionSet, run.criterion.criterionSet) &&
          status.status === "approved" &&
          beforeOrAt(status.recordedAt, run.createdAt) &&
          beforeOrAt(status.effectiveAt, run.createdAt) &&
          (status.expiresAt === undefined || !beforeOrAt(status.expiresAt, run.createdAt)),
  );
  const policy = body<EvaluationAggregationPolicy>(
    read(parent, "/aggregationPolicy", "aggregation_policy"),
  );
  check(
    "run_aggregation",
    "/aggregationPolicy",
    policy === undefined
      ? undefined
      : same(policy.dataset, run.dataset) && beforeOrAt(policy.publishedAt, run.createdAt),
  );
  const reviewKey = (reference: EvaluationRun["sourceReviews"][number]) =>
    JSON.stringify([reference.sourceReviewId, reference.definitionSha256]);
  check(
    "run_source_reviews",
    "/sourceReviews",
    criterionSet === undefined
      ? undefined
      : same(
          run.sourceReviews.map(reviewKey).sort(),
          criterionSet.sources.map(({ review }) => reviewKey(review)).sort(),
        ),
  );

  for (const role of ["evaluator", "oracle"] as const) {
    const spec = body<EvaluatorSpec | OracleSpec>(read(parent, `/${role}`, `${role}_spec`));
    check(
      "run_criterion_reference",
      `/${role}`,
      criterion === undefined ? undefined : same(criterion[role], run[role]),
    );
    check(
      "run_specification",
      `/${role}`,
      spec === undefined
        ? undefined
        : spec.supportedCriteria.some((supported) => same(supported, selector)) &&
            beforeOrAt(spec.publishedAt, run.createdAt) &&
            (!("oracles" in spec) || spec.oracles.some((reference) => same(reference, run.oracle))),
    );
    check(
      "run_budget",
      `/${role}`,
      spec === undefined
        ? undefined
        : run.attempts.every(({ budgets }) =>
            (Object.keys(spec.budgets) as (keyof typeof budgets)[]).every(
              (key) => budgets[key] <= spec.budgets[key],
            ),
          ),
    );

    const path = `/${role}Qualification`;
    const reportRead = read(parent, path, "qualification_report");
    const report = body<QualificationReport>(reportRead);
    const fixtureSet =
      report === undefined
        ? undefined
        : body<QualificationFixtureSet>(
            read(
              reportRead as PolicyRelationshipMaterial,
              "/fixtureSet",
              "qualification_fixture_set",
            ),
          );
    // Owning schemas guarantee unique fixture versions. Index once instead of a quadratic
    // criterion-fixture by qualification-corpus search for every retained run.
    const casesByFixture = new Map(fixtureSet?.cases.map((c) => [c.fixture.fixtureVersionId, c]));
    check(
      "run_qualification_subject",
      path,
      report === undefined
        ? undefined
        : same(
            report.subject,
            role === "evaluator"
              ? { kind: role, evaluator: run.evaluator }
              : { kind: role, oracle: run.oracle },
          ),
    );
    check(
      "run_qualification_fixture_set",
      path,
      report === undefined || spec === undefined
        ? undefined
        : same(report.fixtureSet, spec.qualificationFixtureSet),
    );
    check(
      "run_qualification_cases",
      path,
      report === undefined || fixtureSet === undefined
        ? undefined
        : report.caseResults.length === fixtureSet.cases.length &&
            report.caseResults.every((result, index) => {
              const declared = fixtureSet.cases[index];
              return (
                declared !== undefined &&
                declared.caseId === result.caseId &&
                declared.caseKind === result.caseKind &&
                declared.expectedOutcome === result.expectedOutcome
              );
            }),
    );
    check(
      "run_qualification_coverage",
      path,
      criterion === undefined || fixtureSet === undefined
        ? undefined
        : criterion.qualificationFixtures.every((required) => {
            const declared = casesByFixture.get(required.fixture.fixtureVersionId);
            return (
              declared !== undefined &&
              same(required.fixture, declared.fixture) &&
              same(declared.criterion, selector) &&
              required.caseKind === declared.caseKind &&
              required.expectedVerdict === declared.expectedOutcome
            );
          }),
    );
    check(
      "run_qualification_outcome",
      path,
      report === undefined ? undefined : report.status === "qualified",
    );
    check(
      "run_qualification_window",
      path,
      report === undefined
        ? undefined
        : beforeOrAt(report.recordedAt, run.createdAt) &&
            beforeOrAt(report.completedAt, run.createdAt) &&
            beforeOrAt(report.validFrom, run.createdAt) &&
            !beforeOrAt(report.validUntil, run.createdAt),
    );
    check(
      "run_qualification_receipts",
      path,
      report === undefined || spec === undefined || fixtureSet === undefined
        ? undefined
        : beforeOrAt(spec.publishedAt, report.startedAt) &&
            beforeOrAt(fixtureSet.publishedAt, report.startedAt),
    );
  }
  return checks;
}
