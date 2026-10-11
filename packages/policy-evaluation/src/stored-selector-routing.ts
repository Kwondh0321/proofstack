import {
  inspectPolicyEvaluationStoredImplementationResolution,
  inspectPolicyEvaluationStoredSelector,
  inspectPolicyEvaluationStoredSelectors,
  type PolicyEvaluationEvidenceReference,
  type PolicyEvaluationEvidenceReferenceLimits,
  type PolicyEvaluationImplementationParentSource,
  type PolicyEvaluationSelectorParentCapture,
  type PolicyEvaluationSelectorParentSource,
  type PolicyEvaluationStoredImplementationResolution,
  type PolicyEvaluationStoredSelectorRead,
  readPolicyEvaluationStoredImplementationResolution,
  readPolicyEvaluationStoredSelector,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationStoredModelEndpointResolution,
  type PolicyEvaluationDatasetCapture,
  type PolicyEvaluationModelEndpointParentSource,
  type PolicyEvaluationStoredModelEndpointResolution,
  readPolicyEvaluationStoredModelEndpointResolution,
} from "@proofstack/datasets";
import {
  emptyEndpointProfiles,
  emptyImplementationRegistrations,
  emptyProtocolDefinitions,
  type PolicyRecordGraphRepositories,
} from "./record-routing.js";
import {
  inspectStoredParentProtocolResolution,
  isResolvableProtocolReference,
  type PolicyProtocolParentSource,
  type PolicyStoredProtocolResolution,
  readStoredParentProtocolResolution,
} from "./resolve-parent-protocol.js";
import type {
  PolicyRecordContext,
  PolicyRetainedRecordCapture,
} from "./retained-record-routing.js";

export type PolicyStoredSelectorResolution =
  | { readonly kind: "selector"; readonly report: PolicyEvaluationStoredSelectorRead }
  | {
      readonly kind: "implementation";
      readonly report: PolicyEvaluationStoredImplementationResolution;
    }
  | { readonly kind: "endpoint"; readonly report: PolicyEvaluationStoredModelEndpointResolution }
  | { readonly kind: "protocol"; readonly report: PolicyStoredProtocolResolution };

export function isStoredSelectorReference(reference: PolicyEvaluationEvidenceReference): boolean {
  return (
    isResolvableProtocolReference(reference) ||
    reference.kind === "endpoint_profile_selector" ||
    reference.kind === "registered_implementation" ||
    reference.kind === "criterion_selector" ||
    reference.kind === "model_evaluator_selector" ||
    reference.kind === "evaluation_run_identity" ||
    (reference.kind === "control_declaration" &&
      reference.declaration.kind === "comparison_predecessor")
  );
}

/** Fixed owning joins only. Ports are already metered by the immutable request's composer. */
export async function readStoredSelectorReference(
  context: PolicyRecordContext,
  capture: PolicyRetainedRecordCapture,
  reference: PolicyEvaluationEvidenceReference,
  limits: PolicyEvaluationEvidenceReferenceLimits,
  ports: PolicyRecordGraphRepositories,
): Promise<PolicyStoredSelectorResolution> {
  const { scope, evaluationTime, source } = context;
  const input = { scope, evaluationTime, source, path: reference.path, limits };
  if (isResolvableProtocolReference(reference)) {
    if (!context.replayLimits) throw new TypeError("Expected original finite replay limits");
    return {
      kind: "protocol",
      report: await readStoredParentProtocolResolution(
        {
          ...input,
          source: source as PolicyProtocolParentSource,
          replayLimits: context.replayLimits,
        },
        capture,
        ports.protocolDefinitions ?? emptyProtocolDefinitions,
      ),
    };
  }
  if (reference.kind === "endpoint_profile_selector")
    return {
      kind: "endpoint",
      report: await readPolicyEvaluationStoredModelEndpointResolution(
        { ...input, source: source as PolicyEvaluationModelEndpointParentSource },
        capture as PolicyEvaluationDatasetCapture,
        ports.endpointProfiles ?? emptyEndpointProfiles,
      ),
    };
  if (reference.kind === "registered_implementation")
    return {
      kind: "implementation",
      report: await readPolicyEvaluationStoredImplementationResolution(
        { ...input, source: source as PolicyEvaluationImplementationParentSource },
        capture as Parameters<typeof readPolicyEvaluationStoredImplementationResolution>[1],
        ports.implementationRegistrations ?? emptyImplementationRegistrations,
      ),
    };
  if (!isStoredSelectorReference(reference)) throw new TypeError("Expected an owning selector");
  return {
    kind: "selector",
    report: await readPolicyEvaluationStoredSelector(
      { ...input, source: source as PolicyEvaluationSelectorParentSource },
      capture as PolicyEvaluationSelectorParentCapture,
      {
        comparison: ports.control.comparison,
        evaluation: ports.evidence.evaluation,
        modelAssurance: ports.evidence.modelAssurance,
      },
    ),
  };
}

export function storedSelectorChildren(
  resolution: PolicyStoredSelectorResolution,
): readonly PolicyRetainedRecordCapture[] {
  if (resolution.kind === "protocol")
    return resolution.report.childCaptures.filter(
      (capture): capture is NonNullable<typeof capture> => capture !== null,
    );
  return resolution.report.childCapture ? [resolution.report.childCapture] : [];
}

/** Reuse only one privately owned parent admission; child material remains independently checked. */
export function inspectStoredCoreSelectors(
  context: PolicyRecordContext,
  capture: PolicyRetainedRecordCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
  resolutions: readonly Extract<PolicyStoredSelectorResolution, { kind: "selector" }>[],
): readonly PolicyStoredSelectorResolution[] {
  const first = resolutions[0];
  if (!first) return [];
  return inspectPolicyEvaluationStoredSelectors(
    {
      scope: context.scope,
      evaluationTime: context.evaluationTime,
      source: context.source as PolicyEvaluationSelectorParentSource,
      path: first.report.reference.path,
      limits,
    },
    capture as PolicyEvaluationSelectorParentCapture,
    resolutions.map(({ report }) => ({
      path: report.reference.path,
      record: report.childCapture?.storage?.record,
    })),
  ).map((report) => ({ kind: "selector", report }));
}

/** Recompute valid retained joins from original bodies; failures remain explicit frontiers. */
export function inspectStoredSelectorResolution(
  context: PolicyRecordContext,
  capture: PolicyRetainedRecordCapture,
  reference: PolicyEvaluationEvidenceReference,
  limits: PolicyEvaluationEvidenceReferenceLimits,
  resolution: PolicyStoredSelectorResolution,
): PolicyStoredSelectorResolution | null {
  const kind = isResolvableProtocolReference(reference)
    ? "protocol"
    : reference.kind === "endpoint_profile_selector"
      ? "endpoint"
      : reference.kind === "registered_implementation"
        ? "implementation"
        : "selector";
  if (resolution.kind !== kind || !isStoredSelectorReference(reference))
    throw new TypeError("Expected the fixed owning selector family");
  const input = {
    scope: context.scope,
    evaluationTime: context.evaluationTime,
    source: context.source,
    path: reference.path,
    limits,
  };
  if (resolution.kind === "protocol") {
    if (!context.replayLimits || !isResolvableProtocolReference(reference))
      throw new TypeError("Expected owning protocol resolution");
    return {
      kind: "protocol",
      report: inspectStoredParentProtocolResolution(
        {
          ...input,
          source: context.source as PolicyProtocolParentSource,
          replayLimits: context.replayLimits,
        },
        capture,
        resolution.report.childResolution.matches.map((member) =>
          member.status === "retained" ? member.record : {},
        ),
      ),
    };
  }
  const raw = resolution.report.childCapture?.storage?.record;
  if (!raw) {
    if (
      resolution.report.childResolution.status === "resolved" ||
      (resolution.report.childResolution.status === "unavailable" &&
        resolution.report.childResolution.reason === "not_yet_available")
    )
      throw new TypeError("Expected original retained child storage");
    return null;
  }
  if (resolution.kind === "endpoint") {
    if (reference.kind !== "endpoint_profile_selector")
      throw new TypeError("Expected owning endpoint resolution");
    return {
      kind: "endpoint",
      report: inspectPolicyEvaluationStoredModelEndpointResolution(
        { ...input, source: context.source as PolicyEvaluationModelEndpointParentSource },
        capture as PolicyEvaluationDatasetCapture,
        raw,
      ),
    };
  }
  if (resolution.kind === "implementation") {
    if (reference.kind !== "registered_implementation")
      throw new TypeError("Expected owning implementation resolution");
    return {
      kind: "implementation",
      report: inspectPolicyEvaluationStoredImplementationResolution(
        { ...input, source: context.source as PolicyEvaluationImplementationParentSource },
        capture as Parameters<typeof inspectPolicyEvaluationStoredImplementationResolution>[1],
        raw,
      ),
    };
  }
  if (
    reference.kind === "endpoint_profile_selector" ||
    reference.kind === "registered_implementation" ||
    isResolvableProtocolReference(reference)
  )
    throw new TypeError("Expected owning core selector resolution");
  return {
    kind: "selector",
    report: inspectPolicyEvaluationStoredSelector(
      { ...input, source: context.source as PolicyEvaluationSelectorParentSource },
      capture as PolicyEvaluationSelectorParentCapture,
      raw,
    ),
  };
}
