import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  encodeRuntimeDefinition,
  type RuntimeDefinition,
  type RuntimeDefinitionRecord,
  RuntimeDefinitionRecordSchema,
} from "@proofstack/contracts";

export class InvalidRuntimeDefinitionRecordError extends TypeError {
  readonly code = "runtime_definition_record_invalid";
  constructor(options?: ErrorOptions) {
    super("Runtime definition record is invalid", options);
    this.name = "InvalidRuntimeDefinitionRecordError";
  }
}

export function digestRuntimeDefinition(
  scope: EvidenceScope,
  definition: RuntimeDefinition,
): string {
  return createHash("sha256").update(encodeRuntimeDefinition({ definition, scope })).digest("hex");
}

/** Fixed strict validation, including the semantic digest; not proof of installation or execution. */
export function validateRuntimeDefinitionRecord(raw: unknown): RuntimeDefinitionRecord {
  try {
    const record = RuntimeDefinitionRecordSchema.parse(raw);
    const {
      definitionSha256,
      registeredAt: _at,
      registeredByPrincipalId: _by,
      schemaVersion: _version,
      scope,
      ...definition
    } = record;
    if (digestRuntimeDefinition(scope, definition) !== definitionSha256)
      throw new TypeError("Runtime definition digest mismatch");
    return record;
  } catch (cause) {
    throw new InvalidRuntimeDefinitionRecordError({ cause });
  }
}
