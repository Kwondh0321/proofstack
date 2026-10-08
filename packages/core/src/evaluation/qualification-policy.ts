import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeQualificationPolicy,
  OpaqueIdSchema,
  type QualificationPolicyDefinition,
  type QualificationPolicyRecord,
  QualificationPolicyRecordSchema,
} from "@proofstack/contracts";

export class InvalidQualificationPolicyRecordError extends TypeError {
  readonly code = "qualification_policy_record_invalid";

  constructor(options?: ErrorOptions) {
    super("Qualification policy record is invalid", options);
    this.name = "InvalidQualificationPolicyRecordError";
  }
}

export function digestQualificationPolicy(
  scope: EvidenceScope,
  definition: QualificationPolicyDefinition,
): string {
  return createHash("sha256")
    .update(encodeQualificationPolicy({ scope, definition }))
    .digest("hex");
}

/** Owning data integrity only; no registering-principal authentication or qualification verdict. */
export function validateQualificationPolicyRecord(raw: unknown): QualificationPolicyRecord {
  try {
    const record = QualificationPolicyRecordSchema.parse(raw);
    const {
      definitionSha256,
      publishedAt: _at,
      publishedByPrincipalId: _by,
      schemaVersion: _version,
      scope,
      ...definition
    } = record;
    if (digestQualificationPolicy(scope, definition) !== definitionSha256)
      throw new TypeError("Qualification policy digest mismatch");
    return record;
  } catch (cause) {
    throw new InvalidQualificationPolicyRecordError({ cause });
  }
}

export interface QualificationPolicyReader {
  findQualificationPolicy(
    scope: EvidenceScope,
    policyId: string,
    policyVersionId: string,
  ): Promise<unknown>;
}

export const MAX_STATIC_QUALIFICATION_POLICIES = 256;

function key(scope: EvidenceScope, policyId: string, policyVersionId: string) {
  const owned = EvidenceScopeSchema.parse(scope);
  return JSON.stringify([
    owned.tenantId,
    owned.projectId,
    owned.environmentId,
    OpaqueIdSchema.parse(policyId),
    OpaqueIdSchema.parse(policyVersionId),
  ]);
}

/**
 * Independent installation data copied before transaction entry. Exact lookup never constructs
 * requested policies, chooses a latest version, loads code or authenticates current authority.
 */
export class StaticQualificationPolicyCatalogue implements QualificationPolicyReader {
  readonly #records = new Map<string, QualificationPolicyRecord>();

  constructor(records: readonly unknown[]) {
    const count = records?.length;
    if (
      !Array.isArray(records) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_STATIC_QUALIFICATION_POLICIES
    )
      throw new TypeError("Qualification policy catalogue exceeds its entry limit");
    for (let index = 0; index < count; index++) {
      const record = validateQualificationPolicyRecord(records[index]);
      const identity = key(record.scope, record.policyId, record.policyVersionId);
      if (this.#records.has(identity))
        throw new TypeError("Duplicate qualification policy identity");
      this.#records.set(identity, record);
    }
  }

  async findQualificationPolicy(
    scope: EvidenceScope,
    policyId: string,
    policyVersionId: string,
  ): Promise<QualificationPolicyRecord | null> {
    const record = this.#records.get(key(scope, policyId, policyVersionId));
    return record ? structuredClone(record) : null;
  }
}
