import { createHash } from "node:crypto";
import {
  ArtifactContentReferenceSchema,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  ProtocolDefinitionRecordSchema,
  ProtocolDefinitionSchema,
  RuntimeDefinitionRecordSchema,
  RuntimeDefinitionSchema,
  TargetReleaseDefinitionSchema,
  UtcMillisecondTimestampSchema,
  encodeProtocolDefinition,
  encodeRuntimeDefinition,
  type EvidenceScope,
  type ProtocolDefinition,
  type ProtocolDefinitionRecord,
  type RuntimeDefinition,
  type RuntimeDefinitionRecord,
  type ReplayRuntimeProfileReference,
  type ReplayIsolationProfileReference,
  type ReleaseCandidateAdapterReference,
  type TargetReleaseDefinition,
} from "@proofstack/contracts";

type ArtifactContentReference = ReturnType<typeof ArtifactContentReferenceSchema.parse>;

export interface PolicyContributorDefinitions {
  readonly runtimeProfile: RuntimeDefinitionRecord;
  readonly isolationProfile: RuntimeDefinitionRecord;
  readonly modelAdapter: RuntimeDefinitionRecord;
  readonly runtimeProfileReference: ReplayRuntimeProfileReference;
  readonly isolationProfileReference: ReplayIsolationProfileReference;
  readonly modelAdapterReference: ReleaseCandidateAdapterReference;
  readonly runtimeDefinitions: readonly RuntimeDefinitionRecord[];
  readonly protocolDefinitions: readonly ProtocolDefinitionRecord[];
}

const limitation =
  "Synthetic operator declarations retain original source definitions without attesting loaded executable bytes or provider identity.";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Fixed library declarations, independent of any requested selector, hash, source read or result. */
export function createPolicyContributorDefinitions(input: {
  readonly namespace: string;
  readonly scope: EvidenceScope;
  readonly registeredAt: string;
  readonly registeredByPrincipalId: string;
  readonly runtime: TargetReleaseDefinition["runtime"];
  readonly implementation: ArtifactContentReference;
  readonly configuration: ArtifactContentReference;
  readonly specification: ArtifactContentReference;
}): PolicyContributorDefinitions {
  const namespace = OpaqueIdSchema.parse(input.namespace);
  const scope = EvidenceScopeSchema.parse(input.scope);
  const registeredAt = UtcMillisecondTimestampSchema.parse(input.registeredAt);
  const registeredByPrincipalId = OpaqueIdSchema.parse(input.registeredByPrincipalId);
  const implementation = ArtifactContentReferenceSchema.parse(input.implementation);
  const configuration = ArtifactContentReferenceSchema.parse(input.configuration);
  const specification = ArtifactContentReferenceSchema.parse(input.specification);
  const admittedRuntime = TargetReleaseDefinitionSchema.shape.runtime.parse(input.runtime);
  const { family, entryPoint: _entryPoint, ...runtime } = admittedRuntime;
  const common = { implementation, configuration, limitations: [limitation] };
  const retainRuntime = (raw: RuntimeDefinition) => {
    const definition = RuntimeDefinitionSchema.parse(raw);
    return RuntimeDefinitionRecordSchema.parse({
      ...definition,
      scope,
      registeredAt,
      registeredByPrincipalId,
      schemaVersion: "0.1",
      definitionSha256: digest(encodeRuntimeDefinition({ definition, scope })),
    });
  };
  const runtimeProfile = retainRuntime({
    ...common,
    recordKind: "replay_runtime_profile",
    id: `runtime_${namespace}_node`,
    version: "1.0.0",
    family,
    runtime,
  });
  const isolationProfile = retainRuntime({
    ...common,
    recordKind: "replay_isolation_profile",
    id: `isolation_${namespace}_child`,
    version: "1.0.0",
    kind: "local_child_process",
  });
  const modelAdapter = retainRuntime({
    ...common,
    recordKind: "runtime_adapter",
    adapterId: `adapter_${namespace}_policy_model`,
    adapterVersionId: `adapter_${namespace}_policy_model_v1`,
    boundaryKinds: ["model"],
    interfaceContract: specification,
    protocol: { name: "proofstack.reference.model", version: "1.0.0" },
  });
  // Opaque storage IDs are independently minted; descriptor equality never supplies an ID/hash.
  const declarations: ProtocolDefinition[] = [
    {
      family: "capture_adapter",
      descriptor: { name: "proofstack.reference_capture", version: "1.0.0" },
      ...common,
      recordKind: "protocol_definition",
      protocolDefinitionId: `protocol_${namespace}_01`,
      specification,
    },
    {
      family: "source_format",
      descriptor: { name: "proofstack.interaction", version: "1.0.0" },
      recordKind: "protocol_definition",
      protocolDefinitionId: `protocol_${namespace}_02`,
      specification,
      limitations: [limitation],
    },
    {
      family: "request_normalizer",
      descriptor: { name: "proofstack.reference.model", version: "1.0.0" },
      ...common,
      recordKind: "protocol_definition",
      protocolDefinitionId: `protocol_${namespace}_03`,
      specification,
    },
    {
      family: "request_normalizer",
      descriptor: { name: "proofstack.reference.tool", version: "1.0.0" },
      ...common,
      recordKind: "protocol_definition",
      protocolDefinitionId: `protocol_${namespace}_04`,
      specification,
    },
    {
      family: "recorded_target_adapter",
      descriptor: { name: "proofstack.reference_recorded_agent", version: "1.0.0" },
      ...common,
      recordKind: "protocol_definition",
      protocolDefinitionId: `protocol_${namespace}_05`,
      specification,
    },
    {
      family: "released_target_adapter",
      descriptor: {
        name: "proofstack.reference_durable_agent",
        version: "1.0.0",
        protocolVersion: "0.2",
      },
      ...common,
      recordKind: "protocol_definition",
      protocolDefinitionId: `protocol_${namespace}_06`,
      specification,
    },
    {
      family: "worker_protocol",
      descriptor: { name: "proofstack.replay-worker", version: "2.0.0" },
      recordKind: "protocol_definition",
      protocolDefinitionId: `protocol_${namespace}_07`,
      specification,
      limitations: [limitation],
    },
    {
      family: "runtime_protocol",
      descriptor: { name: "proofstack.reference.model", version: "1.0.0" },
      recordKind: "protocol_definition",
      protocolDefinitionId: `protocol_${namespace}_08`,
      specification,
      limitations: [limitation],
    },
  ];
  const protocolDefinitions = declarations.map((raw) => {
    const definition = ProtocolDefinitionSchema.parse(raw);
    return ProtocolDefinitionRecordSchema.parse({
      ...definition,
      scope,
      registeredAt,
      registeredByPrincipalId,
      schemaVersion: "0.1",
      definitionSha256: digest(encodeProtocolDefinition({ definition, scope })),
    });
  });
  const runtimeProfileReference = {
    id: `runtime_${namespace}_node`,
    version: "1.0.0",
    family,
    definitionSha256: runtimeProfile.definitionSha256,
  };
  const isolationProfileReference = {
    id: `isolation_${namespace}_child`,
    version: "1.0.0",
    kind: "local_child_process" as const,
    definitionSha256: isolationProfile.definitionSha256,
  };
  const modelAdapterReference = {
    adapterId: `adapter_${namespace}_policy_model`,
    adapterVersionId: `adapter_${namespace}_policy_model_v1`,
    definitionSha256: modelAdapter.definitionSha256,
  };
  return {
    runtimeProfile,
    isolationProfile,
    modelAdapter,
    runtimeProfileReference,
    isolationProfileReference,
    modelAdapterReference,
    runtimeDefinitions: [runtimeProfile, isolationProfile, modelAdapter],
    protocolDefinitions,
  };
}
