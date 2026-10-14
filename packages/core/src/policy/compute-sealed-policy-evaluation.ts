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
export function computeSealedPolicyEvaluation(input: {
  readonly evaluationId: string;
  readonly expected: Parameters<typeof validatePolicyEvaluationSnapshotRecord>[0]["expected"];
  readonly record: unknown;
  readonly pageSet: PolicyEvaluationSnapshotPageSet;
}): PolicyEvaluationDefinition {
  const { inputs } = validatePolicyEvaluationSnapshotRecord({
    expected: input.expected,
    record: input.record,
    pageSet: input.pageSet,
  });
  if (inputs.schemaVersion !== "0.2")
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
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
  const candidateKey = policyEvaluationSourceReferenceKey({
    kind: "release_candidate",
    reference: inputs.request.candidate,
  });
  const candidateWitness = records.find(
    (record) => policyEvaluationSourceReferenceKey(record.entry.source) === candidateKey,
  );
  const policyKey = policyEvaluationSourceReferenceKey({
    kind: "release_policy",
    reference: inputs.request.policy,
  });
  const policyWitness = records.find(
    (record) => policyEvaluationSourceReferenceKey(record.entry.source) === policyKey,
  );
  for (const witness of [inputs.applicability.candidate, inputs.rules.candidate])
    if (
      policyEvaluationSourceReferenceKey(witness.source) !== candidateKey ||
      witness.recordSha256 !== candidateWitness?.storage?.recordSha256
    )
      throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs");
  for (const witness of [inputs.applicability.policy, inputs.rules.policy, inputs.policyAuthority])
    if (
      policyEvaluationSourceReferenceKey(witness.source) !== policyKey ||
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
      const cut = policyEvaluationTimestampOrderKey(inputs.request.evaluationTime);
      if (cut < policyEvaluationTimestampOrderKey(inputs.roots.policy.effectiveAt))
        return unavailable(frame, "policy_not_effective");
      if (cut >= policyEvaluationTimestampOrderKey(inputs.roots.policy.expiresAt))
        return unavailable(frame, "policy_expired");
      const lifecycle = inputs.policyLifecycle.afterArtifacts;
      if (lifecycle.state === "withdrawn_at_evaluation")
        return unavailable(frame, "policy_withdrawn");
      if (lifecycle.state === "superseded_at_evaluation")
        return unavailable(frame, "policy_superseded");
      if (inputs.policyAuthority.requirements.status !== "valid") {
        const findings = inputs.policyAuthority.requirements.findings;
        return unavailable(
          frame,
          findings.some((finding) => finding.reason === "policy_expired_at_evaluation")
            ? "policy_expired"
            : findings.some((finding) => finding.reason === "policy_not_effective_at_evaluation")
              ? "policy_not_effective"
              : "policy_authority_unverified",
        );
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
                  policyEvaluationSourceReferenceKey(selection.parent) ===
                    policyEvaluationSourceReferenceKey(parent.entry.source) &&
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
                policyEvaluationSourceReferenceKey(observation.source) ===
                  policyEvaluationSourceReferenceKey(parent.entry.source) &&
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
