import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  encodeProtocolDefinition,
  type EvidenceScope,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type ProtocolDefinition,
  type ProtocolDefinitionRecord,
  ProtocolDefinitionRecordSchema,
  type ProtocolDefinitionSelector,
  ProtocolDefinitionSelectorSchema,
} from "@proofstack/contracts";

export class InvalidProtocolDefinitionRecordError extends TypeError {
  readonly code = "protocol_definition_record_invalid";
  constructor(options?: ErrorOptions) {
    super("Protocol definition record is invalid", options);
    this.name = "InvalidProtocolDefinitionRecordError";
  }
}

export function digestProtocolDefinition(
  scope: EvidenceScope,
  definition: ProtocolDefinition,
): string {
  return createHash("sha256").update(encodeProtocolDefinition({ scope, definition })).digest("hex");
}

/** Strict retained data integrity; neither a specification nor a principal ID proves authority. */
export function validateProtocolDefinitionRecord(raw: unknown): ProtocolDefinitionRecord {
  try {
    const record = ProtocolDefinitionRecordSchema.parse(raw);
    const {
      definitionSha256,
      registeredAt: _at,
      registeredByPrincipalId: _by,
      schemaVersion: _version,
      scope,
      ...definition
    } = record;
    if (digestProtocolDefinition(scope, definition) !== definitionSha256)
      throw new TypeError("Protocol definition digest mismatch");
    return record;
  } catch (cause) {
    throw new InvalidProtocolDefinitionRecordError({ cause });
  }
}

/** Complete original-record integrity, including registration receipts; not current authority. */
export function digestProtocolDefinitionRecord(raw: unknown): string {
  return createHash("sha256")
    .update(encodeEvaluationCanonicalJson(validateProtocolDefinitionRecord(raw)))
    .digest("hex");
}

export interface ProtocolDefinitionReader {
  findProtocolDefinition(scope: EvidenceScope, protocolDefinitionId: string): Promise<unknown>;
  /** All exact matches; no requested digest, latest lookup or dropping an ambiguous member. */
  listProtocolDefinitions(
    scope: EvidenceScope,
    selector: ProtocolDefinitionSelector,
  ): Promise<readonly unknown[]>;
}

export const MAX_STATIC_PROTOCOL_DEFINITIONS = 256;

function identity(scope: EvidenceScope, id: string): string {
  const owned = EvidenceScopeSchema.parse(scope);
  return JSON.stringify([
    owned.tenantId,
    owned.projectId,
    owned.environmentId,
    OpaqueIdSchema.parse(id),
  ]);
}
function mapping(scope: EvidenceScope, selector: ProtocolDefinitionSelector): string {
  return Buffer.from(
    encodeEvaluationCanonicalJson({
      scope: EvidenceScopeSchema.parse(scope),
      selector: ProtocolDefinitionSelectorSchema.parse(selector),
    }),
  ).toString("utf8");
}

/** Copied bounded operator data. Descriptor ambiguity is preserved, never selected away. */
export class StaticProtocolDefinitionCatalogue implements ProtocolDefinitionReader {
  readonly #records = new Map<string, ProtocolDefinitionRecord>();
  readonly #matches = new Map<string, ProtocolDefinitionRecord[]>();

  constructor(records: readonly unknown[]) {
    const count = records?.length;
    if (
      !Array.isArray(records) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_STATIC_PROTOCOL_DEFINITIONS
    )
      throw new TypeError("Protocol definition catalogue exceeds its entry limit");
    for (let index = 0; index < count; index++) {
      const record = validateProtocolDefinitionRecord(records[index]);
      const key = identity(record.scope, record.protocolDefinitionId);
      if (this.#records.has(key)) throw new TypeError("Duplicate protocol definition identity");
      this.#records.set(key, record);
      const selector = ProtocolDefinitionSelectorSchema.parse({
        family: record.family,
        descriptor: record.descriptor,
      });
      const selected = mapping(record.scope, selector);
      const matches = this.#matches.get(selected) ?? [];
      matches.push(record);
      this.#matches.set(selected, matches);
    }
    for (const matches of this.#matches.values())
      matches.sort((a, b) => (a.protocolDefinitionId < b.protocolDefinitionId ? -1 : 1));
  }

  async findProtocolDefinition(
    scope: EvidenceScope,
    protocolDefinitionId: string,
  ): Promise<ProtocolDefinitionRecord | null> {
    const record = this.#records.get(identity(scope, protocolDefinitionId));
    return record ? structuredClone(record) : null;
  }

  async listProtocolDefinitions(
    scope: EvidenceScope,
    selector: ProtocolDefinitionSelector,
  ): Promise<ProtocolDefinitionRecord[]> {
    return structuredClone(this.#matches.get(mapping(scope, selector)) ?? []);
  }
}
