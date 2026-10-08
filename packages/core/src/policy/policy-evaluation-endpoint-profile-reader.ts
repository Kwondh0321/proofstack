import type { EndpointProfileRecord, PolicyEvaluationSourceReference } from "@proofstack/contracts";
import {
  type EndpointProfileReader,
  InvalidEndpointProfileRecordError,
  validateEndpointProfileRecord,
} from "../runtime/endpoint-profile.js";
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

export type PolicyEvaluationEndpointProfileSource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "endpoint_profile" }
>;
export type PolicyEvaluationEndpointProfileRead = PolicyEvaluationDefinitionRead<
  EndpointProfileRecord,
  PolicyEvaluationEndpointProfileSource
>;
type Input = PolicyEvaluationDefinitionReadInput<PolicyEvaluationEndpointProfileSource>;
const validator: PolicyEvaluationDefinitionValidator<
  PolicyEvaluationEndpointProfileSource,
  EndpointProfileRecord
> = {
  kinds: ["endpoint_profile"],
  isInvalidRecordError: (cause) => cause instanceof InvalidEndpointProfileRecordError,
  receiptTime: (record) => record.registeredAt,
  validate: (_source, raw) => validateEndpointProfileRecord(raw),
};

/** Complete independent data and original receipt, without provider/current execution authority. */
export function inspectPolicyEvaluationEndpointProfileRecord(
  input: Input,
  raw: unknown,
): PolicyEvaluationEndpointProfileRead {
  return inspectPolicyEvaluationDefinitionRecord(input, raw, validator);
}

/** The expected hash validates a retained record; exact ID/version alone select the read. */
export function readPolicyEvaluationEndpointProfileRecord(
  input: Input,
  reader: EndpointProfileReader,
): Promise<PolicyEvaluationEndpointProfileRead> {
  return readPolicyEvaluationDefinitionRecord(input, {
    ...validator,
    read: (scope, source) =>
      reader.findEndpointProfile(
        scope,
        source.reference.endpointProfileId,
        source.reference.endpointProfileVersion,
      ),
  });
}

/** Retains the exact configuration occurrence; no content/key/network/credential I/O. */
export function enumeratePolicyEvaluationEndpointProfileReferences(
  input: Input,
  evidence: PolicyEvaluationEndpointProfileRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedRecord<
    Input,
    EndpointProfileRecord,
    PolicyEvaluationEndpointProfileSource
  >(input, evidence, inspectPolicyEvaluationEndpointProfileRecord);
  out.artifact("/configuration", checked.record.configuration);
  return {
    ...out.result(),
    source: checked.source,
    recordSha256: checked.observation.recordSha256,
  };
}
