import {
  type EvidenceScope,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  ReplayRuntimeProfileReferenceSchema,
  type RuntimeDefinitionKind,
  type RuntimeDefinitionRecord,
} from "@proofstack/contracts";
import { validateRuntimeDefinitionRecord } from "./runtime-definition-record.js";

export interface RuntimeDefinitionReader {
  findRuntimeProfile(scope: EvidenceScope, id: string, version: string): Promise<unknown>;
  findIsolationProfile(scope: EvidenceScope, id: string, version: string): Promise<unknown>;
  findRuntimeAdapter(scope: EvidenceScope, adapterVersionId: string): Promise<unknown>;
}

export const MAX_STATIC_RUNTIME_DEFINITIONS = 256;

function key(
  scope: EvidenceScope,
  kind: RuntimeDefinitionKind,
  id: string,
  version?: string,
): string {
  const parsed = EvidenceScopeSchema.parse(scope);
  const identity = OpaqueIdSchema.parse(id);
  const exactVersion =
    kind === "runtime_adapter"
      ? null
      : ReplayRuntimeProfileReferenceSchema.shape.version.parse(version);
  return JSON.stringify([
    parsed.tenantId,
    parsed.projectId,
    parsed.environmentId,
    kind,
    identity,
    exactVersion,
  ]);
}

/**
 * One immutable operator-owned catalogue copy. Construct at the installation boundary, never from
 * an evaluation request. No fallback to requested hashes, external discovery, or executable code.
 * It stores records, not approval, artifact availability, live installation, or OS attestation.
 */
export class StaticRuntimeDefinitionCatalogue implements RuntimeDefinitionReader {
  readonly #records = new Map<string, RuntimeDefinitionRecord>();

  constructor(records: readonly unknown[]) {
    const count = records?.length;
    if (
      !Array.isArray(records) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_STATIC_RUNTIME_DEFINITIONS
    )
      throw new TypeError("Runtime definition catalogue exceeds its entry limit");
    for (let index = 0; index < count; index++) {
      const record = validateRuntimeDefinitionRecord(records[index]);
      const identity =
        record.recordKind === "runtime_adapter"
          ? key(record.scope, record.recordKind, record.adapterVersionId)
          : key(record.scope, record.recordKind, record.id, record.version);
      if (this.#records.has(identity)) throw new TypeError("Duplicate runtime definition identity");
      this.#records.set(identity, record);
    }
  }

  async findRuntimeProfile(
    scope: EvidenceScope,
    id: string,
    version: string,
  ): Promise<RuntimeDefinitionRecord | null> {
    return this.#find(key(scope, "replay_runtime_profile", id, version));
  }

  async findIsolationProfile(
    scope: EvidenceScope,
    id: string,
    version: string,
  ): Promise<RuntimeDefinitionRecord | null> {
    return this.#find(key(scope, "replay_isolation_profile", id, version));
  }

  async findRuntimeAdapter(
    scope: EvidenceScope,
    adapterVersionId: string,
  ): Promise<RuntimeDefinitionRecord | null> {
    return this.#find(key(scope, "runtime_adapter", adapterVersionId));
  }

  #find(identity: string): RuntimeDefinitionRecord | null {
    const record = this.#records.get(identity);
    return record ? structuredClone(record) : null;
  }
}
