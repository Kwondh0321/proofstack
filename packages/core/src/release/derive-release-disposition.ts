import {
  ReleaseDecisionInputDefinitionSchema,
  ReleaseDecisionPolicyFindingSchema,
  ReleaseDecisionSelectionStateSchema,
  type ReleaseDecisionDisposition,
  type ReleaseDecisionInputDefinition,
  type ReleaseDecisionPolicyFinding,
} from "@proofstack/contracts";

export class InvalidReleaseDecisionInventoryError extends Error {
  readonly code = "release_decision_inventory_invalid";
  constructor(options?: ErrorOptions) {
    super("Decision requires the complete exact original policy/request inventory", options);
    this.name = "InvalidReleaseDecisionInventoryError";
  }
}

/** Internal aggregation only; no source lookup, authority resolution, clock or publication. */
export function deriveReleaseDisposition(input: {
  readonly request: ReleaseDecisionInputDefinition;
  readonly selectionState:
    | "current"
    | "unavailable"
    | "not_effective"
    | "expired"
    | "withdrawn"
    | "superseded"
    | "conflicting";
  readonly policies: readonly ReleaseDecisionPolicyFinding[];
}): ReleaseDecisionDisposition {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).length !== 3 ||
      !["request", "selectionState", "policies"].every((key) => Object.hasOwn(input, key))
    )
      throw new InvalidReleaseDecisionInventoryError();
    const request = ReleaseDecisionInputDefinitionSchema.parse(input.request);
    const state = ReleaseDecisionSelectionStateSchema.parse(input.selectionState);
    if (!Array.isArray(input.policies) || input.policies.length !== request.evaluations.length)
      throw new InvalidReleaseDecisionInventoryError();
    const policies = input.policies.map((policy) =>
      ReleaseDecisionPolicyFindingSchema.parse(policy),
    );
    for (const [index, policy] of policies.entries()) {
      const planned = request.evaluations[index];
      if (
        !planned ||
        policy.mode !== planned.mode ||
        policy.policy.policyId !== planned.request.policy.policyId ||
        policy.policy.policyVersionId !== planned.request.policy.policyVersionId ||
        policy.policy.definitionSha256 !== planned.request.policy.definitionSha256 ||
        policy.request.evaluationRequestId !== planned.request.evaluationRequestId ||
        policy.request.definitionSha256 !== planned.requestSha256
      )
        throw new InvalidReleaseDecisionInventoryError();
    }
    for (const ids of [
      policies.flatMap((policy) => (policy.job ? [policy.job.jobId] : [])),
      policies.flatMap((policy) => (policy.snapshot ? [policy.snapshot.snapshotId] : [])),
      policies.flatMap((policy) =>
        policy.state === "evaluated" ? [policy.evaluation.evaluationId] : [],
      ),
    ])
      if (new Set(ids).size !== ids.length) throw new InvalidReleaseDecisionInventoryError();
    const supports = policies.flatMap((policy) =>
      policy.state === "evaluated"
        ? policy.rules.flatMap(({ supportingApprovals }) => supportingApprovals)
        : [],
    );
    if (
      supports.length > request.verificationLimits.maxApprovalRecords ||
      new Set(supports.map(({ approvalId }) => approvalId)).size !== supports.length
    )
      throw new InvalidReleaseDecisionInventoryError();
    if (state !== "current") return "hold";
    if (request.mode === "observation_only") return "advisory";
    const mandatory = policies.filter(({ mode }) => mode === "mandatory");
    if (
      mandatory.some(
        (policy) =>
          policy.state === "evaluated" &&
          policy.rules.some(({ status }) => status === "non_waivable_violation"),
      )
    )
      return "reject";
    if (
      mandatory.some(
        (policy) =>
          policy.state === "unavailable" ||
          policy.rules.some(({ status }) => status === "unresolved"),
      )
    )
      return "hold";
    return "proceed";
  } catch (cause) {
    if (cause instanceof InvalidReleaseDecisionInventoryError) throw cause;
    throw new InvalidReleaseDecisionInventoryError({ cause });
  }
}
