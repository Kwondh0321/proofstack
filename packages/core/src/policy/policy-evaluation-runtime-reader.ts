import type {
  PolicyEvaluationSourceReference,
  RuntimeDefinitionRecord,
} from "@proofstack/contracts";
import type { RuntimeDefinitionReader } from "../runtime/runtime-definition-catalogue.js";
import {
  InvalidRuntimeDefinitionRecordError,
  validateRuntimeDefinitionRecord,
} from "../runtime/runtime-definition-record.js";
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

export type PolicyEvaluationRuntimeSource = Extract<
  PolicyEvaluationSourceReference,
  {
    readonly kind: "replay_runtime_profile" | "replay_isolation_profile" | "runtime_adapter";
  }
>;
export type PolicyEvaluationRuntimeRead = PolicyEvaluationDefinitionRead<
  RuntimeDefinitionRecord,
  PolicyEvaluationRuntimeSource
>;
type Input = PolicyEvaluationDefinitionReadInput<PolicyEvaluationRuntimeSource>;

const validator: PolicyEvaluationDefinitionValidator<
  PolicyEvaluationRuntimeSource,
  RuntimeDefinitionRecord
> = {
  kinds: ["replay_runtime_profile", "replay_isolation_profile", "runtime_adapter"],
  isInvalidRecordError: (cause) => cause instanceof InvalidRuntimeDefinitionRecordError,
  receiptTime: (record) => record.registeredAt,
  validate: (source, raw) => {
    const record = validateRuntimeDefinitionRecord(raw);
    if (source.kind !== record.recordKind) throw new InvalidRuntimeDefinitionRecordError();
    return record;
  },
};

export function inspectPolicyEvaluationRuntimeRecord(
  input: Input,
  raw: unknown,
): PolicyEvaluationRuntimeRead {
  return inspectPolicyEvaluationDefinitionRecord(input, raw, validator);
}

/** Exact record acquisition only; a prior Boolean allowlist or the requested reference is not a record. */
export function readPolicyEvaluationRuntimeRecord(
  input: Input,
  reader: RuntimeDefinitionReader,
): Promise<PolicyEvaluationRuntimeRead> {
  return readPolicyEvaluationDefinitionRecord(input, {
    ...validator,
    read: (scope, source) => {
      switch (source.kind) {
        case "replay_runtime_profile":
          return reader.findRuntimeProfile(scope, source.reference.id, source.reference.version);
        case "replay_isolation_profile":
          return reader.findIsolationProfile(scope, source.reference.id, source.reference.version);
        case "runtime_adapter":
          return reader.findRuntimeAdapter(scope, source.reference.adapterVersionId);
      }
    },
  });
}

/** Retains exact artifact occurrences; does not fetch, interpret, install, or execute their bytes. */
export function enumeratePolicyEvaluationRuntimeReferences(
  input: Input,
  evidence: PolicyEvaluationRuntimeRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedRecord<
    Input,
    RuntimeDefinitionRecord,
    PolicyEvaluationRuntimeSource
  >(input, evidence, inspectPolicyEvaluationRuntimeRecord);
  out.artifact("/configuration", checked.record.configuration);
  out.artifact("/implementation", checked.record.implementation);
  if (checked.record.recordKind === "runtime_adapter")
    out.artifact("/interfaceContract", checked.record.interfaceContract);
  return {
    ...out.result(),
    source: checked.source,
    recordSha256: checked.observation.recordSha256,
  };
}
