import { OpaqueIdSchema } from "@proofstack/contracts";
import {
  artifactMaintenanceScope,
  type ArtifactMaintenanceScopeCommand,
} from "./artifact-maintenance-support.js";
import type {
  ArtifactCatalogRepository,
  ArtifactKeyInventory,
  ArtifactKeyReferenceCounts,
  ArtifactKeyReferenceSummary,
} from "./artifact-ports.js";
import { InvalidArtifactLifecycleInputError } from "./errors.js";

const EMPTY_REFERENCE_COUNTS: ArtifactKeyReferenceCounts = {
  available: 0,
  purged: 0,
  reserved: 0,
  tombstoned: 0,
  total: 0,
};

export interface ArtifactKeyStatus extends ArtifactKeyReferenceSummary {
  readonly active: boolean;
  readonly configured: boolean;
}

export interface InspectArtifactKeyReferencesResult {
  readonly activeKeyId: string;
  readonly keys: readonly ArtifactKeyStatus[];
}

export interface InspectArtifactKeyReferencesDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly keys: ArtifactKeyInventory;
}

function invalidStatus(): never {
  throw new InvalidArtifactLifecycleInputError("Artifact key reference status is invalid");
}

interface StatusRecord extends Record<string, unknown> {
  available?: unknown;
  counts?: unknown;
  keyId?: unknown;
  purged?: unknown;
  reserved?: unknown;
  tombstoned?: unknown;
  total?: unknown;
}

function isRecord(value: unknown): value is StatusRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function referenceSummary(value: unknown): ArtifactKeyReferenceSummary {
  if (!isRecord(value) || !OpaqueIdSchema.safeParse(value.keyId).success) invalidStatus();
  const counts = value.counts;
  if (!isRecord(counts)) invalidStatus();
  const available = counts.available;
  const purged = counts.purged;
  const reserved = counts.reserved;
  const tombstoned = counts.tombstoned;
  const total = counts.total;
  if (
    !validCount(available) ||
    !validCount(purged) ||
    !validCount(reserved) ||
    !validCount(tombstoned) ||
    !validCount(total) ||
    total !== available + purged + reserved + tombstoned
  ) {
    invalidStatus();
  }
  return {
    counts: { available, purged, reserved, tombstoned, total },
    keyId: String(value.keyId),
  };
}

export class InspectArtifactKeyReferences {
  constructor(private readonly dependencies: InspectArtifactKeyReferencesDependencies) {}

  async execute(
    command: ArtifactMaintenanceScopeCommand,
  ): Promise<InspectArtifactKeyReferencesResult> {
    const scope = artifactMaintenanceScope(command);
    const [activeKeyId, configuredKeyIds, referenceValues]: readonly unknown[] = await Promise.all([
      this.dependencies.keys.activeKeyId(),
      this.dependencies.keys.configuredKeyIds(),
      this.dependencies.catalog.listKeyReferences(scope),
    ]);
    if (
      !OpaqueIdSchema.safeParse(activeKeyId).success ||
      !Array.isArray(configuredKeyIds) ||
      !Array.isArray(referenceValues)
    ) {
      invalidStatus();
    }

    const configured = new Set<string>();
    for (const keyId of configuredKeyIds) {
      if (!OpaqueIdSchema.safeParse(keyId).success || configured.has(String(keyId))) {
        invalidStatus();
      }
      configured.add(String(keyId));
    }
    if (!configured.has(String(activeKeyId))) invalidStatus();

    const references = new Map<string, ArtifactKeyReferenceCounts>();
    for (const value of referenceValues) {
      const summary = referenceSummary(value);
      if (references.has(summary.keyId)) invalidStatus();
      references.set(summary.keyId, summary.counts);
    }

    const keyIds = new Set([...configured, ...references.keys()]);
    return {
      activeKeyId: String(activeKeyId),
      keys: [...keyIds]
        .sort((left, right) => left.localeCompare(right))
        .map((keyId) => ({
          active: keyId === activeKeyId,
          configured: configured.has(keyId),
          counts: { ...(references.get(keyId) ?? EMPTY_REFERENCE_COUNTS) },
          keyId,
        })),
    };
  }
}
