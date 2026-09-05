import { createHash } from "node:crypto";
import {
  ComparisonDefinitionRecordSchema,
  ComparisonEvidenceSnapshotSchema,
  ComparisonResultSchema,
  encodeComparisonDefinition,
  encodeComparisonEvidenceSnapshotDefinition,
  encodeComparisonResultDefinition,
  type EvidenceScope,
} from "@proofstack/contracts";
import {
  ComparisonRepositoryContractError,
  InvalidComparisonRecordInputError,
} from "./comparison-repository-errors.js";
import type { ComparisonRecord, ComparisonRecordKind } from "./comparison-repository.js";

interface ComparisonRecordBase {
  readonly definitionSha256: string;
  readonly scope: EvidenceScope;
}

interface ComparisonRecordDescriptor {
  readonly encode: (input: {
    readonly definition: unknown;
    readonly scope: EvidenceScope;
  }) => Uint8Array;
  readonly idOf: (record: ComparisonRecordBase) => string;
  readonly parse: (input: unknown) => ComparisonRecord;
}

const receiptKeys = [
  "createdAt",
  "createdByPrincipalId",
  "definitionSha256",
  "schemaVersion",
  "scope",
] as const;

function field(record: ComparisonRecordBase, key: string): string {
  const value = (record as unknown as Readonly<Record<string, unknown>>)[key];
  if (typeof value !== "string") {
    throw new ComparisonRepositoryContractError(`Validated comparison record omitted ${key}`);
  }
  return value;
}

export const comparisonRecordDescriptors: Readonly<
  Record<ComparisonRecordKind, ComparisonRecordDescriptor>
> = {
  comparison_definition: {
    encode: (input) => encodeComparisonDefinition(input as never),
    idOf: (record) => field(record, "comparisonVersionId"),
    parse: (input) => ComparisonDefinitionRecordSchema.parse(input),
  },
  comparison_evidence_snapshot: {
    encode: (input) => encodeComparisonEvidenceSnapshotDefinition(input as never),
    idOf: (record) => field(record, "snapshotId"),
    parse: (input) => ComparisonEvidenceSnapshotSchema.parse(input),
  },
  comparison_result: {
    encode: (input) => encodeComparisonResultDefinition(input as never),
    idOf: (record) => field(record, "resultId"),
    parse: (input) => ComparisonResultSchema.parse(input),
  },
};

function definitionOf(record: ComparisonRecord): Record<string, unknown> {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of receiptKeys) delete definition[key];
  return definition;
}

export function digestComparisonRecordDefinition(
  kind: ComparisonRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): string {
  const bytes = comparisonRecordDescriptors[kind].encode({ definition, scope });
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateComparisonRecord(
  kind: ComparisonRecordKind,
  candidate: unknown,
): ComparisonRecord {
  const descriptor = comparisonRecordDescriptors[kind];
  let parsed: ComparisonRecord;
  let digest: string;
  try {
    parsed = descriptor.parse(candidate);
    digest = digestComparisonRecordDefinition(kind, parsed.scope, definitionOf(parsed));
  } catch (error) {
    throw new InvalidComparisonRecordInputError(`Invalid ${kind} record`, { cause: error });
  }
  if (digest !== parsed.definitionSha256) {
    throw new InvalidComparisonRecordInputError(
      `${kind} record ${descriptor.idOf(parsed)} has an invalid canonical definition digest`,
    );
  }
  return parsed;
}

export function comparisonRecordId(kind: ComparisonRecordKind, record: ComparisonRecord): string {
  return comparisonRecordDescriptors[kind].idOf(record);
}
