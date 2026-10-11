import type {
  EvidenceScope,
  PolicyEvaluationSourceReference,
  RuntimeDefinitionRecord,
} from "@proofstack/contracts";
import type { RuntimeDefinitionReader } from "../runtime/runtime-definition-catalogue.js";
import {
  InvalidRuntimeDefinitionRecordError,
  validateRuntimeDefinitionRecord,
} from "../runtime/runtime-definition-record.js";
import {
  revalidatePolicyEvaluationCapturedRecord,
  revalidatePolicyEvaluationCapturedStorage,
} from "./policy-evaluation-captured-record.js";
import {
  inspectPolicyEvaluationDefinitionCapture,
  inspectPolicyEvaluationDefinitionRecord,
  type PolicyEvaluationDefinitionCapture,
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
  type PolicyEvaluationDefinitionValidator,
  readPolicyEvaluationDefinitionCapture,
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
export type PolicyEvaluationRuntimeCapture = PolicyEvaluationDefinitionCapture<
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

/** Original storage and receipts remain separate from availability at the original cut. */
export function inspectPolicyEvaluationRuntimeCapture(
  input: Input,
  raw: unknown,
): PolicyEvaluationRuntimeCapture {
  return inspectPolicyEvaluationDefinitionCapture(input, raw, validator);
}

/** Exact record acquisition only; a prior Boolean allowlist or the requested reference is not a record. */
export function readPolicyEvaluationRuntimeRecord(
  input: Input,
  reader: RuntimeDefinitionReader,
): Promise<PolicyEvaluationRuntimeRead> {
  return readPolicyEvaluationDefinitionRecord(input, {
    ...validator,
    read: runtimeReadPort(reader),
  });
}

/** Same exact owning lookup and fixed validation; no installed-code authority. */
export function readPolicyEvaluationRuntimeCapture(
  input: Input,
  reader: RuntimeDefinitionReader,
): Promise<PolicyEvaluationRuntimeCapture> {
  return readPolicyEvaluationDefinitionCapture(input, {
    ...validator,
    read: runtimeReadPort(reader),
  });
}

function runtimeReadPort(reader: RuntimeDefinitionReader) {
  return (scope: EvidenceScope, source: PolicyEvaluationRuntimeSource): Promise<unknown> => {
    switch (source.kind) {
      case "replay_runtime_profile":
        return reader.findRuntimeProfile(scope, source.reference.id, source.reference.version);
      case "replay_isolation_profile":
        return reader.findIsolationProfile(scope, source.reference.id, source.reference.version);
      case "runtime_adapter":
        return reader.findRuntimeAdapter(scope, source.reference.adapterVersionId);
    }
  };
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
  runtimeReferences(checked.record, out);
  return {
    ...out.result(),
    source: checked.source,
    recordSha256: checked.observation.recordSha256,
  };
}

function runtimeReferences(
  record: RuntimeDefinitionRecord,
  out: PolicyEvaluationReferenceCollector,
) {
  out.artifact("/configuration", record.configuration);
  out.artifact("/implementation", record.implementation);
  if (record.recordKind === "runtime_adapter") {
    out.artifact("/interfaceContract", record.interfaceContract);
    out.protocol("/protocol", record.protocol);
  }
}

/** Stored declarations never promote a future body into a verified semantic operand. */
export function enumeratePolicyEvaluationStoredRuntimeReferences(
  input: Input,
  capture: PolicyEvaluationRuntimeCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  const checked = revalidatePolicyEvaluationCapturedStorage(
    input,
    capture,
    inspectPolicyEvaluationRuntimeCapture,
  );
  runtimeReferences(checked.storage.record, out);
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
