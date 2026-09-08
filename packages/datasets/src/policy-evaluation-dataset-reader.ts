import type {
  PolicyEvaluationSourceReference,
  RecordedInteractionFixtureVersion,
  RegressionDatasetVersion,
  RegressionFixtureVersion,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
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

/**
 * Reads exact immutable dataset/fixture definitions, without publication or content authority.
 * Both fixture stores are consulted: the reference intentionally does not select a schema version.
 * Only two nulls establish absence. Duplicate cross-format identity or an invalid response cannot
 * become a favorable fallback. Interaction ownership metadata is NOT a verified record here;
 * content, ownership, revocation, and predecessor/membership validation belong to later capture.
 */
export function readPolicyEvaluationDataset(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
  repository: Pick<
    InteractionFixtureVersionRepository,
    "findDatasetVersion" | "findFixtureVersion" | "findRecordedInteractionFixtureVersion"
  >,
): Promise<PolicyEvaluationDatasetRead> {
  return readPolicyEvaluationDefinitionRecord<
    PolicyEvaluationDatasetSource,
    PolicyEvaluationDatasetRecord
  >(input, {
    isInvalidRecordError: (cause) => cause instanceof InvalidRegressionVersionInputError,
    kinds: ["dataset_version", "regression_fixture_version"],
    read: async (scope, source) => {
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
    validate: (source, raw) => {
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
  });
}
