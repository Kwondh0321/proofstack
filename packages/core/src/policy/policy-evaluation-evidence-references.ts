import type { EvaluationRecordKind } from "@proofstack/contracts";
import { policyEvaluationAssuranceReferences } from "./policy-evaluation-assurance-references.js";
import { revalidatePolicyEvaluationCapturedRecord } from "./policy-evaluation-captured-record.js";
import {
  inspectPolicyEvaluationEvidenceRecord,
  type PolicyEvaluationEvidenceRead,
  type PolicyEvaluationEvidenceSource,
  type ReadPolicyEvaluationEvidenceInput,
} from "./policy-evaluation-evidence-reader.js";
import { policyEvaluationRecordReferences } from "./policy-evaluation-record-references.js";
import {
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "./policy-evaluation-reference-collector.js";

export {
  type PolicyEvaluationEvidenceReference,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "./policy-evaluation-reference-collector.js";

/**
 * Enumerates explicit record/artifact references and unresolved selectors from one exact record.
 * Revalidates the captured full-record observation before traversal. It does not read children,
 * resolve selectors, establish authority, expand artifact contents, seal a cut, or evaluate rules.
 */
export function enumeratePolicyEvaluationEvidenceReferences(
  input: ReadPolicyEvaluationEvidenceInput,
  evidence: PolicyEvaluationEvidenceRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  try {
    const checked = revalidatePolicyEvaluationCapturedRecord<
      ReadPolicyEvaluationEvidenceInput,
      NonNullable<PolicyEvaluationEvidenceRead["record"]>,
      PolicyEvaluationEvidenceSource
    >(input, evidence, inspectPolicyEvaluationEvidenceRecord);
    const kind = checked.source.kind;
    if (Object.hasOwn(policyEvaluationRecordReferences, kind)) {
      // The shared record inspector has already validated this exact discriminant and body.
      policyEvaluationRecordReferences[kind as EvaluationRecordKind](checked.record as never, out);
    } else {
      policyEvaluationAssuranceReferences[kind as keyof typeof policyEvaluationAssuranceReferences](
        checked.record as never,
        out,
      );
    }
    return {
      ...out.result(),
      recordSha256: checked.observation.recordSha256,
      source: checked.source,
    };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
