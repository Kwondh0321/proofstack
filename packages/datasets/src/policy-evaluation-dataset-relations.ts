import { isDeepStrictEqual } from "node:util";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  type PolicyEvaluationManifestEntry,
  PolicyEvaluationManifestEntrySchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationDefinitionReadInput,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  revalidatePolicyEvaluationCapturedRecord,
  revalidatePolicyEvaluationCapturedStorage,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDataset,
  inspectPolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
  type PolicyEvaluationDatasetSource,
} from "./policy-evaluation-dataset-reader.js";

type Observation = PolicyEvaluationManifestEntry["observation"];
type RelationKind = "dataset_member" | "dataset_predecessor" | "fixture_predecessor";
interface ExpectedRelation {
  readonly kind: RelationKind;
  readonly path: string;
  readonly source: PolicyEvaluationDatasetSource;
}

export interface PolicyDatasetRelation extends ExpectedRelation {
  readonly recordObservation: Observation;
  readonly observation:
    | { readonly status: "matched" }
    | { readonly status: "unavailable" }
    | {
        readonly status: "mismatch";
        readonly reason: "predecessor_format_mismatch" | "trace_snapshot_mismatch";
      };
}

export interface PolicyDatasetRelations {
  /** Repeated relation inputs, to be admitted by the request-owning composition. */
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
  readonly parents: readonly {
    readonly source: PolicyEvaluationDatasetSource;
    readonly recordSha256: string;
    readonly relations: readonly PolicyDatasetRelation[];
  }[];
  /** An unreadable parent has an unknown frontier, not a successful empty relation list. */
  readonly unavailableParents: readonly {
    readonly source: PolicyEvaluationDatasetSource;
    readonly observation: Exclude<Observation, { status: "verified" }>;
  }[];
}

/** Full original storage relationships; semantic availability remains at the requested cut. */
export interface PolicyStoredDatasetRelations {
  readonly authorityBoundary: "stored_relationships_only";
  readonly scope: EvidenceScope;
  readonly evaluationTime: string;
  readonly parents: readonly {
    readonly source: PolicyEvaluationDatasetSource;
    readonly recordSha256: string;
    readonly receiptTime: string;
    readonly recordObservation: Observation;
    readonly relations: readonly (PolicyDatasetRelation & {
      readonly storage: { readonly recordSha256: string; readonly receiptTime: string } | null;
    })[];
  }[];
  readonly unavailableParents: PolicyDatasetRelations["unavailableParents"];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function relationship(
  version: PolicyEvaluationDatasetRecord,
  target: PolicyEvaluationDatasetRecord | null,
  kind: RelationKind,
): PolicyDatasetRelation["observation"] {
  if (target === null) return { status: "unavailable" };
  if (kind === "fixture_predecessor") {
    if (target.schemaVersion !== "0.1")
      return { status: "mismatch", reason: "predecessor_format_mismatch" };
    // A promotion preserves the entire original snapshot, including capture receipt and order.
    if (
      version.schemaVersion === "0.2" &&
      !isDeepStrictEqual(version.source, (target as { source: unknown }).source)
    )
      return { status: "mismatch", reason: "trace_snapshot_mismatch" };
  }
  return { status: "matched" };
}

function required(record: PolicyEvaluationDatasetRecord): ExpectedRelation[] {
  if ("datasetVersionId" in record) {
    const relations: ExpectedRelation[] = record.fixtureVersions.map((reference, index) => ({
      kind: "dataset_member",
      path: `/fixtureVersions/${index}`,
      source: { kind: "regression_fixture_version", reference },
    }));
    if (record.predecessor)
      relations.push({
        kind: "dataset_predecessor",
        path: "/predecessor",
        source: {
          kind: "dataset_version",
          reference: { ...record.predecessor, datasetId: record.datasetId },
        },
      });
    return relations;
  }
  return record.predecessor
    ? [
        {
          kind: "fixture_predecessor",
          path: "/predecessor",
          source: {
            kind: "regression_fixture_version",
            reference: { ...record.predecessor, fixtureId: record.fixtureId },
          },
        },
      ]
    : [];
}

/**
 * Pure semantic inspection of an already bounded, acquired dataset/fixture subgraph. Revalidates
 * each retained record once, then joins exact references without repository I/O or latest aliases.
 * Missing/unavailable observations must be supplied explicitly; an omitted node is an input error.
 * This is NOT proof of root registry authority, full recursive eligibility or a sealed snapshot.
 */
export function inspectPolicyEvaluationDatasetRelations(
  input: { readonly scope: EvidenceScope; readonly evaluationTime: string },
  evidence: readonly PolicyEvaluationDatasetRead[],
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyDatasetRelations {
  try {
    const out = new PolicyEvaluationReferenceCollector(limits);
    if (
      !input ||
      Object.keys(input).some((key) => key !== "scope" && key !== "evaluationTime") ||
      !Array.isArray(evidence)
    )
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    if (evidence.length > limits.maxReferences)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    const context = {
      scope: EvidenceScopeSchema.parse(input.scope),
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
    };
    const records = new Map<string, PolicyEvaluationDatasetRead>();
    for (const read of evidence) {
      if (
        !read ||
        Reflect.ownKeys(read).length !== 3 ||
        !["record", "source", "observation"].every((key) => {
          const property = Object.getOwnPropertyDescriptor(read, key);
          return property?.enumerable && "value" in property;
        })
      )
        throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
      const entry = PolicyEvaluationManifestEntrySchema.parse({
        source: read.source,
        observation: read.observation,
      });
      if (
        entry.source.kind !== "dataset_version" &&
        entry.source.kind !== "regression_fixture_version"
      )
        throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
      const key = policyEvaluationSourceReferenceKey(entry.source);
      if (records.has(key))
        throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
      if (entry.observation.status === "verified") {
        records.set(
          key,
          revalidatePolicyEvaluationCapturedRecord<
            PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
            PolicyEvaluationDatasetRecord,
            PolicyEvaluationDatasetSource
          >({ ...context, source: entry.source }, read, inspectPolicyEvaluationDataset),
        );
      } else {
        if (read.record !== null)
          throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
        records.set(key, { source: entry.source, observation: entry.observation, record: null });
      }
    }
    const parents: PolicyDatasetRelations["parents"][number][] = [];
    const unavailableParents: PolicyDatasetRelations["unavailableParents"][number][] = [];
    // Keys are unique: duplicates were rejected before sorting.
    const ordered = [...records.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
    for (const [, parent] of ordered) {
      if (parent.observation.status !== "verified") {
        unavailableParents.push({ source: parent.source, observation: parent.observation });
        continue;
      }
      const version = parent.record as PolicyEvaluationDatasetRecord;
      const relations = required(version).map((relation): PolicyDatasetRelation => {
        out.record(relation.path, relation.source.kind, relation.source.reference);
        const child = records.get(policyEvaluationSourceReferenceKey(relation.source));
        if (!child || !isDeepStrictEqual(child.source, relation.source))
          throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
        const recordObservation = structuredClone(child.observation);
        const result = { ...relation, recordObservation };
        return { ...result, observation: relationship(version, child.record, relation.kind) };
      });
      parents.push({
        source: parent.source,
        recordSha256: parent.observation.recordSha256,
        relations,
      });
    }
    const usage = out.result();
    return {
      parents,
      unavailableParents,
      inspectionUsage: {
        references: usage.references.length,
        referenceBytes: usage.referenceBytes,
      },
    };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}

/**
 * Fixed owning inspection of complete original dataset/fixture captures. It does not advance
 * evaluationTime, promote future records, fetch bytes, establish authority, or seal a snapshot.
 */
export function inspectPolicyEvaluationStoredDatasetRelations(
  input: { readonly scope: EvidenceScope; readonly evaluationTime: string },
  evidence: readonly PolicyEvaluationDatasetCapture[],
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyStoredDatasetRelations {
  try {
    new PolicyEvaluationReferenceCollector(limits);
    if (!input || Reflect.ownKeys(input).length !== 2 || !Array.isArray(evidence))
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    const context = {
      scope: EvidenceScopeSchema.parse(input.scope),
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
    };
    let references = 0;
    let referenceBytes = 0;
    const admit = (value: unknown, count: number) => {
      if (count > limits.maxReferences - references)
        throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
      const bytes = Buffer.byteLength(serializeEvaluationCanonicalJson(value), "utf8");
      if (bytes > limits.maxReferenceBytes - referenceBytes)
        throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
      references += count;
      referenceBytes += bytes;
    };
    admit(context, 1);
    if (evidence.length > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    const records = new Map<string, PolicyEvaluationDatasetCapture>();
    for (let index = 0; index < evidence.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(evidence, index);
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
      const capture = descriptor.value as PolicyEvaluationDatasetCapture;
      if (
        !capture ||
        Reflect.ownKeys(capture).length !== 2 ||
        !["read", "storage"].every((key) => {
          const property = Object.getOwnPropertyDescriptor(capture, key);
          return property?.enumerable && "value" in property;
        }) ||
        !capture.read ||
        Reflect.ownKeys(capture.read).length !== 3
      )
        throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
      admit(capture, 1);
      const entry = PolicyEvaluationManifestEntrySchema.parse({
        source: capture.read.source,
        observation: capture.read.observation,
      });
      if (
        entry.source.kind !== "dataset_version" &&
        entry.source.kind !== "regression_fixture_version"
      )
        throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
      const key = policyEvaluationSourceReferenceKey(entry.source);
      if (records.has(key))
        throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
      if (capture.storage === null) {
        if (
          capture.read.record !== null ||
          entry.observation.status === "verified" ||
          (entry.observation.status === "unavailable" &&
            entry.observation.reason === "not_yet_available")
        )
          throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
        records.set(key, structuredClone(capture));
      } else {
        records.set(
          key,
          revalidatePolicyEvaluationCapturedStorage(
            { ...context, source: entry.source },
            capture,
            inspectPolicyEvaluationDatasetCapture,
          ),
        );
      }
    }
    const out = new PolicyEvaluationReferenceCollector({
      maxReferences: limits.maxReferences - references,
      maxReferenceBytes: limits.maxReferenceBytes - referenceBytes,
    });
    const parents: PolicyStoredDatasetRelations["parents"][number][] = [];
    const unavailableParents: PolicyStoredDatasetRelations["unavailableParents"][number][] = [];
    const ordered = [...records.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
    for (const [, parent] of ordered) {
      const storage = parent.storage;
      if (storage === null) {
        unavailableParents.push({
          source: parent.read.source,
          observation: parent.read.observation as Exclude<Observation, { status: "verified" }>,
        });
        continue;
      }
      const relations = required(storage.record).map((relation) => {
        out.record(relation.path, relation.source.kind, relation.source.reference);
        const child = records.get(policyEvaluationSourceReferenceKey(relation.source));
        if (!child || !isDeepStrictEqual(child.read.source, relation.source))
          throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
        return {
          ...relation,
          recordObservation: child.read.observation,
          storage: child.storage
            ? { recordSha256: child.storage.recordSha256, receiptTime: child.storage.receiptTime }
            : null,
          observation: relationship(storage.record, child.storage?.record ?? null, relation.kind),
        };
      });
      parents.push({
        source: parent.read.source,
        recordSha256: storage.recordSha256,
        receiptTime: storage.receiptTime,
        recordObservation: parent.read.observation,
        relations,
      });
    }
    const usage = out.result();
    references += usage.references.length;
    referenceBytes += usage.referenceBytes;
    const report = {
      authorityBoundary: "stored_relationships_only" as const,
      ...context,
      parents,
      unavailableParents,
    };
    admit(report, 0);
    return structuredClone({ ...report, inspectionUsage: { references, referenceBytes } });
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
