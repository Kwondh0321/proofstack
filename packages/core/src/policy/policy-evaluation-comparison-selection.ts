import { createHash } from "node:crypto";
import {
  type ComparisonDefinitionReference,
  type ComparisonResult,
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  POLICY_EVALUATION_COMPARISON_SELECTION_SCHEMA_VERSION,
  type PolicyEvaluationCandidateComparisonMember,
  type PolicyEvaluationComparisonInventory,
  PolicyEvaluationComparisonInventorySchema,
  type PolicyEvaluationComparisonResolution,
  type PolicyEvaluationRequest,
  policyEvaluationTimestampOrderKey,
  type ReleaseCandidate,
  type ReleaseCandidateComparisonReference,
  ReleaseCandidateComparisonReferenceSchema,
  type ReleasePolicy,
} from "@proofstack/contracts";
import { validateComparisonRecord } from "../evaluation/comparison-record-validation.js";
import {
  releaseCandidateReference,
  validateReleaseCandidateRecord,
} from "../release/release-candidate-record-validation.js";
import {
  policyEvaluationRequestReference,
  validatePolicyEvaluationRequestRecord,
} from "./policy-evaluation-request-record-validation.js";
import {
  releasePolicyReference,
  validateReleasePolicyRecord,
} from "./release-policy-record-validation.js";

export type PolicyEvaluationComparisonSelectionErrorCode =
  | "candidate_inventory_mismatch"
  | "invalid_candidate"
  | "invalid_policy"
  | "invalid_request"
  | "policy_comparison_reference_conflict"
  | "root_not_yet_available"
  | "root_reference_mismatch"
  | "root_scope_mismatch"
  | "selection_contract_invalid";

export class PolicyEvaluationComparisonSelectionError extends Error {
  constructor(
    readonly code: PolicyEvaluationComparisonSelectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PolicyEvaluationComparisonSelectionError";
  }
}

export interface PolicyEvaluationComparisonAcquisition {
  readonly reference: ReleaseCandidateComparisonReference;
  /** null means the exact authoritative lookup established absence; repository failures are thrown. */
  readonly result: unknown | null;
}

export interface ResolvePolicyEvaluationComparisonsInput {
  readonly acquisitions: readonly PolicyEvaluationComparisonAcquisition[];
  readonly candidate: unknown;
  readonly policy: unknown;
  readonly request: unknown;
}

function exact(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function recordSha256(record: unknown): string {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(record)).digest("hex");
}

function parseRoots(input: ResolvePolicyEvaluationComparisonsInput): {
  readonly candidate: ReleaseCandidate;
  readonly policy: ReleasePolicy;
  readonly request: PolicyEvaluationRequest;
} {
  let request: PolicyEvaluationRequest;
  let candidate: ReleaseCandidate;
  let policy: ReleasePolicy;
  try {
    request = validatePolicyEvaluationRequestRecord(input.request);
  } catch (cause) {
    throw new PolicyEvaluationComparisonSelectionError(
      "invalid_request",
      "Policy evaluation comparison selection requires a valid request record",
      { cause },
    );
  }
  try {
    candidate = validateReleaseCandidateRecord(input.candidate);
  } catch (cause) {
    throw new PolicyEvaluationComparisonSelectionError(
      "invalid_candidate",
      "Policy evaluation comparison selection requires a valid candidate record",
      { cause },
    );
  }
  try {
    policy = validateReleasePolicyRecord(input.policy);
  } catch (cause) {
    throw new PolicyEvaluationComparisonSelectionError(
      "invalid_policy",
      "Policy evaluation comparison selection requires a valid policy record",
      { cause },
    );
  }
  return { candidate, policy, request };
}

function validateRootBinding(
  request: PolicyEvaluationRequest,
  candidate: ReleaseCandidate,
  policy: ReleasePolicy,
): void {
  if (
    !exact(request.candidate, releaseCandidateReference(candidate)) ||
    !exact(request.policy, releasePolicyReference(policy))
  ) {
    throw new PolicyEvaluationComparisonSelectionError(
      "root_reference_mismatch",
      "Request candidate and policy references must equal the exact authoritative roots",
    );
  }
  if (!sameScope(request.scope, candidate.scope) || !sameScope(request.scope, policy.scope)) {
    throw new PolicyEvaluationComparisonSelectionError(
      "root_scope_mismatch",
      "Request, candidate, and policy roots must have one exact scope",
    );
  }
  const evaluationTime = policyEvaluationTimestampOrderKey(request.evaluationTime);
  if (
    policyEvaluationTimestampOrderKey(candidate.createdAt) > evaluationTime ||
    policyEvaluationTimestampOrderKey(policy.publishedAt) > evaluationTime
  ) {
    throw new PolicyEvaluationComparisonSelectionError(
      "root_not_yet_available",
      "Candidate and policy roots must exist no later than the requested evaluation time",
    );
  }
}

function candidateMembers(
  candidate: ReleaseCandidate,
  request: PolicyEvaluationRequest,
  acquisitions: readonly PolicyEvaluationComparisonAcquisition[],
): PolicyEvaluationCandidateComparisonMember[] {
  const inventoryMismatch = (cause?: unknown): never => {
    throw new PolicyEvaluationComparisonSelectionError(
      "candidate_inventory_mismatch",
      "Acquisitions must preserve every candidate comparison reference exactly once in candidate order",
      cause === undefined ? undefined : { cause },
    );
  };
  if (!Array.isArray(acquisitions) || acquisitions.length !== candidate.comparisons.length) {
    inventoryMismatch();
  }
  const normalized = acquisitions.map((acquisition, index) => {
    const runtimeAcquisition: unknown = acquisition;
    if (
      typeof runtimeAcquisition !== "object" ||
      runtimeAcquisition === null ||
      !("reference" in runtimeAcquisition) ||
      !("result" in runtimeAcquisition)
    ) {
      return inventoryMismatch();
    }
    let reference: ReleaseCandidateComparisonReference;
    try {
      reference = ReleaseCandidateComparisonReferenceSchema.parse(runtimeAcquisition.reference);
    } catch (cause) {
      return inventoryMismatch(cause);
    }
    if (!exact(candidate.comparisons[index], reference)) return inventoryMismatch();
    return { reference, result: runtimeAcquisition.result };
  });
  return normalized.map(({ reference, result }) => {
    if (result === null) return { reference, observation: { status: "missing" } };
    let validated: ComparisonResult;
    try {
      validated = validateComparisonRecord("comparison_result", result) as ComparisonResult;
    } catch {
      return { reference, observation: { reason: "record_invalid", status: "unavailable" } };
    }
    if (
      validated.resultId !== reference.resultId ||
      validated.definitionSha256 !== reference.definitionSha256 ||
      !sameScope(validated.scope, request.scope)
    ) {
      return { reference, observation: { reason: "reference_mismatch", status: "unavailable" } };
    }
    const evaluationTime = policyEvaluationTimestampOrderKey(request.evaluationTime);
    if (
      policyEvaluationTimestampOrderKey(validated.createdAt) > evaluationTime ||
      policyEvaluationTimestampOrderKey(validated.latestSourceCutoff) > evaluationTime
    ) {
      return { reference, observation: { reason: "not_yet_available", status: "unavailable" } };
    }
    return {
      reference,
      observation: {
        baselineSnapshot: validated.baselineSnapshot,
        candidateSnapshot: validated.candidateSnapshot,
        comparison: validated.comparison,
        latestSourceCutoff: validated.latestSourceCutoff,
        recordSha256: recordSha256(validated),
        status: "verified",
      },
    };
  });
}

function policyComparisonReferences(policy: ReleasePolicy): ComparisonDefinitionReference[] {
  const byIdentity = new Map<string, ComparisonDefinitionReference>();
  for (const { predicate } of policy.rules) {
    if (!("comparison" in predicate)) continue;
    const previous = byIdentity.get(predicate.comparison.comparisonVersionId);
    if (previous && !exact(previous, predicate.comparison)) {
      throw new PolicyEvaluationComparisonSelectionError(
        "policy_comparison_reference_conflict",
        "One comparison repository identity cannot carry different logical IDs or digests inside a policy",
      );
    }
    byIdentity.set(predicate.comparison.comparisonVersionId, predicate.comparison);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.comparisonVersionId < right.comparisonVersionId
      ? -1
      : left.comparisonVersionId > right.comparisonVersionId
        ? 1
        : 0,
  );
}

function resolutions(
  references: readonly ComparisonDefinitionReference[],
  members: readonly PolicyEvaluationCandidateComparisonMember[],
): PolicyEvaluationComparisonResolution[] {
  const unreadable = members
    .filter(({ observation }) => observation.status !== "verified")
    .map(({ reference }) => reference);
  return references.map((comparison) => {
    const matches = members
      .filter(
        (member) =>
          member.observation.status === "verified" &&
          exact(member.observation.comparison, comparison),
      )
      .map(({ reference }) => reference);
    if (matches.length >= 2)
      return { comparison, matches, status: "ambiguous", unresolvedMembers: unreadable };
    if (unreadable.length > 0)
      return {
        comparison,
        knownMatches: matches,
        status: "unresolved",
        unresolvedMembers: unreadable,
      };
    if (matches.length === 1)
      return {
        comparison,
        result: matches[0] as ReleaseCandidateComparisonReference,
        status: "unique",
      };
    return { comparison, status: "missing" };
  });
}

/**
 * Classify exact policy-to-candidate comparison mappings only after scanning the complete candidate
 * inventory. This does not verify comparison snapshots, datasets, fixtures, targets or assessment
 * lineage and therefore cannot produce rule outcomes or a usable sealed snapshot by itself.
 */
export function resolvePolicyEvaluationComparisons(
  input: ResolvePolicyEvaluationComparisonsInput,
): PolicyEvaluationComparisonInventory {
  const { candidate, policy, request } = parseRoots(input);
  validateRootBinding(request, candidate, policy);
  const members = candidateMembers(candidate, request, input.acquisitions);
  try {
    return PolicyEvaluationComparisonInventorySchema.parse({
      candidate: releaseCandidateReference(candidate),
      members,
      policy: releasePolicyReference(policy),
      policyComparisons: resolutions(policyComparisonReferences(policy), members),
      request: policyEvaluationRequestReference(request),
      schemaVersion: POLICY_EVALUATION_COMPARISON_SELECTION_SCHEMA_VERSION,
      scope: request.scope,
    });
  } catch (cause) {
    if (cause instanceof PolicyEvaluationComparisonSelectionError) throw cause;
    throw new PolicyEvaluationComparisonSelectionError(
      "selection_contract_invalid",
      "Resolved comparison selection violated its strict contract",
      { cause },
    );
  }
}
