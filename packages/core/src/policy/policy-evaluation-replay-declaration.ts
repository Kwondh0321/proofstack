import {
  OpaqueIdSchema,
  type RecordedBoundaryReplayInvocationDefinition,
  RecordedBoundaryReplayInvocationDefinitionSchema,
  type ReplayBoundaryDeclaration,
  ReplayBoundaryDeclarationSchema,
  ReplayReleaseTargetAdapterReferenceSchema,
  Sha256Schema,
  type TargetRelease,
  TargetReleaseSchema,
  WorkerProtocolReferenceSchema,
} from "@proofstack/contracts";

// Reuse the owning contracts, including their distinct protocol/token limits. These positions
// are type-checked: reordering a contract union must not silently select a different shape.
const schemas = {
  artifact_identity: OpaqueIdSchema,
  credential_selector: ReplayBoundaryDeclarationSchema.options[0].shape.credential,
  digest: Sha256Schema,
  endpoint_profile: ReplayBoundaryDeclarationSchema.options[0].shape.endpointProfile,
  preinstalled_target: TargetReleaseSchema.shape.execution.options[1],
  recorded_adapter: RecordedBoundaryReplayInvocationDefinitionSchema.shape.targetAdapter,
  subprocess_implementation:
    TargetReleaseSchema.shape.subprocessPolicy.options[1].shape.allowedImplementations.element,
  target_adapter: ReplayReleaseTargetAdapterReferenceSchema,
  worker_protocol: WorkerProtocolReferenceSchema,
} satisfies {
  [Kind in keyof DeclarationReferences]: { parse(raw: unknown): DeclarationReferences[Kind] };
};

type LiveBoundary = Extract<ReplayBoundaryDeclaration, { mode: "live_provider" }>;
interface DeclarationReferences {
  artifact_identity: string;
  credential_selector: LiveBoundary["credential"];
  digest: string;
  endpoint_profile: LiveBoundary["endpointProfile"];
  preinstalled_target: Extract<TargetRelease["execution"], { kind: "preinstalled" }>;
  recorded_adapter: RecordedBoundaryReplayInvocationDefinition["targetAdapter"];
  subprocess_implementation: Extract<
    TargetRelease["subprocessPolicy"],
    { mode: "allowlisted" }
  >["allowedImplementations"][number];
  target_adapter: TargetRelease["targetAdapter"];
  worker_protocol: TargetRelease["workerProtocol"];
}

export type PolicyEvaluationReplayDeclaration = {
  [Kind in keyof DeclarationReferences]: {
    readonly kind: Kind;
    readonly reference: DeclarationReferences[Kind];
  };
}[keyof DeclarationReferences];

/** Declaration only: no storage lookup, credential resolution, code loading, or byte verification. */
export function parsePolicyEvaluationReplayDeclaration(
  declaration: PolicyEvaluationReplayDeclaration,
): PolicyEvaluationReplayDeclaration {
  return {
    kind: declaration.kind,
    reference: schemas[declaration.kind].parse(declaration.reference),
  } as PolicyEvaluationReplayDeclaration;
}
