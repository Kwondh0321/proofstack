import { createHash } from "node:crypto";
import {
  encodePolicyEvaluationRequestDefinition,
  encodeReleaseDecisionInputDefinition,
  encodeReleasePolicySelectionDefinition,
  type EvidenceScope,
  type ReleaseDecisionInput,
  type ReleaseDecisionInputDefinition,
  ReleaseDecisionInputSchema,
  ReleasePolicySelectionSchema,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import { hashEvaluationCanonicalJson } from "../evaluation/canonical-json-hash.js";
import { validateReleasePolicyRecord } from "../policy/release-policy-record-validation.js";
import { validateReleaseCandidateRecord } from "./release-candidate-record-validation.js";

export class InvalidReleaseDecisionInputError extends Error {
  readonly code = "release_decision_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidReleaseDecisionInputError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestReleaseDecisionInputDefinition(
  scope: EvidenceScope,
  definition: ReleaseDecisionInputDefinition,
): string {
  return digest(encodeReleaseDecisionInputDefinition({ scope, definition }));
}

function requireBinding(condition: boolean, message: string): asserts condition {
  if (!condition) throw new InvalidReleaseDecisionInputError(message);
}

function equal(left: unknown, right: unknown): boolean {
  return hashEvaluationCanonicalJson(left) === hashEvaluationCanonicalJson(right);
}

/** Immutable integrity only. No lifecycle/session lookup, request reservation or publication. */
export function validateReleaseDecisionInputBindings(input: {
  readonly request: unknown;
  readonly selection: unknown;
  readonly candidate: unknown;
  readonly policies: readonly unknown[];
}): ReleaseDecisionInput {
  try {
    const request = ReleaseDecisionInputSchema.parse(input.request);
    const { definitionSha256, schemaVersion: _inputVersion, ...definition } = request;
    requireBinding(
      digestReleaseDecisionInputDefinition(request.scope, definition) === definitionSha256,
      "Invalid input definition digest",
    );
    const selection = ReleasePolicySelectionSchema.parse(input.selection);
    const {
      definitionSha256: selectionSha256,
      publishedAt,
      publishedByPrincipalId: _selectionPublisher,
      schemaVersion: _selectionVersion,
      ...selectionDefinition
    } = selection;
    requireBinding(
      digest(
        encodeReleasePolicySelectionDefinition({
          scope: selection.scope,
          definition: selectionDefinition,
        }),
      ) === selectionSha256,
      "Invalid selection definition digest",
    );
    requireBinding(
      equal(request.scope, selection.scope) &&
        equal(request.selection, {
          selectionId: selection.selectionId,
          selectionVersionId: selection.selectionVersionId,
          installationId: selection.installationId,
          gateTargetId: selection.gateTargetId,
          definitionSha256: selectionSha256,
        }) &&
        request.mode === selection.mode,
      "Input must bind the exact complete selection and scope",
    );
    const at = policyEvaluationTimestampOrderKey(request.createdAt);
    requireBinding(
      policyEvaluationTimestampOrderKey(publishedAt) <= at &&
        policyEvaluationTimestampOrderKey(selection.effectiveAt) <= at &&
        policyEvaluationTimestampOrderKey(request.expiresAt) <=
          policyEvaluationTimestampOrderKey(selection.expiresAt),
      "Input validity must fit the published selection interval",
    );
    const candidate = validateReleaseCandidateRecord(input.candidate);
    requireBinding(
      equal(candidate.scope, request.scope) &&
        equal(request.candidate, {
          candidateId: candidate.candidateId,
          candidateVersionId: candidate.candidateVersionId,
          definitionSha256: candidate.definitionSha256,
        }) &&
        equal(candidate.target, selection.candidateTarget) &&
        policyEvaluationTimestampOrderKey(candidate.createdAt) <= at,
      "Input must bind the original candidate and complete installation target",
    );
    requireBinding(
      selection.authorizedPublisherPrincipalIds.includes(request.publisher.principalId) &&
        request.publisher.principalId !== candidate.createdByPrincipalId,
      "Input publisher must be installed and distinct from the candidate author",
    );
    requireBinding(
      request.evaluations.length === selection.policies.length &&
        input.policies.length === selection.policies.length,
      "Input must retain every selected policy, including advisory members",
    );
    for (const [index, selected] of selection.policies.entries()) {
      const planned = request.evaluations[index];
      const policy = validateReleasePolicyRecord(input.policies[index]);
      requireBinding(
        planned !== undefined &&
          planned.mode === selected.mode &&
          policy.mode === selected.mode &&
          policy.installationBinding.installationId === selection.installationId &&
          equal(policy.scope, request.scope) &&
          equal(selected.policy, planned.request.policy) &&
          equal(selected.policy, {
            policyId: policy.policyId,
            policyVersionId: policy.policyVersionId,
            definitionSha256: policy.definitionSha256,
          }),
        "Planned request must bind the exact ordered installed policy and mode",
      );
      requireBinding(
        digest(
          encodePolicyEvaluationRequestDefinition({
            scope: request.scope,
            definition: planned.request,
          }),
        ) === planned.requestSha256,
        "Invalid planned request definition digest",
      );
      requireBinding(
        request.publisher.principalId !== policy.publishedByPrincipalId &&
          policyEvaluationTimestampOrderKey(policy.publishedAt) <= at &&
          policyEvaluationTimestampOrderKey(policy.effectiveAt) <= at &&
          policyEvaluationTimestampOrderKey(request.expiresAt) <=
            policyEvaluationTimestampOrderKey(policy.expiresAt),
        "Input must fit the policy interval and retain an independent publisher",
      );
    }
    return request;
  } catch (cause) {
    if (cause instanceof InvalidReleaseDecisionInputError) throw cause;
    throw new InvalidReleaseDecisionInputError("Invalid release decision input bindings", {
      cause,
    });
  }
}
