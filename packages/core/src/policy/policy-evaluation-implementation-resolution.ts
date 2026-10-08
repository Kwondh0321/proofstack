import {
  type EvaluationImplementationRegistrationRecord,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
} from "@proofstack/contracts";
import {
  type EvaluationImplementationRegistrationReader,
  InvalidEvaluationImplementationRegistrationError,
  validateEvaluationImplementationRegistrationRecord,
} from "../evaluation/evaluation-implementation-registration.js";
import {
  type PolicyEvaluationEvidenceRead,
  type PolicyEvaluationEvidenceSource,
} from "./policy-evaluation-evidence-reader.js";
import { enumeratePolicyEvaluationEvidenceReferences } from "./policy-evaluation-evidence-references.js";
import {
  inspectPolicyEvaluationImplementationRecord,
  type PolicyEvaluationImplementationSource,
} from "./policy-evaluation-implementation-reader.js";
import type {
  PolicyEvaluationEvidenceReference,
  PolicyEvaluationEvidenceReferenceLimits,
} from "./policy-evaluation-reference-collector.js";

const parents = [
  "oracle_spec",
  "evaluator_spec",
  "evaluation_run",
  "evaluation_run_rejection",
] as const;
export type PolicyEvaluationImplementationParentSource = Extract<
  PolicyEvaluationEvidenceSource,
  { readonly kind: (typeof parents)[number] }
>;
export interface ReadPolicyEvaluationImplementationResolutionInput {
  readonly evaluationTime: string;
  readonly scope: EvidenceScope;
  readonly source: PolicyEvaluationImplementationParentSource;
  readonly path: string;
  readonly limits: PolicyEvaluationEvidenceReferenceLimits;
}
type Reference = Extract<PolicyEvaluationEvidenceReference, { kind: "registered_implementation" }>;
type Resolution =
  | {
      readonly status: "resolved";
      readonly evidence: {
        readonly source: PolicyEvaluationImplementationSource;
        readonly observation: { readonly status: "verified"; readonly recordSha256: string };
        readonly record: EvaluationImplementationRegistrationRecord;
      };
    }
  | { readonly status: "missing"; readonly evidence: null }
  | {
      readonly status: "unavailable";
      readonly reason: "record_invalid" | "reference_mismatch" | "not_yet_available";
      readonly evidence: null;
    };
export type PolicyEvaluationImplementationResolution = Resolution & {
  readonly parent: {
    readonly source: PolicyEvaluationImplementationParentSource;
    readonly recordSha256: string;
  };
  readonly reference: Reference;
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
};

export class PolicyEvaluationImplementationResolutionInputError extends TypeError {
  readonly code = "policy_evaluation_implementation_resolution_input_invalid";
  constructor(options?: ErrorOptions) {
    super("Expected an exact registered implementation occurrence in a captured parent", options);
    this.name = "PolicyEvaluationImplementationResolutionInputError";
  }
}

function prepare(
  input: ReadPolicyEvaluationImplementationResolutionInput,
  evidence: PolicyEvaluationEvidenceRead,
) {
  let fixed: ReadPolicyEvaluationImplementationResolutionInput;
  try {
    if (
      !input ||
      Object.keys(input).some(
        (key) => !["evaluationTime", "scope", "source", "path", "limits"].includes(key),
      )
    )
      throw new TypeError("Unexpected implementation resolution fields");
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    if (
      !parents.some((kind) => kind === source.kind) ||
      typeof input.path !== "string" ||
      !input.path.startsWith("/") ||
      input.path.length > 1024
    )
      throw new TypeError("Unsupported implementation occurrence");
    fixed = {
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
      scope: EvidenceScopeSchema.parse(input.scope),
      source: source as PolicyEvaluationImplementationParentSource,
      path: input.path,
      limits: structuredClone(input.limits),
    };
  } catch (cause) {
    throw new PolicyEvaluationImplementationResolutionInputError({ cause });
  }
  const frontier = enumeratePolicyEvaluationEvidenceReferences(
    { source: fixed.source, scope: fixed.scope, evaluationTime: fixed.evaluationTime },
    evidence,
    fixed.limits,
  );
  const reference = frontier.references.find((value) => value.path === fixed.path);
  if (!reference || reference.kind !== "registered_implementation")
    throw new PolicyEvaluationImplementationResolutionInputError();
  return { fixed, frontier, reference };
}

function inspect(
  fixed: ReadPolicyEvaluationImplementationResolutionInput,
  reference: Reference,
  raw: unknown,
): Resolution {
  if (raw === null) return { status: "missing", evidence: null };
  let record: EvaluationImplementationRegistrationRecord;
  try {
    record = validateEvaluationImplementationRegistrationRecord(raw);
  } catch (cause) {
    if (!(cause instanceof InvalidEvaluationImplementationRegistrationError)) throw cause;
    return { status: "unavailable", reason: "record_invalid", evidence: null };
  }
  if (
    !Buffer.from(encodeEvaluationCanonicalJson(record.implementation)).equals(
      encodeEvaluationCanonicalJson(reference.reference),
    )
  )
    return { status: "unavailable", reason: "reference_mismatch", evidence: null };
  const source: PolicyEvaluationImplementationSource = {
    kind: "evaluation_implementation_registration",
    reference: {
      implementationId: record.implementation.implementationId,
      implementationVersionId: record.implementation.implementationVersionId,
      definitionSha256: record.definitionSha256,
    },
  };
  const checked = inspectPolicyEvaluationImplementationRecord(
    { source, scope: fixed.scope, evaluationTime: fixed.evaluationTime },
    record,
  );
  if (checked.observation.status === "unavailable")
    return { status: "unavailable", reason: checked.observation.reason, evidence: null };
  if (checked.observation.status !== "verified" || checked.record === null)
    throw new TypeError("Validated implementation registration lost its record");
  return {
    status: "resolved",
    evidence: { source: checked.source, record: checked.record, observation: checked.observation },
  };
}

/** Pure parent-bound retained data join; never installed-code, qualification or publication authority. */
export function inspectPolicyEvaluationImplementationResolution(
  input: ReadPolicyEvaluationImplementationResolutionInput,
  evidence: PolicyEvaluationEvidenceRead,
  raw: unknown,
): PolicyEvaluationImplementationResolution {
  const { fixed, frontier, reference } = prepare(input, evidence);
  return {
    parent: { source: fixed.source, recordSha256: frontier.recordSha256 },
    reference,
    inspectionUsage: {
      references: frontier.references.length,
      referenceBytes: frontier.referenceBytes,
    },
    ...inspect(fixed, reference, raw),
  };
}

/** Whole-parent admission precedes exact independent I/O; storage failures propagate unchanged. */
export async function readPolicyEvaluationImplementationResolution(
  input: ReadPolicyEvaluationImplementationResolutionInput,
  evidence: PolicyEvaluationEvidenceRead,
  reader: EvaluationImplementationRegistrationReader,
): Promise<PolicyEvaluationImplementationResolution> {
  const { fixed, frontier, reference } = prepare(input, evidence);
  const raw = await reader.findEvaluationImplementationRegistration(
    structuredClone(fixed.scope),
    reference.reference.implementationId,
    reference.reference.implementationVersionId,
  );
  return {
    parent: { source: fixed.source, recordSha256: frontier.recordSha256 },
    reference,
    inspectionUsage: {
      references: frontier.references.length,
      referenceBytes: frontier.referenceBytes,
    },
    ...inspect(fixed, reference, raw),
  };
}
