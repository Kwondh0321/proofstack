import type {
  PolicyEvaluationSourceReference,
  PolicyInstallationBinding,
  ReleaseCandidate,
  ReleasePolicy,
} from "@proofstack/contracts";
import { validateComparisonRecord } from "../evaluation/comparison-record-validation.js";
import type {
  ComparisonRecord,
  ComparisonRepository,
} from "../evaluation/comparison-repository.js";
import { InvalidComparisonRecordInputError } from "../evaluation/comparison-repository-errors.js";
import { InvalidReleaseCandidateRecordInputError } from "../release/release-candidate-errors.js";
import { validateReleaseCandidateRecord } from "../release/release-candidate-record-validation.js";
import type { ReleaseCandidateRepository } from "../release/release-candidate-repository.js";
import {
  inspectPolicyEvaluationDefinitionRecord,
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
  type PolicyEvaluationDefinitionValidator,
  readPolicyEvaluationDefinitionRecord,
} from "./policy-evaluation-definition-reader.js";
import type { PolicyInstallationBindingResolver } from "./release-policy-authority-resolver.js";
import {
  InvalidPolicyInstallationBindingInputError,
  InvalidReleasePolicyRecordInputError,
} from "./release-policy-errors.js";
import {
  validatePolicyInstallationBindingRecord,
  validateReleasePolicyRecord,
} from "./release-policy-record-validation.js";
import type { ReleasePolicyRepository } from "./release-policy-repository.js";

export type PolicyEvaluationControlSource = Extract<
  PolicyEvaluationSourceReference,
  {
    kind:
      | "comparison_definition"
      | "comparison_snapshot"
      | "comparison_result"
      | "release_candidate"
      | "release_policy"
      | "policy_installation_binding";
  }
>;
export type PolicyEvaluationControlRecord =
  | ComparisonRecord
  | ReleaseCandidate
  | ReleasePolicy
  | PolicyInstallationBinding;
export type PolicyEvaluationControlRead = PolicyEvaluationDefinitionRead<
  PolicyEvaluationControlRecord,
  PolicyEvaluationControlSource
>;

export interface PolicyEvaluationControlReaderDependencies {
  readonly comparison: Pick<
    ComparisonRepository,
    "findComparisonDefinition" | "findComparisonEvidenceSnapshot" | "findComparisonResult"
  >;
  readonly releaseCandidate: Pick<ReleaseCandidateRepository, "findReleaseCandidate">;
  readonly releasePolicy: Pick<ReleasePolicyRepository, "findReleasePolicy">;
  /** Existing operator-owned exact-version authority; never requester-provided binding data. */
  readonly installationBinding: PolicyInstallationBindingResolver;
}

const validator: PolicyEvaluationDefinitionValidator<
  PolicyEvaluationControlSource,
  PolicyEvaluationControlRecord
> = {
  kinds: [
    "comparison_definition",
    "comparison_snapshot",
    "comparison_result",
    "release_candidate",
    "release_policy",
    "policy_installation_binding",
  ],
  isInvalidRecordError: (cause) =>
    cause instanceof InvalidComparisonRecordInputError ||
    cause instanceof InvalidReleaseCandidateRecordInputError ||
    cause instanceof InvalidReleasePolicyRecordInputError ||
    cause instanceof InvalidPolicyInstallationBindingInputError,
  receiptTime: (record) =>
    "publishedAt" in record
      ? record.publishedAt
      : "registeredAt" in record
        ? record.registeredAt
        : record.createdAt,
  validate: (source, raw) => {
    let record: PolicyEvaluationControlRecord;
    switch (source.kind) {
      case "comparison_definition":
        record = validateComparisonRecord("comparison_definition", raw);
        break;
      case "comparison_snapshot":
        record = validateComparisonRecord("comparison_evidence_snapshot", raw);
        break;
      case "comparison_result":
        record = validateComparisonRecord("comparison_result", raw);
        break;
      case "release_candidate":
        record = validateReleaseCandidateRecord(raw);
        break;
      case "release_policy":
        record = validateReleasePolicyRecord(raw);
        break;
      case "policy_installation_binding":
        record = validatePolicyInstallationBindingRecord(raw);
        break;
    }
    // Domain validation precedes transport normalization. Unknown fields and invalid values must
    // never disappear into JSON; only strictly admitted optional undefined fields are omitted.
    return JSON.parse(JSON.stringify(record)) as PolicyEvaluationControlRecord;
  },
};

/** Reinspection only; cannot establish acquisition provenance, lifecycle authority, or eligibility. */
export function inspectPolicyEvaluationControlRecord(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationControlSource>,
  raw: unknown,
): PolicyEvaluationControlRead {
  return inspectPolicyEvaluationDefinitionRecord<
    PolicyEvaluationControlSource,
    PolicyEvaluationControlRecord
  >(input, raw, validator);
}

/**
 * Acquires one exact comparison/control record from previously authorized read-only authority.
 * A verified record is not a re-derived comparison, current policy/installation authority, a
 * complete dependency graph, approval, or a sealed evaluation snapshot.
 */
export function readPolicyEvaluationControlRecord(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationControlSource>,
  dependencies: PolicyEvaluationControlReaderDependencies,
): Promise<PolicyEvaluationControlRead> {
  return readPolicyEvaluationDefinitionRecord<
    PolicyEvaluationControlSource,
    PolicyEvaluationControlRecord
  >(input, {
    ...validator,
    read: (scope, source) => {
      switch (source.kind) {
        case "comparison_definition":
          return dependencies.comparison.findComparisonDefinition(
            scope,
            source.reference.comparisonVersionId,
          );
        case "comparison_snapshot":
          return dependencies.comparison.findComparisonEvidenceSnapshot(
            scope,
            source.reference.snapshotId,
          );
        case "comparison_result":
          return dependencies.comparison.findComparisonResult(scope, source.reference.resultId);
        case "release_candidate":
          return dependencies.releaseCandidate.findReleaseCandidate(
            scope,
            source.reference.candidateVersionId,
          );
        case "release_policy":
          return dependencies.releasePolicy.findReleasePolicy(
            scope,
            source.reference.policyVersionId,
          );
        case "policy_installation_binding":
          return dependencies.installationBinding.resolve({ scope, reference: source.reference });
      }
    },
  });
}
