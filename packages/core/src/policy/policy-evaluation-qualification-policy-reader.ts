import type {
  EvidenceScope,
  PolicyEvaluationSourceReference,
  QualificationPolicyRecord,
} from "@proofstack/contracts";
import {
  InvalidQualificationPolicyRecordError,
  type QualificationPolicyReader,
  validateQualificationPolicyRecord,
} from "../evaluation/qualification-policy.js";
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

export type PolicyEvaluationQualificationPolicySource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "qualification_policy" }
>;
export type PolicyEvaluationQualificationPolicyRead = PolicyEvaluationDefinitionRead<
  QualificationPolicyRecord,
  PolicyEvaluationQualificationPolicySource
>;
export type PolicyEvaluationQualificationPolicyCapture = PolicyEvaluationDefinitionCapture<
  QualificationPolicyRecord,
  PolicyEvaluationQualificationPolicySource
>;
type Input = PolicyEvaluationDefinitionReadInput<PolicyEvaluationQualificationPolicySource>;

const validator: PolicyEvaluationDefinitionValidator<
  PolicyEvaluationQualificationPolicySource,
  QualificationPolicyRecord
> = {
  kinds: ["qualification_policy"],
  isInvalidRecordError: (cause) => cause instanceof InvalidQualificationPolicyRecordError,
  receiptTime: (record) => record.publishedAt,
  validate: (_source, raw) => validateQualificationPolicyRecord(raw),
};

/** Complete independent body, exact reference/scope and original receipt; never current authority. */
export function inspectPolicyEvaluationQualificationPolicyRecord(
  input: Input,
  raw: unknown,
): PolicyEvaluationQualificationPolicyRead {
  return inspectPolicyEvaluationDefinitionRecord(input, raw, validator);
}

/** Full original publication receipt, without a qualification verdict or current authority. */
export function inspectPolicyEvaluationQualificationPolicyCapture(
  input: Input,
  raw: unknown,
): PolicyEvaluationQualificationPolicyCapture {
  return inspectPolicyEvaluationDefinitionCapture(input, raw, validator);
}

/** The expected digest validates independently stored data; it never selects or creates a policy. */
export function readPolicyEvaluationQualificationPolicyRecord(
  input: Input,
  reader: QualificationPolicyReader,
): Promise<PolicyEvaluationQualificationPolicyRead> {
  return readPolicyEvaluationDefinitionRecord(input, {
    ...validator,
    read: qualificationReadPort(reader),
  });
}

export function readPolicyEvaluationQualificationPolicyCapture(
  input: Input,
  reader: QualificationPolicyReader,
): Promise<PolicyEvaluationQualificationPolicyCapture> {
  return readPolicyEvaluationDefinitionCapture(input, {
    ...validator,
    read: qualificationReadPort(reader),
  });
}

function qualificationReadPort(reader: QualificationPolicyReader) {
  return (scope: EvidenceScope, source: PolicyEvaluationQualificationPolicySource) =>
    reader.findQualificationPolicy(
      scope,
      source.reference.policyId,
      source.reference.policyVersionId,
    );
}

/** Fixed data fields do not grant executable, artifact-fetch or qualification authority. */
export function enumeratePolicyEvaluationQualificationPolicyReferences(
  input: Input,
  evidence: PolicyEvaluationQualificationPolicyRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedRecord<
    Input,
    QualificationPolicyRecord,
    PolicyEvaluationQualificationPolicySource
  >(input, evidence, inspectPolicyEvaluationQualificationPolicyRecord);
  return {
    ...out.result(),
    source: checked.source,
    recordSha256: checked.observation.recordSha256,
  };
}

/** A verified stored body can declare zero dependencies; absent/invalid storage cannot. */
export function enumeratePolicyEvaluationStoredQualificationPolicyReferences(
  input: Input,
  capture: PolicyEvaluationQualificationPolicyCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedStorage(
    input,
    capture,
    inspectPolicyEvaluationQualificationPolicyCapture,
  );
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
