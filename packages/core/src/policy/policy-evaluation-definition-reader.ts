import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
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
  Record extends { readonly createdAt: string; readonly scope: EvidenceScope },
>(
  input: PolicyEvaluationDefinitionReadInput<Source>,
  adapter: {
    readonly kinds: readonly Source["kind"][];
    readonly read: (scope: EvidenceScope, source: Source) => Promise<unknown>;
    readonly validate: (source: Source, raw: unknown) => Record;
    readonly isInvalidRecordError: (cause: unknown) => boolean;
  },
): Promise<PolicyEvaluationDefinitionRead<Record, Source>> {
  let captured: PolicyEvaluationDefinitionReadInput<Source>;
  try {
    if (Object.keys(input).some((key) => !["evaluationTime", "scope", "source"].includes(key))) {
      throw new TypeError("Unexpected acquisition input field");
    }
    const scope = EvidenceScopeSchema.parse(input.scope);
    const evaluationTime = PolicyEvaluationTimeSchema.parse(input.evaluationTime);
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    if (!adapter.kinds.includes(source.kind)) throw new TypeError("Unsupported source kind");
    captured = { evaluationTime, scope, source: source as Source };
  } catch (cause) {
    throw new PolicyEvaluationDefinitionReadInputError({ cause });
  }

  const { evaluationTime, scope, source } = captured;
  // A read port must not mutate the captured identity used for post-I/O validation.
  const raw = await adapter.read(structuredClone(scope), structuredClone(source));
  if (raw === null) return { observation: { status: "missing" }, record: null, source };
  let record: Record;
  try {
    record = adapter.validate(structuredClone(source), raw);
  } catch (cause) {
    if (!adapter.isInvalidRecordError(cause)) throw cause;
    return {
      observation: { reason: "record_invalid", status: "unavailable" },
      record: null,
      source,
    };
  }
  const fields = record as unknown as Readonly<{ [key: string]: unknown }>;
  if (
    record.scope.tenantId !== scope.tenantId ||
    record.scope.projectId !== scope.projectId ||
    record.scope.environmentId !== scope.environmentId ||
    !Object.entries(source.reference).every(
      ([key, value]) =>
        fields[key] !== undefined &&
        Buffer.from(encodeEvaluationCanonicalJson(fields[key])).equals(
          encodeEvaluationCanonicalJson(value),
        ),
    )
  ) {
    return {
      observation: { reason: "reference_mismatch", status: "unavailable" },
      record: null,
      source,
    };
  }
  if (
    policyEvaluationTimestampOrderKey(record.createdAt) >
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
      recordSha256: createHash("sha256")
        .update(encodeEvaluationCanonicalJson(record))
        .digest("hex"),
      status: "verified",
    },
    record,
    source,
  };
}
