import { isDeepStrictEqual } from "node:util";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  type PolicyEvaluationManifestEntry,
  PolicyEvaluationManifestEntrySchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationDefinitionReadInput,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  revalidatePolicyEvaluationCapturedRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDataset,
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
        if (child.observation.status !== "verified")
          return { ...result, observation: { status: "unavailable" } };
        const target = child.record as PolicyEvaluationDatasetRecord;
        if (relation.kind === "fixture_predecessor") {
          if (target.schemaVersion !== "0.1")
            return {
              ...result,
              observation: { status: "mismatch", reason: "predecessor_format_mismatch" },
            };
          // Fixed reference validation already established fixture identity and scope. Promotion
          // additionally copies the entire retained snapshot, including capturedAt and event order.
          if (
            version.schemaVersion === "0.2" &&
            !isDeepStrictEqual(version.source, (target as { source: unknown }).source)
          )
            return {
              ...result,
              observation: { status: "mismatch", reason: "trace_snapshot_mismatch" },
            };
        }
        return { ...result, observation: { status: "matched" } };
      });
      parents.push({
        source: parent.source,
        recordSha256: parent.observation.recordSha256,
        relations,
      });
    }
    return { parents, unavailableParents };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
