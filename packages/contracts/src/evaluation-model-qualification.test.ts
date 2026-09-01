import { describe, expect, it } from "vitest";
import {
  MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION,
  type ModelQualificationSuite,
  type ModelQualificationSuiteDefinition,
  ModelQualificationScenarioSchema,
  ModelQualificationSuiteDefinitionSchema,
  ModelQualificationSuiteSchema,
} from "./evaluation-model-qualification.js";

const sha = (character: string) => character.repeat(64);
const scope = {
  environmentId: "env_assurance",
  projectId: "prj_assurance",
  tenantId: "ten_assurance",
} as const;
const artifact = (artifactId: string, character: string, mediaType = "application/json") => ({
  artifactId,
  classification: "restricted" as const,
  mediaType,
  sha256: sha(character),
  sizeBytes: 1_024,
});

export function modelQualificationSuiteDefinition(): ModelQualificationSuiteDefinition {
  return {
    baseQualificationFixtureSet: {
      definitionSha256: sha("1"),
      fixtureSetId: "qfs_model_safety_base",
      fixtureSetVersionId: "qfv_model_safety_base_v1",
    },
    blindedPlan: {
      blindedPlanId: "blp_safety",
      blindedPlanVersionId: "blv_safety_v1",
      definitionSha256: sha("2"),
    },
    caseCount: 48,
    caseManifest: artifact("art_model_qualification_cases", "3"),
    caseManifestSchema: artifact(
      "art_model_qualification_case_schema",
      "4",
      "application/schema+json",
    ),
    changeRationale:
      "Initial adversarial, bias, variance, provider-failure, and disagreement qualification suite.",
    criteria: [
      {
        criterionId: "crt_no_unsafe_tool_request",
        criterionSetId: "crs_agent_safety",
        criterionSetVersionId: "csv_agent_safety_v1",
      },
    ],
    dataset: {
      datasetId: "dts_model_qualification",
      datasetVersionId: "dtv_model_qualification_v1",
      definitionSha256: sha("5"),
    },
    evaluator: {
      definitionSha256: sha("6"),
      evaluatorId: "evl_model_safety",
      evaluatorVersionId: "evv_model_safety_v1",
    },
    executionPolicy: {
      defaultAttemptsPerCase: 2,
      fixedSeeds: artifact("art_model_qualification_seeds", "7"),
      orderBiasAttemptsPerCase: 4,
      retryUntilPass: false,
      stochasticVarianceAttemptsPerCase: 8,
    },
    knownLimitations: [
      "Synthetic adversarial cases do not prove production resistance",
      "Unseen provider behavior remains out of scope",
    ],
    manifestValidationEvidence: artifact("art_model_qualification_validation", "8"),
    modelProfile: {
      definitionSha256: sha("9"),
      modelProfileId: "mep_safety",
      modelProfileVersionId: "mpv_safety_v1",
    },
    scenarioCoverage: [...ModelQualificationScenarioSchema.options],
    suiteId: "mqs_model_safety",
    suiteVersionId: "mqv_model_safety_v1",
    validFrom: "2026-09-02T04:00:00.000Z",
    validUntil: "2026-12-01T04:00:00.000Z",
  };
}

function modelQualificationSuite(): ModelQualificationSuite {
  return {
    ...modelQualificationSuiteDefinition(),
    definitionSha256: sha("a"),
    publishedAt: "2026-09-02T04:00:00.000Z",
    publishedByPrincipalId: "usr_model_qualification_publisher",
    schemaVersion: MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION,
    scope,
  };
}

describe("model qualification suite contracts", () => {
  it("accepts exact base, blind, dataset, model, case-manifest, and scenario lineage", () => {
    expect(
      ModelQualificationSuiteDefinitionSchema.parse(modelQualificationSuiteDefinition()),
    ).toEqual(modelQualificationSuiteDefinition());
    expect(ModelQualificationSuiteSchema.parse(modelQualificationSuite())).toEqual(
      modelQualificationSuite(),
    );
  });

  it("requires every registered injection, bias, variance, failure, and disagreement scenario", () => {
    const missing = modelQualificationSuiteDefinition();
    missing.scenarioCoverage = missing.scenarioCoverage.slice(1) as never;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(missing)).toThrow();

    const substituted = modelQualificationSuiteDefinition();
    substituted.scenarioCoverage[1] = substituted.scenarioCoverage[0] as never;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(substituted)).toThrow(
      "complete, unique, and ordered",
    );

    expect(ModelQualificationScenarioSchema.options).toContain("direct_prompt_injection");
    expect(ModelQualificationScenarioSchema.options).toContain("retrieved_prompt_injection");
    expect(ModelQualificationScenarioSchema.options).toContain("self_provider_correlation");
    expect(ModelQualificationScenarioSchema.options).toContain("judge_disagreement");
  });

  it("requires bounded predeclared repetitions and forbids retry-until-pass", () => {
    const variance = modelQualificationSuiteDefinition();
    variance.executionPolicy.stochasticVarianceAttemptsPerCase = 3;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(variance)).toThrow();

    const order = modelQualificationSuiteDefinition();
    order.executionPolicy.orderBiasAttemptsPerCase = 1;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(order)).toThrow();

    expect(() =>
      ModelQualificationSuiteDefinitionSchema.parse({
        ...modelQualificationSuiteDefinition(),
        executionPolicy: {
          ...modelQualificationSuiteDefinition().executionPolicy,
          retryUntilPass: true,
        },
      }),
    ).toThrow();
  });

  it("requires positive validity and immutable predecessor lineage", () => {
    const invalidWindow = modelQualificationSuiteDefinition();
    invalidWindow.validUntil = invalidWindow.validFrom;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(invalidWindow)).toThrow(
      "positive interval",
    );

    const self = modelQualificationSuiteDefinition();
    self.predecessor = {
      definitionSha256: sha("b"),
      suiteId: self.suiteId,
      suiteVersionId: self.suiteVersionId,
    };
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(self)).toThrow("name itself");
  });

  it("rejects credentials, provider endpoints, release authority, and hidden case dropping", () => {
    for (const forbidden of [
      { apiKey: "secret" },
      { providerEndpoint: "https://example.invalid" },
      { releaseAuthority: "allow" },
      { silentlyDropFailedCases: true },
    ]) {
      expect(() =>
        ModelQualificationSuiteDefinitionSchema.parse({
          ...modelQualificationSuiteDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});
