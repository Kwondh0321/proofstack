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
import type {
  PolicyEvaluationEvidenceCapture,
  PolicyEvaluationEvidenceRead,
  PolicyEvaluationEvidenceSource,
} from "./policy-evaluation-evidence-reader.js";
import {
  enumeratePolicyEvaluationEvidenceReferences,
  enumeratePolicyEvaluationStoredEvidenceReferences,
} from "./policy-evaluation-evidence-references.js";
import {
  inspectPolicyEvaluationImplementationCapture,
  inspectPolicyEvaluationImplementationRecord,
  type PolicyEvaluationImplementationCapture,
  type PolicyEvaluationImplementationRead,
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

export interface PolicyEvaluationStoredImplementationResolution {
  readonly parentStorage: {
    readonly source: PolicyEvaluationImplementationParentSource;
    readonly recordSha256: string;
    readonly receiptTime: string;
  };
  readonly parentSemanticObservation: PolicyEvaluationEvidenceRead["observation"];
  readonly reference: Reference;
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
  readonly childResolution: Resolution;
  readonly childCapture: PolicyEvaluationImplementationCapture | null;
}

type RegistrationMaterial =
  | {
      readonly status: "validated";
      readonly source: PolicyEvaluationImplementationSource;
      readonly record: EvaluationImplementationRegistrationRecord;
    }
  | Exclude<Resolution, { status: "resolved" }>;

export class PolicyEvaluationImplementationResolutionInputError extends TypeError {
  readonly code = "policy_evaluation_implementation_resolution_input_invalid";
  constructor(options?: ErrorOptions) {
    super("Expected an exact registered implementation occurrence in a captured parent", options);
    this.name = "PolicyEvaluationImplementationResolutionInputError";
  }
}

function parseInput(
  input: ReadPolicyEvaluationImplementationResolutionInput,
): ReadPolicyEvaluationImplementationResolutionInput {
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
  return fixed;
}

function prepare(
  input: ReadPolicyEvaluationImplementationResolutionInput,
  evidence: PolicyEvaluationEvidenceRead,
) {
  const fixed = parseInput(input);
  const frontier = enumeratePolicyEvaluationEvidenceReferences(
    { source: fixed.source, scope: fixed.scope, evaluationTime: fixed.evaluationTime },
    evidence,
    fixed.limits,
  );
  const reference = frontier.references.find((value) => value.path === fixed.path);
  if (reference?.kind !== "registered_implementation")
    throw new PolicyEvaluationImplementationResolutionInputError();
  return { fixed, frontier, reference };
}

function inspectMaterial(reference: Reference, raw: unknown): RegistrationMaterial {
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
  return { status: "validated", source, record };
}

function resolveChecked(checked: PolicyEvaluationImplementationRead): Resolution {
  if (checked.observation.status === "unavailable")
    return { status: "unavailable", reason: checked.observation.reason, evidence: null };
  if (checked.observation.status !== "verified" || checked.record === null)
    throw new TypeError("Validated implementation registration lost its record");
  return {
    status: "resolved",
    evidence: { source: checked.source, record: checked.record, observation: checked.observation },
  };
}

function inspect(
  fixed: ReadPolicyEvaluationImplementationResolutionInput,
  reference: Reference,
  raw: unknown,
): Resolution {
  const material = inspectMaterial(reference, raw);
  if (material.status !== "validated") return material;
  return resolveChecked(
    inspectPolicyEvaluationImplementationRecord(
      { source: material.source, scope: fixed.scope, evaluationTime: fixed.evaluationTime },
      material.record,
    ),
  );
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

function prepareStored(
  input: ReadPolicyEvaluationImplementationResolutionInput,
  capture: PolicyEvaluationEvidenceCapture,
) {
  const fixed = parseInput(input);
  const frontier = enumeratePolicyEvaluationStoredEvidenceReferences(
    { source: fixed.source, scope: fixed.scope, evaluationTime: fixed.evaluationTime },
    capture,
    fixed.limits,
  );
  const reference = frontier.references.find((value) => value.path === fixed.path);
  if (reference?.kind !== "registered_implementation")
    throw new PolicyEvaluationImplementationResolutionInputError();
  return { fixed, frontier, reference };
}

function inspectStored(
  { fixed, frontier, reference }: ReturnType<typeof prepareStored>,
  raw: unknown,
): PolicyEvaluationStoredImplementationResolution {
  const material = inspectMaterial(reference, raw);
  let childCapture: PolicyEvaluationImplementationCapture | null = null;
  let childResolution: Resolution;
  if (material.status !== "validated") childResolution = material;
  else {
    childCapture = inspectPolicyEvaluationImplementationCapture(
      { source: material.source, scope: fixed.scope, evaluationTime: fixed.evaluationTime },
      material.record,
    );
    childResolution = resolveChecked(childCapture.read);
  }
  return structuredClone({
    parentStorage: {
      source: fixed.source,
      recordSha256: frontier.storage.recordSha256,
      receiptTime: frontier.storage.receiptTime,
    },
    parentSemanticObservation: frontier.semanticObservation,
    reference,
    inspectionUsage: {
      references: frontier.references.length,
      referenceBytes: frontier.referenceBytes,
    },
    childResolution,
    childCapture,
  });
}

/** Full retained registration at the original cut; not executable or publication authority. */
export function inspectPolicyEvaluationStoredImplementationResolution(
  input: ReadPolicyEvaluationImplementationResolutionInput,
  capture: PolicyEvaluationEvidenceCapture,
  raw: unknown,
): PolicyEvaluationStoredImplementationResolution {
  return inspectStored(prepareStored(input, capture), raw);
}

/** Complete stored-parent admission precedes the unchanged fixed registration lookup. */
export async function readPolicyEvaluationStoredImplementationResolution(
  input: ReadPolicyEvaluationImplementationResolutionInput,
  capture: PolicyEvaluationEvidenceCapture,
  reader: EvaluationImplementationRegistrationReader,
): Promise<PolicyEvaluationStoredImplementationResolution> {
  const prepared = prepareStored(input, capture);
  const raw = await reader.findEvaluationImplementationRegistration(
    structuredClone(prepared.fixed.scope),
    prepared.reference.reference.implementationId,
    prepared.reference.reference.implementationVersionId,
  );
  return inspectStored(prepared, raw);
}
