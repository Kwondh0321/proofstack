import { createHash } from "node:crypto";
import {
  type EvaluationImplementationRegistrationDefinition,
  type EvaluationImplementationRegistrationRecord,
  EvaluationImplementationRegistrationRecordSchema,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationImplementationRegistration,
  OpaqueIdSchema,
} from "@proofstack/contracts";

export class InvalidEvaluationImplementationRegistrationError extends TypeError {
  readonly code = "evaluation_implementation_registration_invalid";

  constructor(options?: ErrorOptions) {
    super("Evaluation implementation registration is invalid", options);
    this.name = "InvalidEvaluationImplementationRegistrationError";
  }
}

export function digestEvaluationImplementationRegistration(
  scope: EvidenceScope,
  definition: EvaluationImplementationRegistrationDefinition,
): string {
  return createHash("sha256")
    .update(encodeEvaluationImplementationRegistration({ definition, scope }))
    .digest("hex");
}

/** Verifies retained data integrity, not loaded bytes, operator identity or qualification. */
export function validateEvaluationImplementationRegistrationRecord(
  raw: unknown,
): EvaluationImplementationRegistrationRecord {
  try {
    const record = EvaluationImplementationRegistrationRecordSchema.parse(raw);
    const {
      definitionSha256,
      registeredAt: _at,
      registeredByPrincipalId: _by,
      schemaVersion: _version,
      scope,
      ...definition
    } = record;
    if (digestEvaluationImplementationRegistration(scope, definition) !== definitionSha256)
      throw new TypeError("Evaluation implementation registration digest mismatch");
    return record;
  } catch (cause) {
    throw new InvalidEvaluationImplementationRegistrationError({ cause });
  }
}

export interface EvaluationImplementationRegistrationReader {
  findEvaluationImplementationRegistration(
    scope: EvidenceScope,
    implementationId: string,
    implementationVersionId: string,
  ): Promise<unknown>;
}

export const MAX_STATIC_EVALUATION_IMPLEMENTATION_REGISTRATIONS = 256;

function key(scope: EvidenceScope, implementationId: string, implementationVersionId: string) {
  const owned = EvidenceScopeSchema.parse(scope);
  return JSON.stringify([
    owned.tenantId,
    owned.projectId,
    owned.environmentId,
    OpaqueIdSchema.parse(implementationId),
    OpaqueIdSchema.parse(implementationVersionId),
  ]);
}

/**
 * Immutable installation-owned records, copied before entering a source transaction. Construct
 * independently of evaluation requests. No requested-hash fallback, execution or external I/O.
 * A matching declared registration is distinct from installed-code or current authority evidence.
 */
export class StaticEvaluationImplementationRegistrationCatalogue
  implements EvaluationImplementationRegistrationReader
{
  readonly #records = new Map<string, EvaluationImplementationRegistrationRecord>();

  constructor(records: readonly unknown[]) {
    const count = records?.length;
    if (
      !Array.isArray(records) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_STATIC_EVALUATION_IMPLEMENTATION_REGISTRATIONS
    )
      throw new TypeError(
        "Evaluation implementation registration catalogue exceeds its entry limit",
      );
    for (let index = 0; index < count; index++) {
      const record = validateEvaluationImplementationRegistrationRecord(records[index]);
      const identity = key(
        record.scope,
        record.implementation.implementationId,
        record.implementation.implementationVersionId,
      );
      if (this.#records.has(identity))
        throw new TypeError("Duplicate evaluation implementation registration identity");
      this.#records.set(identity, record);
    }
  }

  async findEvaluationImplementationRegistration(
    scope: EvidenceScope,
    implementationId: string,
    implementationVersionId: string,
  ): Promise<EvaluationImplementationRegistrationRecord | null> {
    const record = this.#records.get(key(scope, implementationId, implementationVersionId));
    return record ? structuredClone(record) : null;
  }
}
