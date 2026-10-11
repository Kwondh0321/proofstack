import type { EvaluationRecordKind } from "@proofstack/contracts";
import { policyEvaluationAssuranceReferences } from "./policy-evaluation-assurance-references.js";
import {
  revalidatePolicyEvaluationCapturedRecord,
  revalidatePolicyEvaluationCapturedStorage,
} from "./policy-evaluation-captured-record.js";
import {
  inspectPolicyEvaluationEvidenceCapture,
  inspectPolicyEvaluationEvidenceRecord,
  type PolicyEvaluationEvidenceCapture,
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

function enumerateRecord(
  source: PolicyEvaluationEvidenceSource,
  record: NonNullable<PolicyEvaluationEvidenceRead["record"]>,
  out: PolicyEvaluationReferenceCollector,
): void {
  const kind = source.kind;
  if (Object.hasOwn(policyEvaluationRecordReferences, kind)) {
    // Both entry points use the fixed owning inspector before this private field grammar.
    policyEvaluationRecordReferences[kind as EvaluationRecordKind](record as never, out);
  } else {
    policyEvaluationAssuranceReferences[kind as keyof typeof policyEvaluationAssuranceReferences](
      record as never,
      out,
    );
  }
}

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
    enumerateRecord(checked.source, checked.record, out);
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

/**
 * Enumerates the original stored body's declarations, including unavailable future bodies.
 * Storage provenance is separate from semantic availability; no child existence/current authority,
 * executable bytes, complete closure or sealed publication is established here.
 */
export function enumeratePolicyEvaluationStoredEvidenceReferences(
  input: ReadPolicyEvaluationEvidenceInput,
  capture: PolicyEvaluationEvidenceCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  try {
    const checked = revalidatePolicyEvaluationCapturedStorage(
      input,
      capture,
      inspectPolicyEvaluationEvidenceCapture,
    );
    enumerateRecord(checked.read.source, checked.storage.record, out);
    return {
      ...out.result(),
      semanticObservation: checked.read.observation,
      storage: {
        source: checked.read.source,
        recordSha256: checked.storage.recordSha256,
        receiptTime: checked.storage.receiptTime,
      },
    };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
