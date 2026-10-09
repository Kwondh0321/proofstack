import type {
  PolicyEvaluationSourceReference,
  ProtocolDefinitionRecord,
} from "@proofstack/contracts";
import {
  InvalidProtocolDefinitionRecordError,
  type ProtocolDefinitionReader,
  validateProtocolDefinitionRecord,
} from "../runtime/protocol-definition.js";
import { revalidatePolicyEvaluationCapturedRecord } from "./policy-evaluation-captured-record.js";
import {
  inspectPolicyEvaluationDefinitionRecord,
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
  type PolicyEvaluationDefinitionValidator,
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

/** Exact scope/storage identity selects the record; the expected digest never selects storage. */
export function readPolicyEvaluationProtocolRecord(
  input: Input,
  reader: Pick<ProtocolDefinitionReader, "findProtocolDefinition">,
): Promise<PolicyEvaluationProtocolRead> {
  return readPolicyEvaluationDefinitionRecord(input, {
    ...validator,
    read: (scope, source) =>
      reader.findProtocolDefinition(scope, source.reference.protocolDefinitionId),
  });
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
  out.artifact("/specification", checked.record.specification);
  if ("implementation" in checked.record) {
    out.artifact("/implementation", checked.record.implementation);
    out.artifact("/configuration", checked.record.configuration);
  }
  return {
    ...out.result(),
    source: checked.source,
    recordSha256: checked.observation.recordSha256,
  };
}
