import {
  type EndpointProfileRecord,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
} from "@proofstack/contracts";
import {
  type EndpointProfileReader,
  InvalidEndpointProfileRecordError,
  inspectPolicyEvaluationEndpointProfileRecord,
  type PolicyEvaluationEndpointProfileSource,
  type PolicyEvaluationEvidenceReference,
  type PolicyEvaluationEvidenceReferenceLimits,
  revalidatePolicyEvaluationCapturedRecord,
  validateEndpointProfileRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDataset,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
  type PolicyEvaluationDatasetSource,
} from "./policy-evaluation-dataset-reader.js";
import { enumeratePolicyEvaluationDatasetReferences } from "./policy-evaluation-dataset-references.js";

export type PolicyEvaluationModelEndpointParentSource = Extract<
  PolicyEvaluationDatasetSource,
  { readonly kind: "regression_fixture_version" }
>;
export interface ReadPolicyEvaluationModelEndpointInput {
  readonly evaluationTime: string;
  readonly scope: EvidenceScope;
  readonly source: PolicyEvaluationModelEndpointParentSource;
  /** Exact provider occurrence in the original full fixture, never a supplied selector or hash. */
  readonly path: string;
  readonly limits: PolicyEvaluationEvidenceReferenceLimits;
}
type Reference = Extract<PolicyEvaluationEvidenceReference, { kind: "endpoint_profile_selector" }>;
const checkKinds = ["provider_name", "operation", "boundary_kind", "configuration"] as const;
export interface PolicyEvaluationModelEndpointCheck {
  readonly kind: (typeof checkKinds)[number];
  readonly observation: {
    readonly status: "matched" | "mismatch" | "unavailable";
  };
}
type Resolution =
  | {
      /** Valid retained data only; all contextual checks remain separate and mandatory. */
      readonly status: "resolved";
      readonly evidence: {
        readonly source: PolicyEvaluationEndpointProfileSource;
        readonly observation: { readonly status: "verified"; readonly recordSha256: string };
        readonly record: EndpointProfileRecord;
      };
    }
  | { readonly status: "missing"; readonly evidence: null }
  | {
      readonly status: "unavailable";
      readonly reason: "record_invalid" | "reference_mismatch" | "not_yet_available";
      readonly evidence: null;
    };
export type PolicyEvaluationModelEndpointResolution = Resolution & {
  readonly parent: {
    readonly source: PolicyEvaluationModelEndpointParentSource;
    readonly recordSha256: string;
  };
  readonly reference: Reference;
  readonly checks: readonly PolicyEvaluationModelEndpointCheck[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
};

export class PolicyEvaluationModelEndpointInputError extends TypeError {
  readonly code = "policy_evaluation_model_endpoint_input_invalid";
  constructor(options?: ErrorOptions) {
    super("Expected an exact model provider occurrence in a captured fixture", options);
    this.name = "PolicyEvaluationModelEndpointInputError";
  }
}

function prepare(
  input: ReadPolicyEvaluationModelEndpointInput,
  evidence: PolicyEvaluationDatasetRead,
) {
  let fixed: ReadPolicyEvaluationModelEndpointInput;
  try {
    if (
      !input ||
      Object.keys(input).some(
        (key) => !["evaluationTime", "scope", "source", "path", "limits"].includes(key),
      )
    )
      throw new TypeError("Unexpected model endpoint resolution fields");
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    if (
      source.kind !== "regression_fixture_version" ||
      typeof input.path !== "string" ||
      !input.path.startsWith("/") ||
      input.path.length > 1024
    )
      throw new TypeError("Unsupported model endpoint parent or occurrence");
    fixed = {
      source,
      path: input.path,
      scope: EvidenceScopeSchema.parse(input.scope),
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
      limits: structuredClone(input.limits),
    };
  } catch (cause) {
    throw new PolicyEvaluationModelEndpointInputError({ cause });
  }
  const context = {
    source: fixed.source,
    scope: fixed.scope,
    evaluationTime: fixed.evaluationTime,
  };
  const checked = revalidatePolicyEvaluationCapturedRecord<
    typeof context,
    PolicyEvaluationDatasetRecord,
    PolicyEvaluationDatasetSource
  >(context, evidence, inspectPolicyEvaluationDataset);
  // Whole-parent admission precedes selector lookup and I/O. Reuse only its inspected copy.
  const frontier = enumeratePolicyEvaluationDatasetReferences(context, checked, fixed.limits);
  const reference = frontier.references.find((value) => value.path === fixed.path);
  if (reference?.kind !== "endpoint_profile_selector" || checked.record.schemaVersion !== "0.2")
    throw new PolicyEvaluationModelEndpointInputError();
  // The owning enumerator establishes this exact canonical path and its bounded indices.
  const segments = reference.path.split("/");
  const interaction = checked.record.interactionCapture.interactions[Number(segments[3])];
  if (interaction?.kind !== "model") throw new PolicyEvaluationModelEndpointInputError();
  const attempt = interaction.attempts[Number(segments[5])];
  const configuration = checked.record.interactionCapture.artifacts.find(
    ({ contentReference }) =>
      contentReference.artifactId === attempt?.artifacts.providerConfigurationArtifactId,
  );
  if (
    !attempt ||
    !configuration ||
    reference.selector.endpointProfileId !== attempt.provider.endpointProfileId ||
    reference.selector.endpointProfileVersion !== attempt.provider.endpointProfileVersion
  )
    throw new PolicyEvaluationModelEndpointInputError();
  return { fixed, reference, frontier, attempt, configuration: configuration.contentReference };
}
type Prepared = ReturnType<typeof prepare>;

function inspect(prepared: Prepared, raw: unknown): Resolution {
  if (raw === null) return { status: "missing", evidence: null };
  let record: EndpointProfileRecord;
  try {
    record = validateEndpointProfileRecord(raw);
  } catch (cause) {
    if (!(cause instanceof InvalidEndpointProfileRecordError)) throw cause;
    return { status: "unavailable", reason: "record_invalid", evidence: null };
  }
  const source: PolicyEvaluationEndpointProfileSource = {
    kind: "endpoint_profile",
    reference: {
      ...prepared.reference.selector,
      definitionSha256: record.definitionSha256,
    },
  };
  const checked = inspectPolicyEvaluationEndpointProfileRecord(
    { source, scope: prepared.fixed.scope, evaluationTime: prepared.fixed.evaluationTime },
    record,
  );
  if (checked.observation.status === "unavailable")
    return { status: "unavailable", reason: checked.observation.reason, evidence: null };
  if (checked.observation.status !== "verified" || checked.record === null)
    throw new TypeError("Validated model endpoint lost its record");
  return {
    status: "resolved",
    evidence: { source: checked.source, record: checked.record, observation: checked.observation },
  };
}

function finish(
  prepared: Prepared,
  resolution: Resolution,
): PolicyEvaluationModelEndpointResolution {
  const record = resolution.status === "resolved" ? resolution.evidence.record : null;
  const matches: readonly (boolean | null)[] = record
    ? [
        record.provider === prepared.attempt.provider.name,
        record.operations.includes(prepared.attempt.provider.operation),
        record.boundaryKinds.includes("model"),
        Buffer.from(encodeEvaluationCanonicalJson(record.configuration)).equals(
          encodeEvaluationCanonicalJson(prepared.configuration),
        ),
      ]
    : [null, null, null, null];
  return {
    ...resolution,
    parent: { source: prepared.fixed.source, recordSha256: prepared.frontier.recordSha256 },
    reference: prepared.reference,
    inspectionUsage: {
      references: prepared.frontier.references.length,
      referenceBytes: prepared.frontier.referenceBytes,
    },
    checks: checkKinds.map((kind, index) => ({
      kind,
      observation: {
        status: matches[index] === null ? "unavailable" : matches[index] ? "matched" : "mismatch",
      },
    })),
  };
}

/** Fixed pure retained-data/context join; neither resolved nor matched is provider/seal authority. */
export function inspectPolicyEvaluationModelEndpointResolution(
  input: ReadPolicyEvaluationModelEndpointInput,
  evidence: PolicyEvaluationDatasetRead,
  raw: unknown,
): PolicyEvaluationModelEndpointResolution {
  const prepared = prepare(input, evidence);
  return finish(prepared, inspect(prepared, raw));
}

/** Full original parent/context admission before exact lookup; operational failures propagate. */
export async function readPolicyEvaluationModelEndpointResolution(
  input: ReadPolicyEvaluationModelEndpointInput,
  evidence: PolicyEvaluationDatasetRead,
  reader: EndpointProfileReader,
): Promise<PolicyEvaluationModelEndpointResolution> {
  const prepared = prepare(input, evidence);
  const raw = await reader.findEndpointProfile(
    structuredClone(prepared.fixed.scope),
    prepared.reference.selector.endpointProfileId,
    prepared.reference.selector.endpointProfileVersion,
  );
  return finish(prepared, inspect(prepared, raw));
}
