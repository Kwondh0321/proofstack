import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";

export interface PolicyEvaluationDefinitionReadInput<
  Source extends PolicyEvaluationSourceReference,
> {
  readonly evaluationTime: string;
  readonly scope: EvidenceScope;
  readonly source: Source;
}

export type PolicyEvaluationDefinitionRead<
  Record,
  Source extends PolicyEvaluationSourceReference,
> = {
  readonly source: Source;
} & (
  | {
      readonly observation: { readonly recordSha256: string; readonly status: "verified" };
      readonly record: Record;
    }
  | {
      readonly observation: Exclude<
        PolicyEvaluationManifestEntry["observation"],
        { readonly status: "verified" }
      >;
      readonly record: null;
    }
);

/** A retained full body is separate from availability at the semantic evaluation time. */
export interface PolicyEvaluationDefinitionCapture<
  Record,
  Source extends PolicyEvaluationSourceReference,
> {
  readonly read: PolicyEvaluationDefinitionRead<Record, Source>;
  readonly storage: {
    readonly record: Record;
    readonly recordSha256: string;
    readonly receiptTime: string;
  } | null;
}

export class PolicyEvaluationDefinitionReadInputError extends TypeError {
  readonly code = "policy_evaluation_definition_read_input_invalid";

  constructor(options?: ErrorOptions) {
    super(
      "Definition acquisition requires an exact supported source, scope, and UTC time",
      options,
    );
    this.name = "PolicyEvaluationDefinitionReadInputError";
  }
}

/** Fixed, trusted domain validation; never accept this adapter from an external request. */
export type PolicyEvaluationDefinitionValidator<
  Source extends PolicyEvaluationSourceReference,
  Record extends { readonly scope: EvidenceScope },
> = {
  readonly kinds: readonly Source["kind"][];
  readonly validate: (source: Source, raw: unknown) => Record;
  readonly isInvalidRecordError: (cause: unknown) => boolean;
  /** Fixed domain receipt selection, never a caller-selected semantic/effective time. */
  readonly receiptTime?: (record: Record) => string;
} & ([Record] extends [{ readonly createdAt: string }]
  ? unknown
  : { readonly receiptTime: (record: Record) => string });

/**
 * Internal acquisition primitive for domain-owned adapters, not a plugin or authorization API.
 * The adapter's fixed validator MUST strictly parse and recompute the semantic definition digest;
 * only its recognized invalid-record errors may be classified as unavailable. This helper checks
 * every reference field (including nested protocol identities), scope, and receipt time, then
 * hashes the complete validated record.
 * Recursive dependencies, retained bytes, cumulative budgets, and guarded sealing remain separate.
 */
export async function readPolicyEvaluationDefinitionRecord<
  Source extends PolicyEvaluationSourceReference,
  Record extends { readonly scope: EvidenceScope },
>(
  input: PolicyEvaluationDefinitionReadInput<Source>,
  adapter: PolicyEvaluationDefinitionValidator<Source, Record> & {
    readonly read: (scope: EvidenceScope, source: Source) => Promise<unknown>;
  },
): Promise<PolicyEvaluationDefinitionRead<Record, Source>> {
  const captured = captureInput(input, adapter.kinds);
  // A read port must not mutate the captured identity used for post-I/O validation.
  const raw = await adapter.read(structuredClone(captured.scope), structuredClone(captured.source));
  return inspectCapturedRecord(captured, raw, adapter);
}

/**
 * Revalidates one materialized record without repository I/O. The caller must independently bind
 * this new observation to the captured source and full-record hash before expanding dependencies.
 * A supplied null describes absence only; this function cannot establish repository completeness.
 */
export function inspectPolicyEvaluationDefinitionRecord<
  Source extends PolicyEvaluationSourceReference,
  Record extends { readonly scope: EvidenceScope },
>(
  input: PolicyEvaluationDefinitionReadInput<Source>,
  raw: unknown,
  adapter: PolicyEvaluationDefinitionValidator<Source, Record>,
): PolicyEvaluationDefinitionRead<Record, Source> {
  return inspectCapturedRecord(captureInput(input, adapter.kinds), raw, adapter);
}

/**
 * Retains a validated exact body and its full receipt hash even when it is not yet available.
 * Storage is not verified semantic evidence, acquisition authority, or a sealed observation.
 */
export function inspectPolicyEvaluationDefinitionCapture<
  Source extends PolicyEvaluationSourceReference,
  Record extends { readonly scope: EvidenceScope },
>(
  input: PolicyEvaluationDefinitionReadInput<Source>,
  raw: unknown,
  adapter: PolicyEvaluationDefinitionValidator<Source, Record>,
): PolicyEvaluationDefinitionCapture<Record, Source> {
  return captureRecord(captureInput(input, adapter.kinds), raw, adapter);
}

/** Fixed owning adapters use the same acquisition and validation as ordinary temporal reads. */
export async function readPolicyEvaluationDefinitionCapture<
  Source extends PolicyEvaluationSourceReference,
  Record extends { readonly scope: EvidenceScope },
>(
  input: PolicyEvaluationDefinitionReadInput<Source>,
  adapter: PolicyEvaluationDefinitionValidator<Source, Record> & {
    readonly read: (scope: EvidenceScope, source: Source) => Promise<unknown>;
  },
): Promise<PolicyEvaluationDefinitionCapture<Record, Source>> {
  const captured = captureInput(input, adapter.kinds);
  const raw = await adapter.read(structuredClone(captured.scope), structuredClone(captured.source));
  return captureRecord(captured, raw, adapter);
}

function captureInput<Source extends PolicyEvaluationSourceReference>(
  input: PolicyEvaluationDefinitionReadInput<Source>,
  kinds: readonly Source["kind"][],
): PolicyEvaluationDefinitionReadInput<Source> {
  try {
    if (Object.keys(input).some((key) => !["evaluationTime", "scope", "source"].includes(key))) {
      throw new TypeError("Unexpected acquisition input field");
    }
    const scope = EvidenceScopeSchema.parse(input.scope);
    const evaluationTime = PolicyEvaluationTimeSchema.parse(input.evaluationTime);
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    if (!kinds.includes(source.kind)) throw new TypeError("Unsupported source kind");
    return { evaluationTime, scope, source: source as Source };
  } catch (cause) {
    throw new PolicyEvaluationDefinitionReadInputError({ cause });
  }
}

function inspectCapturedRecord<
  Source extends PolicyEvaluationSourceReference,
  Record extends { readonly scope: EvidenceScope },
>(
  context: PolicyEvaluationDefinitionReadInput<Source>,
  raw: unknown,
  adapter: PolicyEvaluationDefinitionValidator<Source, Record>,
): PolicyEvaluationDefinitionRead<Record, Source> {
  return temporalRead(context, inspectStoredRecord(context, raw, adapter));
}

type StoredMaterial<Record> =
  | { readonly status: "retained"; readonly record: Record; readonly receiptTime: string }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly reason: "record_invalid" | "reference_mismatch" };

function inspectStoredRecord<
  Source extends PolicyEvaluationSourceReference,
  Record extends { readonly scope: EvidenceScope },
>(
  { scope, source }: PolicyEvaluationDefinitionReadInput<Source>,
  raw: unknown,
  adapter: PolicyEvaluationDefinitionValidator<Source, Record>,
): StoredMaterial<Record> {
  if (raw === null) return { status: "missing" };
  let record: Record;
  try {
    record = adapter.validate(structuredClone(source), raw);
  } catch (cause) {
    if (!adapter.isInvalidRecordError(cause)) throw cause;
    return { reason: "record_invalid", status: "unavailable" };
  }
  const fields = record as unknown as Readonly<{ [key: string]: unknown }>;
  if (
    record.scope.tenantId !== scope.tenantId ||
    record.scope.projectId !== scope.projectId ||
    record.scope.environmentId !== scope.environmentId ||
    !Object.entries(source.reference).every(
      ([key, value]) =>
        fields[key] !== undefined &&
        serializeEvaluationCanonicalJson(fields[key]) === serializeEvaluationCanonicalJson(value),
    )
  ) {
    return { reason: "reference_mismatch", status: "unavailable" };
  }
  const receiptTime =
    adapter.receiptTime === undefined ? fields["createdAt"] : adapter.receiptTime(record);
  if (typeof receiptTime !== "string") {
    throw new TypeError("Validated policy evaluation record omitted its receipt time");
  }
  return { status: "retained", record, receiptTime };
}

function hashRecord(record: unknown): string {
  return createHash("sha256")
    .update(serializeEvaluationCanonicalJson(record), "utf8")
    .digest("hex");
}

function temporalRead<Source extends PolicyEvaluationSourceReference, Record>(
  { evaluationTime, source }: PolicyEvaluationDefinitionReadInput<Source>,
  material: StoredMaterial<Record>,
  recordSha256?: string,
): PolicyEvaluationDefinitionRead<Record, Source> {
  if (material.status !== "retained") return { observation: material, record: null, source };
  if (
    policyEvaluationTimestampOrderKey(material.receiptTime) >
    policyEvaluationTimestampOrderKey(evaluationTime)
  ) {
    return {
      observation: { reason: "not_yet_available", status: "unavailable" },
      record: null,
      source,
    };
  }
  return {
    observation: {
      recordSha256: recordSha256 ?? hashRecord(material.record),
      status: "verified",
    },
    record: material.record,
    source,
  };
}

function captureRecord<
  Source extends PolicyEvaluationSourceReference,
  Record extends { readonly scope: EvidenceScope },
>(
  context: PolicyEvaluationDefinitionReadInput<Source>,
  raw: unknown,
  adapter: PolicyEvaluationDefinitionValidator<Source, Record>,
): PolicyEvaluationDefinitionCapture<Record, Source> {
  const material = inspectStoredRecord(context, raw, adapter);
  if (material.status !== "retained")
    return { read: temporalRead(context, material), storage: null };
  // Validate the original receipt even when storage is retained independently of semantic time.
  policyEvaluationTimestampOrderKey(material.receiptTime);
  const recordSha256 = hashRecord(material.record);
  return {
    read: temporalRead(context, material, recordSha256),
    storage: {
      record: structuredClone(material.record),
      recordSha256,
      receiptTime: material.receiptTime,
    },
  };
}
