import { createHash } from "node:crypto";
import {
  type EndpointProfileDefinition,
  type EndpointProfileRecord,
  EndpointProfileRecordSchema,
  EndpointProfileReferenceSchema,
  encodeEndpointProfile,
  type EvidenceScope,
  EvidenceScopeSchema,
} from "@proofstack/contracts";

export class InvalidEndpointProfileRecordError extends TypeError {
  readonly code = "endpoint_profile_record_invalid";

  constructor(options?: ErrorOptions) {
    super("Endpoint profile record is invalid", options);
    this.name = "InvalidEndpointProfileRecordError";
  }
}

export function digestEndpointProfile(
  scope: EvidenceScope,
  definition: EndpointProfileDefinition,
): string {
  return createHash("sha256").update(encodeEndpointProfile({ scope, definition })).digest("hex");
}

/** Owning data integrity only; does not authenticate provider or registering principal. */
export function validateEndpointProfileRecord(raw: unknown): EndpointProfileRecord {
  try {
    const record = EndpointProfileRecordSchema.parse(raw);
    const {
      definitionSha256,
      registeredAt: _at,
      registeredByPrincipalId: _by,
      schemaVersion: _version,
      scope,
      ...definition
    } = record;
    if (digestEndpointProfile(scope, definition) !== definitionSha256)
      throw new TypeError("Endpoint profile digest mismatch");
    return record;
  } catch (cause) {
    throw new InvalidEndpointProfileRecordError({ cause });
  }
}

export interface EndpointProfileReader {
  findEndpointProfile(
    scope: EvidenceScope,
    endpointProfileId: string,
    endpointProfileVersion: string,
  ): Promise<unknown>;
}

export const MAX_STATIC_ENDPOINT_PROFILES = 256;

function key(scope: EvidenceScope, id: string, version: string) {
  const owned = EvidenceScopeSchema.parse(scope);
  return JSON.stringify([
    owned.tenantId,
    owned.projectId,
    owned.environmentId,
    EndpointProfileReferenceSchema.shape.endpointProfileId.parse(id),
    EndpointProfileReferenceSchema.shape.endpointProfileVersion.parse(version),
  ]);
}

/** Independent copied installation data, with no latest/digest lookup, network or credential port. */
export class StaticEndpointProfileCatalogue implements EndpointProfileReader {
  readonly #records = new Map<string, EndpointProfileRecord>();

  constructor(records: readonly unknown[]) {
    const count = records?.length;
    if (
      !Array.isArray(records) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_STATIC_ENDPOINT_PROFILES
    )
      throw new TypeError("Endpoint profile catalogue exceeds its entry limit");
    for (let index = 0; index < count; index++) {
      const record = validateEndpointProfileRecord(records[index]);
      const identity = key(record.scope, record.endpointProfileId, record.endpointProfileVersion);
      if (this.#records.has(identity)) throw new TypeError("Duplicate endpoint profile identity");
      this.#records.set(identity, record);
    }
  }

  async findEndpointProfile(
    scope: EvidenceScope,
    endpointProfileId: string,
    endpointProfileVersion: string,
  ): Promise<EndpointProfileRecord | null> {
    const record = this.#records.get(key(scope, endpointProfileId, endpointProfileVersion));
    return record ? structuredClone(record) : null;
  }
}
