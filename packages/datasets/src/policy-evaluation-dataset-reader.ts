import type {
  EvidenceScope,
  PolicyEvaluationSourceReference,
  RecordedInteractionFixtureVersion,
  RegressionDatasetVersion,
  RegressionFixtureVersion,
} from "@proofstack/contracts";
import {
  inspectPolicyEvaluationDefinitionCapture,
  inspectPolicyEvaluationDefinitionRecord,
  type PolicyEvaluationDefinitionCapture,
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
  readPolicyEvaluationDefinitionCapture,
  readPolicyEvaluationDefinitionRecord,
} from "@proofstack/core";
import { InvalidRegressionVersionInputError } from "./errors.js";
import {
  validateAndProjectRecordedInteractionFixtureVersion,
  validateAndProjectRegressionDatasetVersion,
  validateAndProjectRegressionFixtureVersion,
} from "./regression-version-definition.js";
import type { InteractionFixtureVersionRepository } from "./regression-version-repository.js";

export type PolicyEvaluationDatasetSource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "dataset_version" | "regression_fixture_version" }
>;
export type PolicyEvaluationDatasetRecord =
  | RegressionDatasetVersion
  | RegressionFixtureVersion
  | RecordedInteractionFixtureVersion;
export type PolicyEvaluationDatasetRead = PolicyEvaluationDefinitionRead<
  PolicyEvaluationDatasetRecord,
  PolicyEvaluationDatasetSource
>;
export type PolicyEvaluationDatasetCapture = PolicyEvaluationDefinitionCapture<
  PolicyEvaluationDatasetRecord,
  PolicyEvaluationDatasetSource
>;
type DatasetReadRepository = Pick<
  InteractionFixtureVersionRepository,
  "findDatasetVersion" | "findFixtureVersion" | "findRecordedInteractionFixtureVersion"
>;

const validator = {
  isInvalidRecordError: (cause: unknown) => cause instanceof InvalidRegressionVersionInputError,
  kinds: ["dataset_version", "regression_fixture_version"] as const,
  validate: (source: PolicyEvaluationDatasetSource, value: unknown) => {
    if (source.kind === "dataset_version")
      return validateAndProjectRegressionDatasetVersion(value).version;
    // The discriminant selects one fixed schema; it never tries a favorable format fallback.
    if (
      typeof value === "object" &&
      value !== null &&
      "schemaVersion" in value &&
      value.schemaVersion === "0.2"
    )
      return validateAndProjectRecordedInteractionFixtureVersion(value).version;
    return validateAndProjectRegressionFixtureVersion(value).version;
  },
};

/**
 * Inspects the immutable version body, NOT the interaction repository's ownership wrapper.
 * This does not replace the reader's two-store conflict check or establish retained authority.
 */
export function inspectPolicyEvaluationDataset(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
  raw: unknown,
): PolicyEvaluationDatasetRead {
  return inspectPolicyEvaluationDefinitionRecord<
    PolicyEvaluationDatasetSource,
    PolicyEvaluationDatasetRecord
  >(input, raw, validator);
}

/** Pure exact-body retention; interaction ownership wrappers still require the owning read. */
export function inspectPolicyEvaluationDatasetCapture(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
  raw: unknown,
): PolicyEvaluationDatasetCapture {
  return inspectPolicyEvaluationDefinitionCapture(input, raw, validator);
}

export function readPolicyEvaluationDatasetCapture(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
  repository: DatasetReadRepository,
): Promise<PolicyEvaluationDatasetCapture> {
  return readPolicyEvaluationDefinitionCapture(input, datasetAdapter(repository));
}

/**
 * Reads exact immutable dataset/fixture definitions, without publication or content authority.
 * Both fixture stores are consulted: the reference intentionally does not select a schema version.
 * Only two nulls establish absence. Duplicate cross-format identity or an invalid response cannot
 * become a favorable fallback. Interaction ownership metadata is NOT a verified record here;
 * content, ownership, revocation, and predecessor/membership validation belong to later capture.
 */
export function readPolicyEvaluationDataset(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
  repository: DatasetReadRepository,
): Promise<PolicyEvaluationDatasetRead> {
  return readPolicyEvaluationDefinitionRecord<
    PolicyEvaluationDatasetSource,
    PolicyEvaluationDatasetRecord
  >(input, datasetAdapter(repository));
}

function datasetAdapter(repository: DatasetReadRepository) {
  return {
    ...validator,
    read: async (scope: EvidenceScope, source: PolicyEvaluationDatasetSource) => {
      if (source.kind === "dataset_version") {
        return repository.findDatasetVersion(scope, source.reference.datasetVersionId);
      }
      const id = source.reference.fixtureVersionId;
      const [evidence, interaction] = await Promise.all([
        repository.findFixtureVersion(structuredClone(scope), id),
        repository.findRecordedInteractionFixtureVersion(structuredClone(scope), id),
      ]);
      if (evidence === null && interaction === null) return null;
      return { evidence, interaction };
    },
    validate: (source: PolicyEvaluationDatasetSource, raw: unknown) => {
      if (source.kind === "dataset_version") {
        return validateAndProjectRegressionDatasetVersion(raw).version;
      }
      // This envelope is adapter-owned, never a public caller's or repository's discriminant.
      const { evidence, interaction } = raw as {
        readonly evidence: unknown;
        readonly interaction: unknown;
      };
      if (interaction === null) return validateAndProjectRegressionFixtureVersion(evidence).version;
      if (evidence !== null || typeof interaction !== "object") {
        throw new InvalidRegressionVersionInputError(
          "Fixture identity has conflicting or invalid records",
        );
      }
      return validateAndProjectRecordedInteractionFixtureVersion(
        (interaction as { readonly version?: unknown }).version,
      ).version;
    },
  };
}
