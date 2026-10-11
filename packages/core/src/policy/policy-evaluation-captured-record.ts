import { isDeepStrictEqual } from "node:util";
import {
  encodeEvaluationCanonicalJson,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationSourceReference,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import type {
  PolicyEvaluationDefinitionCapture,
  PolicyEvaluationDefinitionRead,
} from "./policy-evaluation-definition-reader.js";
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

/**
 * Internal original-storage integrity boundary. The fixed owning inspector validates the whole
 * retained body, exact reference/scope, original receipt and temporal read at the ORIGINAL cut.
 * It never promotes unavailable storage into verified semantic evidence or performs repository I/O.
 * Do not accept an inspector/validator from a public request or an extensible registry.
 */
export function revalidatePolicyEvaluationCapturedStorage<
  Input,
  Record,
  Source extends PolicyEvaluationSourceReference,
>(
  input: Input,
  capture: PolicyEvaluationDefinitionCapture<Record, Source>,
  inspect: (input: Input, raw: unknown) => PolicyEvaluationDefinitionCapture<Record, Source>,
): {
  readonly read: PolicyEvaluationDefinitionRead<Record, Source>;
  readonly storage: NonNullable<PolicyEvaluationDefinitionCapture<Record, Source>["storage"]>;
} {
  try {
    // Context ownership precedes potentially accessor-backed capture/body reads.
    const fixedInput = structuredClone(input);
    if (!capture || Object.keys(capture).some((key) => key !== "read" && key !== "storage"))
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    const owned = structuredClone(capture);
    if (owned.storage === null || owned.storage === undefined)
      throw new PolicyEvaluationEvidenceReferenceError("evidence_unverified");
    const checked = inspect(fixedInput, owned.storage.record);
    if (checked.storage === null)
      throw new PolicyEvaluationEvidenceReferenceError("evidence_unverified");
    // Validate the checked JSON even on the fast path (including Unicode and nesting limits).
    // Both operands are owned clones: strict equality implies canonical equality, while the
    // fallback preserves canonical equivalences such as negative zero and property ordering.
    const checkedJson = serializeEvaluationCanonicalJson(checked);
    if (
      !isDeepStrictEqual(owned, checked) &&
      serializeEvaluationCanonicalJson(owned) !== checkedJson
    )
      throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
    return { read: checked.read, storage: checked.storage };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
