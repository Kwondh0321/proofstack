import {
  inspectPolicyEvaluationArtifactCatalog,
  MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
  type PolicyEvaluationArtifactCatalogInspection,
  type PolicyEvaluationArtifactRead,
  type PolicyEvaluationArtifactReadDependencies,
} from "@proofstack/artifacts";
import {
  ArtifactContentReferenceSchema,
  type ContentReference,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  type PrincipalContext,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { type AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";

export interface PolicyStoredArtifactOrigin {
  readonly edgeIndex: number;
  readonly parent: PolicyEvaluationSourceReference;
  readonly parentRecordSha256: string;
  readonly path: string;
}

/** Original storage provenance and catalog readiness, never verified artifact bytes. */
export interface PolicyStoredArtifactCapture {
  readonly origin: PolicyStoredArtifactOrigin;
  readonly read: PolicyEvaluationArtifactCatalogInspection & {
    readonly scope: PolicyEvaluationRequest["scope"];
    readonly reference: ContentReference;
    readonly evaluationTime: string;
    readonly observedAt: string;
  };
}

function canonical(value: unknown): string {
  return serializeEvaluationCanonicalJson(value);
}

/** Fixed complete inventory projection; ID-only omissions cannot supply a content descriptor. */
export function storedArtifactOccurrences(graph: Pick<PolicyRecordGraph, "storageInventory">) {
  return graph.storageInventory.edges.flatMap((edge, edgeIndex) =>
    edge.reference.kind === "artifact"
      ? [
          {
            origin: {
              edgeIndex,
              parent: edge.parent,
              parentRecordSha256: edge.parentRecordSha256,
              path: edge.reference.path,
            } satisfies PolicyStoredArtifactOrigin,
            reference: edge.reference.reference,
          },
        ]
      : [],
  );
}

/** Content failure/verification describes attempted bytes; catalog readiness remains separate. */
export function artifactCatalogMaterial(read: PolicyEvaluationArtifactRead) {
  const attempted =
    read.observation.status === "verified" ||
    (read.observation.status === "unavailable" &&
      (read.observation.reason === "object_missing" ||
        read.observation.reason === "content_integrity_failed"));
  return {
    catalog: read.catalog,
    observation: attempted ? { status: "content_pending" as const } : read.observation,
  };
}

/** Internal owning composition, using the complete request-owned graph and outer catalog meter. */
export async function acquireStoredPolicyArtifacts(
  request: PolicyEvaluationRequest,
  graph: Pick<PolicyRecordGraph, "storageInventory">,
  principal: PrincipalContext,
  catalog: PolicyEvaluationArtifactReadDependencies["catalog"],
  clock: PolicyEvaluationArtifactReadDependencies["clock"],
  budget: AcquisitionBudget,
): Promise<{
  readonly captures: readonly PolicyStoredArtifactCapture[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}> {
  const captures: PolicyStoredArtifactCapture[] = [];
  const observations = new Map<string, string>();
  let referenceBytes = 0;
  for (const occurrence of storedArtifactOccurrences(graph)) {
    // Reserve each complete original occurrence before I/O; repeated aliases are not free.
    const originBytes = encodeEvaluationCanonicalJson(occurrence).byteLength;
    budget.addReferences(1, originBytes);
    referenceBytes += originBytes;
    const { reference } = occurrence;
    const raw = ArtifactContentReferenceSchema.safeParse(reference).success
      ? await catalog.find(structuredClone(request.scope), reference.artifactId)
      : null;
    const observedAt = clock.now().toISOString();
    const inspection = inspectPolicyEvaluationArtifactCatalog(
      {
        scope: request.scope,
        principal,
        reference,
        evaluationTime: request.evaluationTime,
        maxReadBytes: MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
      },
      raw,
      observedAt,
    );
    const read = {
      scope: structuredClone(request.scope),
      reference: structuredClone(reference),
      evaluationTime: request.evaluationTime,
      observedAt,
      ...inspection,
    };
    const readBytes = encodeEvaluationCanonicalJson(read).byteLength;
    budget.addReferences(0, readBytes);
    referenceBytes += readBytes;
    const fingerprint = canonical(inspection);
    const previous = observations.get(reference.artifactId);
    if (previous !== undefined && previous !== fingerprint)
      throw new PolicyRecordGraphError("observation_conflict", `artifact:${reference.artifactId}`);
    observations.set(reference.artifactId, fingerprint);
    captures.push({ origin: structuredClone(occurrence.origin), read });
  }
  return { captures, inspectionUsage: { references: captures.length, referenceBytes } };
}
