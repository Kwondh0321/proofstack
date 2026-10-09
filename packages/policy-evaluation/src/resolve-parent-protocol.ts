import {
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
  type ProtocolDefinitionRecord,
  type ProtocolDefinitionSelector,
  ProtocolDefinitionSelectorSchema,
} from "@proofstack/contracts";
import {
  InvalidProtocolDefinitionRecordError,
  MAX_STATIC_PROTOCOL_DEFINITIONS,
  type PolicyEvaluationEvidenceReference,
  type PolicyEvaluationEvidenceReferenceLimits,
  type PolicyEvaluationProtocolRead,
  type ProtocolDefinitionReader,
  inspectPolicyEvaluationProtocolRecord,
  validateProtocolDefinitionRecord,
  digestProtocolDefinitionRecord,
} from "@proofstack/core";
import { enumerateCapturedPolicyRecord, type PolicyRecordRead } from "./record-routing.js";

export type PolicyProtocolParentSource = Extract<
  PolicyEvaluationSourceReference,
  {
    readonly kind:
      | "regression_fixture_version"
      | "replay_plan"
      | "target_release"
      | "replay_result"
      | "runtime_adapter";
  }
>;
export interface PolicyProtocolResolutionInput {
  readonly scope: EvidenceScope;
  readonly evaluationTime: string;
  readonly source: PolicyProtocolParentSource;
  readonly path: string;
  readonly limits: PolicyEvaluationEvidenceReferenceLimits;
  readonly replayLimits: { readonly maximumRecords: number; readonly maximumRecordBytes: number };
}

export class PolicyProtocolResolutionInputError extends TypeError {
  readonly code = "policy_protocol_resolution_input_invalid";
  constructor(options?: ErrorOptions) {
    super("Expected a complete original parent and exact owned protocol occurrence", options);
    this.name = "PolicyProtocolResolutionInputError";
  }
}

export type PolicyProtocolMatch =
  | { readonly index: number; readonly status: "invalid"; readonly reason: "record_invalid" }
  | {
      readonly index: number;
      readonly status: "retained";
      /** Valid original data is retained even when unavailable at the requested cut. */
      readonly record: ProtocolDefinitionRecord;
      readonly recordSha256: string;
      readonly descriptorMatched: boolean;
      readonly read: PolicyEvaluationProtocolRead;
    };
type Outcome =
  | { readonly status: "missing" | "unique" | "multiple" }
  | {
      readonly status: "unavailable";
      readonly reason: "record_invalid" | "reference_mismatch" | "not_yet_available";
    };
export type PolicyProtocolResolution = Outcome & {
  readonly parent: { readonly source: PolicyProtocolParentSource; readonly recordSha256: string };
  readonly reference: PolicyEvaluationEvidenceReference;
  readonly selector: ProtocolDefinitionSelector;
  /** Complete ordered lookup response; no dropping unavailable members to pick a winner. */
  readonly matches: readonly PolicyProtocolMatch[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
};

function same(left: unknown, right: unknown) {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

/** Family is derived only from a reference re-enumerated at its fixed owning parent position. */
function selector(
  source: PolicyProtocolParentSource,
  reference: PolicyEvaluationEvidenceReference,
): ProtocolDefinitionSelector {
  if (reference.kind === "protocol_declaration") {
    let family: "capture_adapter" | "source_format" | "request_normalizer" | "runtime_protocol";
    if (source.kind === "runtime_adapter" && reference.path === "/protocol")
      family = "runtime_protocol";
    else if (source.kind === "regression_fixture_version") {
      if (reference.path === "/interactionCapture/source/captureAdapter")
        family = "capture_adapter";
      else if (reference.path === "/interactionCapture/source/sourceFormat")
        family = "source_format";
      else if (
        /^\/interactionCapture\/interactions\/(0|[1-9]\d*)\/attempts\/(0|[1-9]\d*)\/normalizedRequest$/u.test(
          reference.path,
        )
      )
        family = "request_normalizer";
      else throw new PolicyProtocolResolutionInputError();
    } else throw new PolicyProtocolResolutionInputError();
    return ProtocolDefinitionSelectorSchema.parse({ family, descriptor: reference.reference });
  }
  if (reference.kind === "replay_declaration") {
    const declaration = reference.declaration;
    if (source.kind === "replay_plan" && declaration.kind === "recorded_adapter")
      return ProtocolDefinitionSelectorSchema.parse({
        family: "recorded_target_adapter",
        descriptor: declaration.reference,
      });
    if (source.kind === "target_release" && declaration.kind === "target_adapter")
      return ProtocolDefinitionSelectorSchema.parse({
        family: "released_target_adapter",
        descriptor: declaration.reference,
      });
    if (
      ["replay_plan", "target_release", "replay_result"].includes(source.kind) &&
      declaration.kind === "worker_protocol"
    )
      return ProtocolDefinitionSelectorSchema.parse({
        family: "worker_protocol",
        descriptor: declaration.reference,
      });
  }
  throw new PolicyProtocolResolutionInputError();
}

function prepare(input: PolicyProtocolResolutionInput, evidence: PolicyRecordRead) {
  let fixed: PolicyProtocolResolutionInput;
  try {
    if (
      !input ||
      Object.keys(input).some(
        (key) =>
          !["scope", "evaluationTime", "source", "path", "limits", "replayLimits"].includes(key),
      )
    )
      throw new TypeError("Unexpected protocol resolution field");
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    if (
      ![
        "regression_fixture_version",
        "replay_plan",
        "target_release",
        "replay_result",
        "runtime_adapter",
      ].includes(source.kind) ||
      typeof input.path !== "string" ||
      !input.path.startsWith("/") ||
      input.path.length > 1024
    )
      throw new TypeError("Unsupported protocol parent or path");
    const { maximumRecords, maximumRecordBytes } = input.replayLimits;
    if (
      Object.keys(input.replayLimits).some(
        (key) => !["maximumRecords", "maximumRecordBytes"].includes(key),
      ) ||
      !Number.isSafeInteger(maximumRecords) ||
      maximumRecords < 2 ||
      maximumRecords > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS ||
      !Number.isSafeInteger(maximumRecordBytes) ||
      maximumRecordBytes < 1 ||
      maximumRecordBytes > MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES
    )
      throw new TypeError("Invalid retained replay limits");
    fixed = {
      source: source as PolicyProtocolParentSource,
      scope: EvidenceScopeSchema.parse(input.scope),
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
      path: input.path,
      limits: structuredClone(input.limits),
      replayLimits: { maximumRecords, maximumRecordBytes },
    };
  } catch (cause) {
    throw new PolicyProtocolResolutionInputError({ cause });
  }
  // The fixed dispatcher revalidates every whole original body, reference and full receipt hash.
  // No requester-selected validators; whole-parent bounded admission precedes lookup/I/O.
  const frontier = enumerateCapturedPolicyRecord(fixed, evidence, fixed.limits, fixed.replayLimits);
  const reference = frontier.references.find((value) => value.path === fixed.path);
  if (!reference) throw new PolicyProtocolResolutionInputError();
  return { fixed, frontier, reference, selector: selector(fixed.source, reference) };
}
type Prepared = ReturnType<typeof prepare>;

/** Classification only; the fixed resolver still validates the entire owning parent and position. */
export function isResolvableProtocolReference(
  reference: PolicyEvaluationEvidenceReference,
): boolean {
  return (
    reference.kind === "protocol_declaration" ||
    (reference.kind === "replay_declaration" &&
      ["recorded_adapter", "target_adapter", "worker_protocol"].includes(
        reference.declaration.kind,
      ))
  );
}

function inspect(prepared: Prepared, raw: unknown): PolicyProtocolResolution {
  if (!Array.isArray(raw) || raw.length > MAX_STATIC_PROTOCOL_DEFINITIONS)
    throw new TypeError("Expected a bounded complete protocol match array");
  const identities = new Set<string>();
  const matches: PolicyProtocolMatch[] = Array.from({ length: raw.length }, (_, index) => {
    const value: unknown = raw[index];
    let record: ProtocolDefinitionRecord;
    try {
      record = validateProtocolDefinitionRecord(value);
    } catch (cause) {
      if (!(cause instanceof InvalidProtocolDefinitionRecordError)) throw cause;
      return { index, status: "invalid", reason: "record_invalid" };
    }
    if (identities.has(record.protocolDefinitionId))
      throw new TypeError("Duplicate protocol match storage identity");
    identities.add(record.protocolDefinitionId);
    const source = {
      kind: "protocol_definition" as const,
      reference: {
        protocolDefinitionId: record.protocolDefinitionId,
        definitionSha256: record.definitionSha256,
      },
    };
    return {
      index,
      status: "retained",
      record,
      recordSha256: digestProtocolDefinitionRecord(record),
      descriptorMatched: same(
        { family: record.family, descriptor: record.descriptor },
        prepared.selector,
      ),
      read: inspectPolicyEvaluationProtocolRecord(
        { source, scope: prepared.fixed.scope, evaluationTime: prepared.fixed.evaluationTime },
        record,
      ),
    };
  });
  let outcome: Outcome;
  if (matches.some((member) => member.status === "invalid"))
    outcome = { status: "unavailable", reason: "record_invalid" };
  else if (
    matches.some(
      (member) =>
        member.status === "retained" &&
        (!member.descriptorMatched ||
          (member.read.observation.status === "unavailable" &&
            member.read.observation.reason === "reference_mismatch")),
    )
  )
    outcome = { status: "unavailable", reason: "reference_mismatch" };
  else if (matches.length === 0) outcome = { status: "missing" };
  else if (matches.length > 1) outcome = { status: "multiple" };
  else if (
    matches.some(
      (member) => member.status === "retained" && member.read.observation.status !== "verified",
    )
  )
    outcome = { status: "unavailable", reason: "not_yet_available" };
  else outcome = { status: "unique" };
  return {
    ...outcome,
    parent: { source: prepared.fixed.source, recordSha256: prepared.frontier.recordSha256 },
    reference: prepared.reference,
    selector: prepared.selector,
    matches,
    inspectionUsage: {
      references: prepared.frontier.references.length,
      referenceBytes: prepared.frontier.referenceBytes,
    },
  };
}

/** Fixed materialized declaration join; no lookup, compatibility, current authority or seal. */
export function inspectParentProtocolResolution(
  input: PolicyProtocolResolutionInput,
  evidence: PolicyRecordRead,
  raw: unknown,
): PolicyProtocolResolution {
  return inspect(prepare(input, evidence), raw);
}

/** Complete whole-parent admission before an exact family/descriptor list read. */
export async function readParentProtocolResolution(
  input: PolicyProtocolResolutionInput,
  evidence: PolicyRecordRead,
  reader: Pick<ProtocolDefinitionReader, "listProtocolDefinitions">,
): Promise<PolicyProtocolResolution> {
  const prepared = prepare(input, evidence);
  const raw = await reader.listProtocolDefinitions(
    structuredClone(prepared.fixed.scope),
    structuredClone(prepared.selector),
  );
  return inspect(prepared, raw);
}
