import {
  encodeEvaluationCanonicalJson,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationSourceReference,
} from "@proofstack/contracts";
import type { PolicyEvaluationDefinitionRead } from "./policy-evaluation-definition-reader.js";
import { PolicyEvaluationEvidenceReferenceError } from "./policy-evaluation-reference-collector.js";

/**
 * Internal capture integrity boundary, not authentication or a validator registration API.
 * The inspector must be a fixed domain-owned implementation. No repository I/O is performed.
 */
export function revalidatePolicyEvaluationCapturedRecord<
  Input,
  Record,
  Source extends PolicyEvaluationSourceReference,
>(
  input: Input,
  evidence: PolicyEvaluationDefinitionRead<Record, Source>,
  inspect: (input: Input, raw: unknown) => PolicyEvaluationDefinitionRead<Record, Source>,
): {
  readonly observation: { readonly status: "verified"; readonly recordSha256: string };
  readonly record: Record;
  readonly source: Source;
} {
  try {
    const fixedInput = structuredClone(input);
    if (
      !evidence ||
      Object.keys(evidence).some((key) => !["record", "source", "observation"].includes(key))
    ) {
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    }
    const entry = PolicyEvaluationManifestEntrySchema.parse({
      observation: evidence.observation,
      source: evidence.source,
    });
    if (entry.observation.status !== "verified") {
      throw new PolicyEvaluationEvidenceReferenceError("evidence_unverified");
    }
    // Read a potentially accessor-backed body exactly once, then use only the inspected copy.
    const raw = evidence.record;
    if (raw === null) {
      throw new PolicyEvaluationEvidenceReferenceError("evidence_unverified");
    }
    const checked = inspect(fixedInput, raw);
    if (checked.observation.status !== "verified" || checked.record === null) {
      throw new PolicyEvaluationEvidenceReferenceError("evidence_unverified");
    }
    if (
      checked.observation.recordSha256 !== entry.observation.recordSha256 ||
      !Buffer.from(encodeEvaluationCanonicalJson(checked.source)).equals(
        encodeEvaluationCanonicalJson(entry.source),
      )
    ) {
      throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
    }
    return { observation: checked.observation, record: checked.record, source: checked.source };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
