import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  PolicyEvaluationDefinitionSchema,
  PolicyEvaluationRuleResultSchema,
  policyEvaluationSourceReferenceKey,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type PolicyEvaluationDefinition,
  type PolicyEvaluationRuleResult,
  type PolicyEvaluationSnapshotPageSet,
  type ReleasePolicyApplicability,
} from "@proofstack/contracts";
import { validatePolicyEvaluationSnapshotRecord } from "./policy-evaluation-snapshot-record-validation.js";
import { PolicyEvaluationSnapshotIntegrityError } from "./policy-evaluation-snapshot.js";
import { evaluatePolicyPredicateProjection } from "./evaluate-policy-predicate-projection.js";
import { releaseCandidateSourceReferences } from "../release/release-candidate-source-references.js";

function applicabilityCondition(
  selector: ReleasePolicyApplicability[keyof ReleasePolicyApplicability],
  target: string | string[] | null,
): { status: "match" | "mismatch" | "unknown"; reason: string } {
  switch (selector.operator) {
    case "any":
      return { status: "match", reason: "any" };
    case "absent":
      return target === null
        ? { status: "match", reason: "optional_absent" }
        : { status: "mismatch", reason: "optional_present" };
    case "equals":
    case "one_of":
      if (target === null) return { status: "unknown", reason: "value_missing" };
      if (typeof target !== "string")
        throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
      if (selector.operator === "equals")
        return target === selector.value
          ? { status: "match", reason: "equal" }
          : { status: "mismatch", reason: "not_equal" };
      return (selector.values as readonly string[]).includes(target)
        ? { status: "match", reason: "member" }
        : { status: "mismatch", reason: "not_member" };
    case "contains_all":
    case "exactly":
      if (!Array.isArray(target))
        throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
      if (selector.operator === "contains_all")
        return selector.values.every((item) => target.includes(item))
          ? { status: "match", reason: "contains_all" }
          : { status: "mismatch", reason: "missing_population" };
      return serializeEvaluationCanonicalJson(target) ===
        serializeEvaluationCanonicalJson(selector.values)
        ? { status: "match", reason: "exact_set" }
        : { status: "mismatch", reason: "different_set" };
  }
}

/**
 * Pure historical computation. Expected identity comes from the authoritative owning job.
 * This validates sealed witnesses/projections, not absent original bodies or fresh authority.
 * Native result publication must independently retain its live worker fence and atomic state.
 */
interface SealedPolicyComputationInput {
  readonly evaluationId: string;
  readonly expected: Parameters<typeof validatePolicyEvaluationSnapshotRecord>[0]["expected"];
  readonly record: unknown;
  readonly pageSet: PolicyEvaluationSnapshotPageSet;
}

export function computeSealedPolicyEvaluation(
  input: SealedPolicyComputationInput,
): PolicyEvaluationDefinition {
  return prepareSealedPolicyEvaluation(input).compute();
}

/** Own one validated historical view so prepaid admission need not decode it a second time. */
export function prepareSealedPolicyEvaluation(input: SealedPolicyComputationInput) {
  const owned = {
    evaluationId: input.evaluationId,
    expected: {
      ...input.expected,
      scope: { ...input.expected.scope },
      request: { ...input.expected.request },
      snapshot: { ...input.expected.snapshot },
    },
  };
  const { inputs } = validatePolicyEvaluationSnapshotRecord({
    expected: owned.expected,
    record: input.record,
    pageSet: input.pageSet,
  });
  if (inputs.schemaVersion !== "0.2")
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  return Object.freeze({
    ruleCount: inputs.rules.ruleCount,
    compute: () => computeCapturedPolicyEvaluation(owned, inputs),
  });
}

function same(left: unknown, right: unknown): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right)
  );
}

export interface ValidatedPolicyPrerequisites {
  readonly originalPolicyState:
    | "active"
    | "not_effective"
    | "expired"
    | "withdrawn"
    | "superseded"
    | "authority_unavailable";
  readonly candidateAuthority: "qualified" | "unavailable";
  readonly applicability: "match" | "mismatch" | "unknown";
}

/** Historical facts only. Call after owning snapshot validation; this grants no fresh authority. */
export function inspectValidatedPolicyPrerequisites(
  inputs: Extract<
    ReturnType<typeof validatePolicyEvaluationSnapshotRecord>["inputs"],
    { schemaVersion: "0.2" }
  >,
): ValidatedPolicyPrerequisites {
  const authorityMaterial = (authority: typeof inputs.candidateAuthority.afterArtifacts) => {
    if (authority.status !== "observed") return serializeEvaluationCanonicalJson(authority);
    const { startedAt: _start, completedAt: _end, ...material } = authority;
    return serializeEvaluationCanonicalJson(material);
  };
  if (
    authorityMaterial(inputs.candidateAuthority.beforeArtifacts) !==
      authorityMaterial(inputs.candidateAuthority.afterArtifacts) ||
    inputs.applicability.lifecycle.observationSha256 !==
      inputs.policyLifecycle.afterArtifacts.observationSha256 ||
    inputs.policyLifecycle.beforeArtifacts.observationSha256 !==
      inputs.policyLifecycle.afterArtifacts.observationSha256
  )
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  const records = inputs.sources.records.records;
  const roots = inputs.closure.rootContext;
  for (const dimension of inputs.applicability.dimensions) {
    const selector = inputs.roots.policy.applicability[dimension.field];
    const target = inputs.roots.candidate.target[dimension.field] ?? null;
    if (
      serializeEvaluationCanonicalJson(selector) !==
        serializeEvaluationCanonicalJson(dimension.selector) ||
      serializeEvaluationCanonicalJson(target) !==
        serializeEvaluationCanonicalJson(dimension.targetValue)
    )
      throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
    if (dimension.status !== "not_evaluated") {
      const expected = applicabilityCondition(selector, target);
      if (dimension.status !== expected.status || dimension.reason !== expected.reason)
        throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
    }
  }
  const authority = inputs.candidateAuthority.afterArtifacts;
  const candidateSource = {
    kind: "release_candidate" as const,
    reference: inputs.request.candidate,
  };
  const candidateKey = policyEvaluationSourceReferenceKey(candidateSource);
  const candidateWitness = records.find(
    (record) => policyEvaluationSourceReferenceKey(record.entry.source) === candidateKey,
  );
  const policySource = {
    kind: "release_policy" as const,
    reference: inputs.request.policy,
  };
  const policyKey = policyEvaluationSourceReferenceKey(policySource);
  const policyWitness = records.find(
    (record) => policyEvaluationSourceReferenceKey(record.entry.source) === policyKey,
  );
  if (
    !same(candidateWitness?.entry.source, candidateSource) ||
    !same(policyWitness?.entry.source, policySource)
  )
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  for (const witness of [inputs.applicability.candidate, inputs.rules.candidate])
    if (
      !same(witness.source, candidateSource) ||
      witness.recordSha256 !== candidateWitness?.storage?.recordSha256
    )
      throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  for (const witness of [inputs.applicability.policy, inputs.rules.policy, inputs.policyAuthority])
    if (
      !same(witness.source, policySource) ||
      witness.recordSha256 !== policyWitness?.storage?.recordSha256
    )
      throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  for (const lifecycle of [
    inputs.applicability.lifecycle,
    ...Object.values(inputs.policyLifecycle),
  ]) {
    if (
      serializeEvaluationCanonicalJson(lifecycle.policy) !==
        serializeEvaluationCanonicalJson(inputs.request.policy) ||
      lifecycle.policyRecordSha256 !== policyWitness?.storage?.recordSha256
    )
      throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
    const {
      startedAt: _start,
      completedAt: _end,
      state: _state,
      observationSha256: _digest,
      ...material
    } = lifecycle;
    if (
      createHash("sha256")
        .update(
          encodeEvaluationCanonicalJson({
            format: "proofstack.policy-lifecycle-observation.v1",
            ...material,
          }),
        )
        .digest("hex") !== lifecycle.observationSha256
    )
      throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  }
  const {
    scope: _scope,
    schemaVersion: _version,
    definitionSha256: _hash,
    createdAt: _at,
    createdByPrincipalId: _by,
    ...candidateDefinition
  } = inputs.roots.candidate;
  const candidateSubjects = releaseCandidateSourceReferences(candidateDefinition).filter(
    (subject) =>
      subject.kind === "source_revision" ||
      subject.kind === "model_declaration" ||
      subject.kind === "runtime_adapter",
  );
  const rootOccurrences =
    authority.status === "observed"
      ? authority.occurrences.filter(
          (occurrence) => policyEvaluationSourceReferenceKey(occurrence.parent) === candidateKey,
        )
      : [];
  if (rootOccurrences.some((occurrence) => !same(occurrence.parent, candidateSource)))
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  const candidateQualified =
    authority.status === "observed" &&
    authority.unavailableParents.length === 0 &&
    authority.occurrences.every((occurrence) => occurrence.availability === "available") &&
    rootOccurrences.length === candidateSubjects.length &&
    candidateSubjects.every((subject) => {
      const index =
        subject.kind === "source_revision"
          ? -1
          : inputs.roots.candidate.runtimeComponents.findIndex(
              (component) => component.kind === "model" && component.role === subject.role,
            );
      const path =
        subject.kind === "source_revision"
          ? "/source"
          : `/runtimeComponents/${index}${subject.kind === "runtime_adapter" ? "/adapter" : ""}`;
      return rootOccurrences.some(
        (occurrence) =>
          occurrence.path === path &&
          occurrence.parentRecordSha256 === candidateWitness?.storage?.recordSha256 &&
          serializeEvaluationCanonicalJson(occurrence.subject) ===
            serializeEvaluationCanonicalJson(subject),
      );
    });
  const cut = policyEvaluationTimestampOrderKey(inputs.request.evaluationTime);
  let originalPolicyState: ValidatedPolicyPrerequisites["originalPolicyState"] = "active";
  if (cut < policyEvaluationTimestampOrderKey(inputs.roots.policy.effectiveAt))
    originalPolicyState = "not_effective";
  else if (cut >= policyEvaluationTimestampOrderKey(inputs.roots.policy.expiresAt))
    originalPolicyState = "expired";
  else if (inputs.policyLifecycle.afterArtifacts.state === "withdrawn_at_evaluation")
    originalPolicyState = "withdrawn";
  else if (inputs.policyLifecycle.afterArtifacts.state === "superseded_at_evaluation")
    originalPolicyState = "superseded";
  else if (inputs.policyAuthority.requirements.status !== "valid") {
    const findings = inputs.policyAuthority.requirements.findings;
    originalPolicyState = findings.some(
      (finding) => finding.reason === "policy_expired_at_evaluation",
    )
      ? "expired"
      : findings.some((finding) => finding.reason === "policy_not_effective_at_evaluation")
        ? "not_effective"
        : "authority_unavailable";
  }
  return Object.freeze({
    originalPolicyState,
    candidateAuthority: candidateQualified ? "qualified" : "unavailable",
    applicability:
      inputs.applicability.conjunction === "not_evaluated"
        ? "unknown"
        : inputs.applicability.conjunction,
  });
}

function computeCapturedPolicyEvaluation(
  input: Pick<SealedPolicyComputationInput, "evaluationId" | "expected">,
  inputs: Extract<
    ReturnType<typeof validatePolicyEvaluationSnapshotRecord>["inputs"],
    { schemaVersion: "0.2" }
  >,
): PolicyEvaluationDefinition {
  const prerequisites = inspectValidatedPolicyPrerequisites(inputs);
  const candidateQualified = prerequisites.candidateAuthority === "qualified";
  const records = inputs.sources.records.records;
  const roots = inputs.closure.rootContext;
  const unavailable = (
    frame: (typeof inputs.rules.rules)[number],
    reason: Extract<PolicyEvaluationRuleResult["evidence"], { kind: "not_evaluated" }>["reason"],
  ) =>
    PolicyEvaluationRuleResultSchema.parse({
      ruleIndex: frame.ruleIndex,
      ruleId: frame.rule.ruleId,
      predicateKind: frame.rule.predicate.kind,
      outcome: "indeterminate",
      evidence: { kind: "not_evaluated", reason },
      limitations: ["historical_observation_only"],
    });
  const rules = inputs.rules.rules
    .map((frame): PolicyEvaluationRuleResult => {
      // This checkpoint always retains the approval prerequisite, including applicability mismatch.
      if (frame.rule.predicate.kind === "approval_required")
        return evaluatePolicyPredicateProjection(frame);
      if (prerequisites.originalPolicyState !== "active") {
        const reasons = {
          not_effective: "policy_not_effective",
          expired: "policy_expired",
          withdrawn: "policy_withdrawn",
          superseded: "policy_superseded",
          authority_unavailable: "policy_authority_unverified",
        } as const;
        return unavailable(frame, reasons[prerequisites.originalPolicyState]);
      }
      if (!candidateQualified) return unavailable(frame, "candidate_authority_unverified");
      if (inputs.applicability.conjunction === "mismatch")
        return PolicyEvaluationRuleResultSchema.parse({
          ruleIndex: frame.ruleIndex,
          ruleId: frame.rule.ruleId,
          predicateKind: frame.rule.predicate.kind,
          outcome: "not_applicable",
          evidence: { kind: "applicability_mismatch" },
          limitations: ["historical_observation_only"],
        });
      if (inputs.applicability.conjunction !== "match")
        return unavailable(frame, "required_selector_unknown");
      const coordinates = inputs.closure.rules[frame.ruleIndex];
      if (!coordinates || coordinates.ruleId !== frame.rule.ruleId)
        throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
      const required = new Set(
        [...roots.sourceIndexes, ...coordinates.sourceIndexes].map((index) => {
          const witness = records[index];
          if (!witness) throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
          return policyEvaluationSourceReferenceKey(witness.entry.source);
        }),
      );
      const frontierIndexes = [...roots.frontierEdgeIndexes, ...coordinates.frontierEdgeIndexes];
      if (
        inputs.sources.semanticFrontier.some(
          (frontier) =>
            frontierIndexes.includes(frontier.edgeIndex) &&
            frontier.kind === "unresolved_selector" &&
            frontier.target === null,
        )
      )
        return unavailable(frame, "required_selector_unknown");
      const checks = [...roots.checkIndexes, ...coordinates.checkIndexes].map((index) => {
        const check = inputs.closure.checks[index];
        if (!check) throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
        return check;
      });
      if (checks.some((check) => check.status === "mismatch"))
        return unavailable(frame, "evidence_unqualified");
      if (checks.some((check) => check.status === "unavailable"))
        return unavailable(frame, "source_unavailable");
      const criterion = inputs.criterionAuthority.underGuards;
      const criterionParents = records.filter(
        (record) =>
          required.has(policyEvaluationSourceReferenceKey(record.entry.source)) &&
          ["assessment", "evaluation_run", "evaluation_run_rejection"].includes(
            record.entry.source.kind,
          ) &&
          record.entry.observation.status === "verified",
      );
      if (
        criterionParents.length > 0 &&
        (criterion?.status !== "observed" ||
          criterionParents.some(
            (parent) =>
              !criterion.selections.some(
                (selection) =>
                  same(selection.parent, parent.entry.source) &&
                  selection.parentRecordSha256 === parent.storage?.recordSha256 &&
                  selection.atEvaluation === "approved_head",
              ),
          ))
      )
        return unavailable(frame, "criterion_authority_unverified");
      const trustParents = records.filter(
        (record) =>
          record.entry.source.kind === "evaluation_run" &&
          required.has(policyEvaluationSourceReferenceKey(record.entry.source)) &&
          record.entry.observation.status === "verified",
      );
      if (
        trustParents.some(
          (parent) =>
            !inputs.evaluationTrust.parents.some(
              (observation) =>
                same(observation.source, parent.entry.source) &&
                observation.recordSha256 === parent.storage?.recordSha256,
            ),
        ) ||
        inputs.evaluationTrust.unavailableParents.some((parent) =>
          required.has(policyEvaluationSourceReferenceKey(parent.source)),
        ) ||
        inputs.evaluationTrust.parents.some(
          (occurrence) =>
            required.has(policyEvaluationSourceReferenceKey(occurrence.source)) &&
            (occurrence.observation.status !== "inspected" ||
              occurrence.observation.requirements.status !== "eligible"),
        )
      )
        return unavailable(frame, "evidence_unqualified");
      return evaluatePolicyPredicateProjection(frame);
    })
    .map((rule) =>
      PolicyEvaluationRuleResultSchema.parse({
        ...rule,
        limitations: [
          ...new Set([...rule.limitations, "declared_reference_authority_only"]),
        ].sort(),
      }),
    );
  const outcomeCounts = { satisfied: 0, violated: 0, indeterminate: 0, not_applicable: 0 };
  for (const rule of rules) outcomeCounts[rule.outcome]++;
  return PolicyEvaluationDefinitionSchema.parse({
    evaluationId: input.evaluationId,
    request: input.expected.request,
    snapshot: input.expected.snapshot,
    candidate: inputs.request.candidate,
    policy: inputs.request.policy,
    algorithm: inputs.request.algorithm,
    evaluationTime: inputs.request.evaluationTime,
    ruleCount: rules.length,
    rules,
    outcomeCounts,
  });
}
