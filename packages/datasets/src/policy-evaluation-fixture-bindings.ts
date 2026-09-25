import { isDeepStrictEqual } from "node:util";
import {
  type ArtifactMetadata,
  ArtifactMetadataSchema,
  type ArtifactOwnership,
  ArtifactOwnershipSchema,
  policyEvaluationTimestampOrderKey,
  Sha256Schema,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationDefinitionReadInput,
  PolicyEvaluationEvidenceReferenceError,
  revalidatePolicyEvaluationCapturedRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDataset,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
  type PolicyEvaluationDatasetSource,
} from "./policy-evaluation-dataset-reader.js";

/** Already acquired catalog projection, not a replacement for authorized artifact acquisition. */
export interface PolicyFixtureArtifactCatalog {
  readonly metadata: ArtifactMetadata;
  readonly ownership: ArtifactOwnership | null;
  /** Full private catalog digest supplied by its owning reader; not recomputed from this projection. */
  readonly recordSha256: string;
}

export type PolicyFixtureArtifactBindingObservation =
  | { readonly status: "matched" }
  | { readonly status: "unavailable"; readonly reason: "catalog_unavailable" }
  | {
      readonly status: "mismatch";
      readonly reason:
        | "scope_mismatch"
        | "descriptor_mismatch"
        | "retention_mismatch"
        | "redaction_mismatch"
        | "publication_time_mismatch"
        | "ownership_missing"
        | "ownership_mismatch";
    };

export interface PolicyFixtureArtifactBinding {
  readonly artifactId: string;
  readonly bindingIndex: number;
  readonly catalogRecordSha256: string | null;
  readonly observation: PolicyFixtureArtifactBindingObservation;
}

/**
 * Checks a recorded fixture's complete, ordered catalog projections against its atomic-publication
 * invariants. The immutable parent is revalidated once, including its original full-record hash.
 * A match is NOT retained-byte availability, revocation authority, a sealed cut or a policy verdict.
 * Ordinary artifacts and evidence-only fixtures must not be passed through this owning-domain rule.
 */
export function inspectPolicyEvaluationFixtureArtifactBindings(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
  evidence: PolicyEvaluationDatasetRead,
  catalogs: readonly (PolicyFixtureArtifactCatalog | null)[],
) {
  try {
    const checked = revalidatePolicyEvaluationCapturedRecord<
      PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
      PolicyEvaluationDatasetRecord,
      PolicyEvaluationDatasetSource
    >(input, evidence, inspectPolicyEvaluationDataset);
    const version = checked.record;
    if (
      checked.source.kind !== "regression_fixture_version" ||
      version.schemaVersion !== "0.2" ||
      !Array.isArray(catalogs) ||
      catalogs.length !== version.interactionCapture.artifacts.length
    )
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    const artifacts: PolicyFixtureArtifactBinding[] = version.interactionCapture.artifacts.map(
      (binding, bindingIndex) => {
        const artifactId = binding.contentReference.artifactId;
        const raw = catalogs[bindingIndex];
        if (raw === null)
          return {
            artifactId,
            bindingIndex,
            catalogRecordSha256: null,
            observation: { status: "unavailable", reason: "catalog_unavailable" },
          };
        if (
          !raw ||
          Reflect.ownKeys(raw).length !== 3 ||
          !["metadata", "ownership", "recordSha256"].every((key) => {
            const property = Object.getOwnPropertyDescriptor(raw, key);
            return property?.enumerable && "value" in property;
          })
        )
          throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
        const metadata = ArtifactMetadataSchema.parse(raw.metadata);
        const ownership =
          raw.ownership === null ? null : ArtifactOwnershipSchema.parse(raw.ownership);
        const catalogRecordSha256 = Sha256Schema.parse(raw.recordSha256);
        const mismatch = (
          reason: Extract<
            PolicyFixtureArtifactBindingObservation,
            { status: "mismatch" }
          >["reason"],
        ): PolicyFixtureArtifactBinding => ({
          artifactId,
          bindingIndex,
          catalogRecordSha256,
          observation: { status: "mismatch", reason },
        });
        if (!isDeepStrictEqual(metadata.scope, version.scope)) return mismatch("scope_mismatch");
        if (!isDeepStrictEqual(metadata.contentReference, binding.contentReference))
          return mismatch("descriptor_mismatch");
        if (!isDeepStrictEqual(metadata.retention, binding.retention))
          return mismatch("retention_mismatch");
        if (!isDeepStrictEqual(metadata.redaction, binding.redaction))
          return mismatch("redaction_mismatch");
        // A later tombstone does not erase the immutable binding. Publication did require an
        // available artifact; preserve sub-millisecond order rather than rounding with Date.parse.
        if (
          metadata.availableAt === undefined ||
          [metadata.createdAt, metadata.availableAt].some(
            (time) =>
              policyEvaluationTimestampOrderKey(time) >
              policyEvaluationTimestampOrderKey(version.createdAt),
          )
        )
          return mismatch("publication_time_mismatch");
        if (ownership === null) return mismatch("ownership_missing");
        const expected: ArtifactOwnership = {
          artifactId,
          boundAt: version.createdAt,
          boundByPrincipalId: version.createdByPrincipalId,
          owner: {
            fixtureId: version.fixtureId,
            fixtureVersionId: version.fixtureVersionId,
            kind: "regression_fixture_version",
          },
          schemaVersion: "0.1",
          scope: version.scope,
        };
        if (!isDeepStrictEqual(ownership, expected)) return mismatch("ownership_mismatch");
        return {
          artifactId,
          bindingIndex,
          catalogRecordSha256,
          observation: { status: "matched" },
        };
      },
    );
    return { source: checked.source, recordSha256: checked.observation.recordSha256, artifacts };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
