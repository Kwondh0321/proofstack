import type {
  EndpointProfileRecord,
  EvidenceScope,
  PolicyEvaluationSourceReference,
} from "@proofstack/contracts";
import {
  type EndpointProfileReader,
  InvalidEndpointProfileRecordError,
  validateEndpointProfileRecord,
} from "../runtime/endpoint-profile.js";
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

export type PolicyEvaluationEndpointProfileSource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "endpoint_profile" }
>;
export type PolicyEvaluationEndpointProfileRead = PolicyEvaluationDefinitionRead<
  EndpointProfileRecord,
  PolicyEvaluationEndpointProfileSource
>;
export type PolicyEvaluationEndpointProfileCapture = PolicyEvaluationDefinitionCapture<
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

/** Retained data at the original cut, without provider or execution authority. */
export function inspectPolicyEvaluationEndpointProfileCapture(
  input: Input,
  raw: unknown,
): PolicyEvaluationEndpointProfileCapture {
  return inspectPolicyEvaluationDefinitionCapture(input, raw, validator);
}

/** The expected hash validates a retained record; exact ID/version alone select the read. */
export function readPolicyEvaluationEndpointProfileRecord(
  input: Input,
  reader: EndpointProfileReader,
): Promise<PolicyEvaluationEndpointProfileRead> {
  return readPolicyEvaluationDefinitionRecord(input, {
    ...validator,
    read: endpointReadPort(reader),
  });
}

export function readPolicyEvaluationEndpointProfileCapture(
  input: Input,
  reader: EndpointProfileReader,
): Promise<PolicyEvaluationEndpointProfileCapture> {
  return readPolicyEvaluationDefinitionCapture(input, {
    ...validator,
    read: endpointReadPort(reader),
  });
}

function endpointReadPort(reader: EndpointProfileReader) {
  return (scope: EvidenceScope, source: PolicyEvaluationEndpointProfileSource) =>
    reader.findEndpointProfile(
      scope,
      source.reference.endpointProfileId,
      source.reference.endpointProfileVersion,
    );
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
  endpointReferences(checked.record, out);
  return {
    ...out.result(),
    source: checked.source,
    recordSha256: checked.observation.recordSha256,
  };
}

function endpointReferences(
  record: EndpointProfileRecord,
  out: PolicyEvaluationReferenceCollector,
) {
  out.artifact("/configuration", record.configuration);
}

/** Storage provenance and availability remain separate; this does not resolve credentials. */
export function enumeratePolicyEvaluationStoredEndpointProfileReferences(
  input: Input,
  capture: PolicyEvaluationEndpointProfileCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedStorage(
    input,
    capture,
    inspectPolicyEvaluationEndpointProfileCapture,
  );
  endpointReferences(checked.storage.record, out);
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
