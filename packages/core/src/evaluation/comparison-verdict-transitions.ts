import {
  type ComparisonCase,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonEvidenceSnapshot,
  MAX_COMPARISON_SUBJECT_ASSESSMENTS,
  type ComparisonVerdictMarginal,
  ComparisonVerdictMarginalSchema,
  type ComparisonVerdictTransition,
  ComparisonVerdictTransitionSchema,
  type ComparisonVerdictTransitionUnavailableReason,
  type EvaluationVerdict,
} from "@proofstack/contracts";
import { type PairComparisonEvidenceInput, pairComparisonEvidence } from "./comparison-pairing.js";

type EvaluationOutcome = ComparisonEvidenceFixtureSnapshot["evaluationOutcomes"][number];
type CriterionReference = EvaluationOutcome["criterion"];
type VerdictCounts = EvaluationOutcome["counts"];

const verdictFields = [
  ["abstain", "abstain"],
  ["error", "error"],
  ["fail", "fail"],
  ["not_applicable", "notApplicable"],
  ["pass", "pass"],
] as const satisfies readonly (readonly [EvaluationVerdict, keyof Omit<VerdictCounts, "total">])[];
const verdictCountFields = Object.fromEntries(verdictFields) as Readonly<
  Record<EvaluationVerdict, keyof Omit<VerdictCounts, "total">>
>;

export interface ComparisonVerdictTransitionDerivation {
  readonly verdictMarginals: readonly ComparisonVerdictMarginal[];
  readonly verdictTransitions: readonly ComparisonVerdictTransition[];
}

interface ExactTransitionCount {
  readonly baseline: EvaluationVerdict;
  readonly candidate: EvaluationVerdict;
  count: bigint;
  readonly criterion: CriterionReference;
}

function exactCriterionKey(value: CriterionReference): string {
  return [
    value.criterionSet.criterionSetId,
    value.criterionSet.criterionSetVersionId,
    value.criterionSet.definitionSha256,
    value.criterionId,
  ].join(":");
}

function exactAssessmentKey(outcome: EvaluationOutcome): string {
  return `${outcome.assessment.assessmentId}:${outcome.assessment.definitionSha256}`;
}

function compareExactKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fixtureMap(
  snapshot: ComparisonEvidenceSnapshot,
): ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot> {
  return new Map(snapshot.fixtures.map((entry) => [entry.fixture.fixtureId, entry]));
}

function outcomesForCriterion(
  fixture: ComparisonEvidenceFixtureSnapshot | undefined,
  criterionKey: string,
): readonly EvaluationOutcome[] {
  return (
    fixture?.evaluationOutcomes.filter(
      (outcome) => exactCriterionKey(outcome.criterion) === criterionKey,
    ) ?? []
  );
}

function checkedCount(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the exact safe comparison count range`);
  }
  return Number(value);
}

function emptyCounts(): Record<keyof VerdictCounts, bigint> {
  return { abstain: 0n, error: 0n, fail: 0n, notApplicable: 0n, pass: 0n, total: 0n };
}

function addOutcomeCounts(
  target: Record<keyof VerdictCounts, bigint>,
  counts: VerdictCounts,
): void {
  target.abstain += BigInt(counts.abstain);
  target.error += BigInt(counts.error);
  target.fail += BigInt(counts.fail);
  target.notApplicable += BigInt(counts.notApplicable);
  target.pass += BigInt(counts.pass);
  target.total += BigInt(counts.total);
}

function marginalCounts(snapshot: ComparisonEvidenceSnapshot, criterionKey: string): VerdictCounts {
  const aggregate = emptyCounts();
  for (const fixture of snapshot.fixtures) {
    for (const outcome of outcomesForCriterion(fixture, criterionKey)) {
      addOutcomeCounts(aggregate, outcome.counts);
    }
  }
  return {
    abstain: checkedCount(aggregate.abstain, "Abstain marginal"),
    error: checkedCount(aggregate.error, "Error marginal"),
    fail: checkedCount(aggregate.fail, "Fail marginal"),
    notApplicable: checkedCount(aggregate.notApplicable, "Not-applicable marginal"),
    pass: checkedCount(aggregate.pass, "Pass marginal"),
    total: checkedCount(aggregate.total, "Verdict marginal total"),
  };
}

function nonzeroVerdicts(counts: VerdictCounts): readonly EvaluationVerdict[] {
  return verdictFields.filter(([, field]) => counts[field] > 0).map(([verdict]) => verdict);
}

function countForVerdict(counts: VerdictCounts, verdict: EvaluationVerdict): number {
  return counts[verdictCountFields[verdict]];
}

function addTransition(
  transitions: Map<string, ExactTransitionCount>,
  criterion: CriterionReference,
  baseline: EvaluationVerdict,
  candidate: EvaluationVerdict,
  count: number,
): void {
  const key = `${exactCriterionKey(criterion)}:${baseline}:${candidate}`;
  const existing = transitions.get(key);
  if (existing) {
    existing.count += BigInt(count);
    return;
  }
  transitions.set(key, { baseline, candidate, count: BigInt(count), criterion });
}

function addUniqueAggregateTransitions(
  transitions: Map<string, ExactTransitionCount>,
  criterion: CriterionReference,
  baseline: VerdictCounts,
  candidate: VerdictCounts,
): boolean {
  const baselineVerdicts = nonzeroVerdicts(baseline);
  const candidateVerdicts = nonzeroVerdicts(candidate);
  if (baseline.total === 0) return true;
  if (baselineVerdicts.length === 1) {
    const baselineVerdict = baselineVerdicts[0] as EvaluationVerdict;
    for (const candidateVerdict of candidateVerdicts) {
      addTransition(
        transitions,
        criterion,
        baselineVerdict,
        candidateVerdict,
        countForVerdict(candidate, candidateVerdict),
      );
    }
    return true;
  }
  if (candidateVerdicts.length === 1) {
    const candidateVerdict = candidateVerdicts[0] as EvaluationVerdict;
    for (const baselineVerdict of baselineVerdicts) {
      addTransition(
        transitions,
        criterion,
        baselineVerdict,
        candidateVerdict,
        countForVerdict(baseline, baselineVerdict),
      );
    }
    return true;
  }
  return false;
}

function exactAssessmentMap(
  outcomes: readonly EvaluationOutcome[],
): ReadonlyMap<string, EvaluationOutcome> {
  return new Map(outcomes.map((outcome) => [exactAssessmentKey(outcome), outcome]));
}

function sameOrderedKeys(
  baseline: ReadonlyMap<string, EvaluationOutcome>,
  candidate: ReadonlyMap<string, EvaluationOutcome>,
): boolean {
  return (
    baseline.size === candidate.size && [...baseline.keys()].every((key) => candidate.has(key))
  );
}

function invalidCaseContainsCriterion(
  comparisonCase: ComparisonCase,
  criterionKey: string,
  baselineFixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  candidateFixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
): boolean {
  if (comparisonCase.state !== "invalid") return false;
  return (
    outcomesForCriterion(baselineFixtures.get(comparisonCase.fixtureId), criterionKey).length > 0 ||
    outcomesForCriterion(candidateFixtures.get(comparisonCase.fixtureId), criterionKey).length > 0
  );
}

function deriveCriterionTransitions(
  criterion: CriterionReference,
  cases: readonly ComparisonCase[],
  baselineFixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
  candidateFixtures: ReadonlyMap<string, ComparisonEvidenceFixtureSnapshot>,
): {
  readonly pairedCount?: number;
  readonly reasons: readonly ComparisonVerdictTransitionUnavailableReason[];
  readonly transitions: readonly ComparisonVerdictTransition[];
} {
  const criterionKey = exactCriterionKey(criterion);
  const reasons = new Set<ComparisonVerdictTransitionUnavailableReason>();
  const transitions = new Map<string, ExactTransitionCount>();
  let pairedCount = 0n;
  let pairedFixtureCount = 0;

  for (const comparisonCase of cases) {
    if (
      invalidCaseContainsCriterion(
        comparisonCase,
        criterionKey,
        baselineFixtures,
        candidateFixtures,
      )
    ) {
      reasons.add("invalid_paired_evidence");
    }
    if (comparisonCase.state !== "paired") continue;
    pairedFixtureCount += 1;
    const baselineOutcomes = outcomesForCriterion(
      baselineFixtures.get(comparisonCase.fixtureId),
      criterionKey,
    );
    const candidateOutcomes = outcomesForCriterion(
      candidateFixtures.get(comparisonCase.fixtureId),
      criterionKey,
    );
    if (baselineOutcomes.length === 0 || candidateOutcomes.length === 0) {
      reasons.add("missing_paired_evidence");
      continue;
    }
    const baselineByAssessment = exactAssessmentMap(baselineOutcomes);
    const candidateByAssessment = exactAssessmentMap(candidateOutcomes);
    if (!sameOrderedKeys(baselineByAssessment, candidateByAssessment)) {
      reasons.add("assessment_mismatch");
      continue;
    }
    for (const [assessmentKey, baselineOutcome] of baselineByAssessment) {
      const candidateOutcome = candidateByAssessment.get(assessmentKey) as EvaluationOutcome;
      if (baselineOutcome.counts.total !== candidateOutcome.counts.total) {
        reasons.add("outcome_count_mismatch");
        continue;
      }
      if (
        !addUniqueAggregateTransitions(
          transitions,
          criterion,
          baselineOutcome.counts,
          candidateOutcome.counts,
        )
      ) {
        reasons.add("ambiguous_aggregate_pairing");
        continue;
      }
      pairedCount += BigInt(baselineOutcome.counts.total);
    }
  }

  if (pairedFixtureCount === 0) reasons.add("missing_paired_evidence");
  if (reasons.size > 0) {
    return { reasons: [...reasons].sort(), transitions: [] };
  }
  return {
    pairedCount: checkedCount(pairedCount, "Paired verdict transition total"),
    reasons: [],
    transitions: [...transitions]
      .sort(([left], [right]) => compareExactKeys(left, right))
      .map(([, value]) =>
        ComparisonVerdictTransitionSchema.parse({
          baseline: value.baseline,
          candidate: value.candidate,
          count: checkedCount(value.count, "Verdict transition count"),
          criterion: value.criterion,
        }),
      ),
  };
}

/**
 * Derives complete observed verdict marginals and only mathematically unique paired transitions.
 * Aggregate evidence that admits more than one transition matrix remains explicitly unavailable.
 */
export function deriveComparisonVerdictTransitions(
  input: PairComparisonEvidenceInput,
): ComparisonVerdictTransitionDerivation {
  const pairing = pairComparisonEvidence(input);
  const baselineFixtures = fixtureMap(input.baseline);
  const candidateFixtures = fixtureMap(input.candidate);
  const criteria = new Map<string, CriterionReference>();
  for (const snapshot of [input.baseline, input.candidate]) {
    for (const fixture of snapshot.fixtures) {
      for (const outcome of fixture.evaluationOutcomes) {
        criteria.set(exactCriterionKey(outcome.criterion), outcome.criterion);
      }
    }
  }
  if (criteria.size > MAX_COMPARISON_SUBJECT_ASSESSMENTS) {
    throw new RangeError(
      `Verdict criteria exceed the ${MAX_COMPARISON_SUBJECT_ASSESSMENTS}-criterion result bound`,
    );
  }

  const verdictMarginals: ComparisonVerdictMarginal[] = [];
  const verdictTransitions: ComparisonVerdictTransition[] = [];
  for (const [criterionKey, criterion] of [...criteria].sort(([left], [right]) =>
    compareExactKeys(left, right),
  )) {
    const derivation = deriveCriterionTransitions(
      criterion,
      pairing.cases,
      baselineFixtures,
      candidateFixtures,
    );
    verdictTransitions.push(...derivation.transitions);
    verdictMarginals.push(
      ComparisonVerdictMarginalSchema.parse({
        baseline: marginalCounts(input.baseline, criterionKey),
        candidate: marginalCounts(input.candidate, criterionKey),
        criterion,
        transition:
          derivation.pairedCount === undefined
            ? { reasons: derivation.reasons, status: "unavailable" }
            : { pairedCount: derivation.pairedCount, status: "available" },
      }),
    );
  }

  return { verdictMarginals, verdictTransitions };
}
