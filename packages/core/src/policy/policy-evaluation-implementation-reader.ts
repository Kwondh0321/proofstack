import { createHash } from "node:crypto";
import {
  type EvaluationImplementationRegistrationRecord,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import {
  type EvaluationImplementationRegistrationReader,
  InvalidEvaluationImplementationRegistrationError,
  validateEvaluationImplementationRegistrationRecord,
} from "../evaluation/evaluation-implementation-registration.js";
import { revalidatePolicyEvaluationCapturedRecord } from "./policy-evaluation-captured-record.js";
import type {
  PolicyEvaluationDefinitionRead,
  PolicyEvaluationDefinitionReadInput,
} from "./policy-evaluation-definition-reader.js";
import { PolicyEvaluationDefinitionReadInputError } from "./policy-evaluation-definition-reader.js";
import {
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "./policy-evaluation-reference-collector.js";

export type PolicyEvaluationImplementationSource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "evaluation_implementation_registration" }
>;
export type PolicyEvaluationImplementationRead = PolicyEvaluationDefinitionRead<
  EvaluationImplementationRegistrationRecord,
  PolicyEvaluationImplementationSource
>;
type Input = PolicyEvaluationDefinitionReadInput<PolicyEvaluationImplementationSource>;

function parse(input: Input): Input {
  try {
    if (
      !input ||
      Object.keys(input).some((key) => !["evaluationTime", "scope", "source"].includes(key))
    )
      throw new TypeError("Unexpected registration read fields");
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    if (source.kind !== "evaluation_implementation_registration")
      throw new TypeError("Unsupported registration source");
    return {
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
      scope: EvidenceScopeSchema.parse(input.scope),
      source,
    };
  } catch (cause) {
    throw new PolicyEvaluationDefinitionReadInputError({ cause });
  }
}

/** Full retained data inspection, including nested owning coordinates and original receipt. */
export function inspectPolicyEvaluationImplementationRecord(
  input: Input,
  raw: unknown,
): PolicyEvaluationImplementationRead {
  const { source, scope, evaluationTime } = parse(input);
  if (raw === null) return { source, observation: { status: "missing" }, record: null };
  let record: EvaluationImplementationRegistrationRecord;
  try {
    record = validateEvaluationImplementationRegistrationRecord(raw);
  } catch (cause) {
    if (!(cause instanceof InvalidEvaluationImplementationRegistrationError)) throw cause;
    return {
      source,
      observation: { status: "unavailable", reason: "record_invalid" },
      record: null,
    };
  }
  if (
    record.scope.tenantId !== scope.tenantId ||
    record.scope.projectId !== scope.projectId ||
    record.scope.environmentId !== scope.environmentId ||
    record.definitionSha256 !== source.reference.definitionSha256 ||
    record.implementation.implementationId !== source.reference.implementationId ||
    record.implementation.implementationVersionId !== source.reference.implementationVersionId
  )
    return {
      source,
      observation: { status: "unavailable", reason: "reference_mismatch" },
      record: null,
    };
  if (
    policyEvaluationTimestampOrderKey(record.registeredAt) >
    policyEvaluationTimestampOrderKey(evaluationTime)
  )
    return {
      source,
      observation: { status: "unavailable", reason: "not_yet_available" },
      record: null,
    };
  return {
    source,
    observation: {
      status: "verified",
      recordSha256: createHash("sha256")
        .update(encodeEvaluationCanonicalJson(record))
        .digest("hex"),
    },
    record,
  };
}

/** Exact independent lookup; an expected digest never selects or creates a registration. */
export async function readPolicyEvaluationImplementationRecord(
  input: Input,
  reader: EvaluationImplementationRegistrationReader,
): Promise<PolicyEvaluationImplementationRead> {
  const fixed = parse(input);
  const raw = await reader.findEvaluationImplementationRegistration(
    structuredClone(fixed.scope),
    fixed.source.reference.implementationId,
    fixed.source.reference.implementationVersionId,
  );
  return inspectPolicyEvaluationImplementationRecord(fixed, raw);
}

/** Hash declarations are not artifact IDs or fetch/installed-code authority. */
export function enumeratePolicyEvaluationImplementationReferences(
  input: Input,
  evidence: PolicyEvaluationImplementationRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedRecord<
    Input,
    EvaluationImplementationRegistrationRecord,
    PolicyEvaluationImplementationSource
  >(input, evidence, inspectPolicyEvaluationImplementationRecord);
  return {
    ...out.result(),
    source: checked.source,
    recordSha256: checked.observation.recordSha256,
  };
}
