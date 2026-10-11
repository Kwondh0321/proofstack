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
import {
  revalidatePolicyEvaluationCapturedRecord,
  revalidatePolicyEvaluationCapturedStorage,
} from "./policy-evaluation-captured-record.js";
import type {
  PolicyEvaluationDefinitionCapture,
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
export type PolicyEvaluationImplementationCapture = PolicyEvaluationDefinitionCapture<
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
  return inspectImplementationCapture(input, raw, false).read;
}

/** Owns the complete original nested implementation, exact scope and registration receipt. */
export function inspectPolicyEvaluationImplementationCapture(
  input: Input,
  raw: unknown,
): PolicyEvaluationImplementationCapture {
  return inspectImplementationCapture(input, raw, true);
}

function inspectImplementationCapture(
  input: Input,
  raw: unknown,
  retainStorage: boolean,
): PolicyEvaluationImplementationCapture {
  const { source, scope, evaluationTime } = parse(input);
  const unavailable = (
    observation: Exclude<PolicyEvaluationImplementationRead["observation"], { status: "verified" }>,
  ): PolicyEvaluationImplementationCapture => ({
    read: { source, observation, record: null },
    storage: null,
  });
  if (raw === null) return unavailable({ status: "missing" });
  let record: EvaluationImplementationRegistrationRecord;
  try {
    record = validateEvaluationImplementationRegistrationRecord(raw);
  } catch (cause) {
    if (!(cause instanceof InvalidEvaluationImplementationRegistrationError)) throw cause;
    return unavailable({ status: "unavailable", reason: "record_invalid" });
  }
  if (
    record.scope.tenantId !== scope.tenantId ||
    record.scope.projectId !== scope.projectId ||
    record.scope.environmentId !== scope.environmentId ||
    record.definitionSha256 !== source.reference.definitionSha256 ||
    record.implementation.implementationId !== source.reference.implementationId ||
    record.implementation.implementationVersionId !== source.reference.implementationVersionId
  )
    return unavailable({ status: "unavailable", reason: "reference_mismatch" });
  const future =
    policyEvaluationTimestampOrderKey(record.registeredAt) >
    policyEvaluationTimestampOrderKey(evaluationTime);
  if (future && !retainStorage)
    return unavailable({ status: "unavailable", reason: "not_yet_available" });
  const recordSha256 = createHash("sha256")
    .update(encodeEvaluationCanonicalJson(record))
    .digest("hex");
  return {
    read: future
      ? unavailable({ status: "unavailable", reason: "not_yet_available" }).read
      : { source, record, observation: { status: "verified", recordSha256 } },
    storage: retainStorage
      ? { record: structuredClone(record), recordSha256, receiptTime: record.registeredAt }
      : null,
  };
}

/** Exact independent lookup; an expected digest never selects or creates a registration. */
export async function readPolicyEvaluationImplementationRecord(
  input: Input,
  reader: EvaluationImplementationRegistrationReader,
): Promise<PolicyEvaluationImplementationRead> {
  return (await readImplementationCapture(input, reader, false)).read;
}

export function readPolicyEvaluationImplementationCapture(
  input: Input,
  reader: EvaluationImplementationRegistrationReader,
): Promise<PolicyEvaluationImplementationCapture> {
  return readImplementationCapture(input, reader, true);
}

async function readImplementationCapture(
  input: Input,
  reader: EvaluationImplementationRegistrationReader,
  retainStorage: boolean,
): Promise<PolicyEvaluationImplementationCapture> {
  const fixed = parse(input);
  const raw = await reader.findEvaluationImplementationRegistration(
    structuredClone(fixed.scope),
    fixed.source.reference.implementationId,
    fixed.source.reference.implementationVersionId,
  );
  return inspectImplementationCapture(fixed, raw, retainStorage);
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

/** Valid zero-reference registration data is separate from installed-code authority. */
export function enumeratePolicyEvaluationStoredImplementationReferences(
  input: Input,
  capture: PolicyEvaluationImplementationCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedStorage(
    input,
    capture,
    inspectPolicyEvaluationImplementationCapture,
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
