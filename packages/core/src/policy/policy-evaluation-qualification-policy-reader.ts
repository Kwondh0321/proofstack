import type {
  PolicyEvaluationSourceReference,
  QualificationPolicyRecord,
} from "@proofstack/contracts";
import {
  InvalidQualificationPolicyRecordError,
  type QualificationPolicyReader,
  validateQualificationPolicyRecord,
} from "../evaluation/qualification-policy.js";
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

export type PolicyEvaluationQualificationPolicySource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "qualification_policy" }
>;
export type PolicyEvaluationQualificationPolicyRead = PolicyEvaluationDefinitionRead<
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

/** The expected digest validates independently stored data; it never selects or creates a policy. */
export function readPolicyEvaluationQualificationPolicyRecord(
  input: Input,
  reader: QualificationPolicyReader,
): Promise<PolicyEvaluationQualificationPolicyRead> {
  return readPolicyEvaluationDefinitionRecord(input, {
    ...validator,
    read: (scope, source) =>
      reader.findQualificationPolicy(
        scope,
        source.reference.policyId,
        source.reference.policyVersionId,
      ),
  });
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
