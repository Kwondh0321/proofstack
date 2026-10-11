import type {
  EvidenceScope,
  PolicyEvaluationSourceReference,
  ProtocolDefinitionRecord,
} from "@proofstack/contracts";
import {
  InvalidProtocolDefinitionRecordError,
  type ProtocolDefinitionReader,
  validateProtocolDefinitionRecord,
} from "../runtime/protocol-definition.js";
import {
  revalidatePolicyEvaluationCapturedRecord,
  revalidatePolicyEvaluationCapturedStorage,
} from "./policy-evaluation-captured-record.js";
import {
  inspectPolicyEvaluationDefinitionCapture,
  inspectPolicyEvaluationDefinitionRecord,
  type PolicyEvaluationDefinitionCapture,
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
  type PolicyEvaluationDefinitionValidator,
  readPolicyEvaluationDefinitionCapture,
  readPolicyEvaluationDefinitionRecord,
} from "./policy-evaluation-definition-reader.js";
import {
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "./policy-evaluation-reference-collector.js";

export type PolicyEvaluationProtocolSource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "protocol_definition" }
>;
export type PolicyEvaluationProtocolRead = PolicyEvaluationDefinitionRead<
  ProtocolDefinitionRecord,
  PolicyEvaluationProtocolSource
>;
export type PolicyEvaluationProtocolCapture = PolicyEvaluationDefinitionCapture<
  ProtocolDefinitionRecord,
  PolicyEvaluationProtocolSource
>;
type Input = PolicyEvaluationDefinitionReadInput<PolicyEvaluationProtocolSource>;
const validator: PolicyEvaluationDefinitionValidator<
  PolicyEvaluationProtocolSource,
  ProtocolDefinitionRecord
> = {
  kinds: ["protocol_definition"],
  isInvalidRecordError: (cause) => cause instanceof InvalidProtocolDefinitionRecordError,
  receiptTime: (record) => record.registeredAt,
  validate: (_source, raw) => validateProtocolDefinitionRecord(raw),
};

/** Independent retained declaration integrity, without installation/compatibility authority. */
export function inspectPolicyEvaluationProtocolRecord(
  input: Input,
  raw: unknown,
): PolicyEvaluationProtocolRead {
  return inspectPolicyEvaluationDefinitionRecord(input, raw, validator);
}

/** Full original storage/hash/receipt at the unchanged semantic cut. */
export function inspectPolicyEvaluationProtocolCapture(
  input: Input,
  raw: unknown,
): PolicyEvaluationProtocolCapture {
  return inspectPolicyEvaluationDefinitionCapture(input, raw, validator);
}

/** Exact scope/storage identity selects the record; the expected digest never selects storage. */
export function readPolicyEvaluationProtocolRecord(
  input: Input,
  reader: Pick<ProtocolDefinitionReader, "findProtocolDefinition">,
): Promise<PolicyEvaluationProtocolRead> {
  return readPolicyEvaluationDefinitionRecord(input, {
    ...validator,
    read: protocolReadPort(reader),
  });
}

/** Exact owning storage lookup; expected hashes never select records or grant compatibility. */
export function readPolicyEvaluationProtocolCapture(
  input: Input,
  reader: Pick<ProtocolDefinitionReader, "findProtocolDefinition">,
): Promise<PolicyEvaluationProtocolCapture> {
  return readPolicyEvaluationDefinitionCapture(input, {
    ...validator,
    read: protocolReadPort(reader),
  });
}

function protocolReadPort(reader: Pick<ProtocolDefinitionReader, "findProtocolDefinition">) {
  return (scope: EvidenceScope, source: PolicyEvaluationProtocolSource) =>
    reader.findProtocolDefinition(scope, source.reference.protocolDefinitionId);
}

/** Revalidates the entire captured body and original receipts before retaining every occurrence. */
export function enumeratePolicyEvaluationProtocolReferences(
  input: Input,
  evidence: PolicyEvaluationProtocolRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedRecord<
    Input,
    ProtocolDefinitionRecord,
    PolicyEvaluationProtocolSource
  >(input, evidence, inspectPolicyEvaluationProtocolRecord);
  protocolReferences(checked.record, out);
  return {
    ...out.result(),
    source: checked.source,
    recordSha256: checked.observation.recordSha256,
  };
}

function protocolReferences(
  record: ProtocolDefinitionRecord,
  out: PolicyEvaluationReferenceCollector,
) {
  out.artifact("/specification", record.specification);
  if ("implementation" in record) {
    out.artifact("/implementation", record.implementation);
    out.artifact("/configuration", record.configuration);
  }
}

/** Every stored occurrence, with original semantic availability kept separate. */
export function enumeratePolicyEvaluationStoredProtocolReferences(
  input: Input,
  capture: PolicyEvaluationProtocolCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedStorage(
    input,
    capture,
    inspectPolicyEvaluationProtocolCapture,
  );
  protocolReferences(checked.storage.record, out);
  return {
    ...out.result(),
    semanticObservation: checked.read.observation,
    storage: {
      source: checked.read.source,
      recordSha256: checked.storage.recordSha256,
      receiptTime: checked.storage.receiptTime,
    },
  };
}
