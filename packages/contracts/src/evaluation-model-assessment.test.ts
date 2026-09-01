import { describe, expect, it } from "vitest";
import {
  MODEL_ASSURANCE_ASSESSMENT_SCHEMA_VERSION,
  type ModelAssuranceAssessment,
  type ModelAssuranceAssessmentDefinition,
  ModelAssuranceAssessmentDefinitionSchema,
  ModelAssuranceAssessmentSchema,
} from "./evaluation-model-assessment.js";

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

export function modelAssuranceAssessmentDefinition(): ModelAssuranceAssessmentDefinition {
  return {
    assessmentExtensionId: "maa_agent_safety_v1",
    baseAssessment: {
      assessmentId: "asm_agent_safety_v1",
      definitionSha256: sha("1"),
    },
    blindedPlan: {
      blindedPlanId: "blp_safety",
      blindedPlanVersionId: "blv_safety_v1",
      definitionSha256: sha("2"),
    },
    blindedResult: {
      definitionSha256: sha("0"),
      resultId: "blr_safety_v1",
    },
    calibrationReport: {
      calibrationReportId: "cal_model_safety_v1",
      definitionSha256: sha("3"),
    },
    calibrationContext: {
      locale: "en",
      populationTags: ["agent:tool-using", "deployment:test"],
      taskKindId: "task_tool_use",
    },
    counterevidence: [artifact("art_assurance_counterevidence", "4")],
    critiques: [
      {
        critiqueId: "crq_observation_safety_v1",
        definitionSha256: sha("5"),
      },
    ],
    disagreementEvidence: [artifact("art_assurance_agreement_record", "6")],
    eligibility: "eligible",
    evaluatedAt: "2026-09-02T06:00:00.000Z",
    humanReviewProtocol: {
      definitionSha256: sha("7"),
      protocolId: "hrp_agent_safety",
      protocolVersionId: "hrv_agent_safety_v1",
    },
    humanReviews: [
      { definitionSha256: sha("8"), reviewId: "hrr_domain_reviewer" },
      { definitionSha256: sha("9"), reviewId: "hrr_safety_reviewer" },
    ],
    independenceDeclarations: [
      { definitionSha256: sha("a"), independenceDeclarationId: "ind_critic_v1" },
      { definitionSha256: sha("b"), independenceDeclarationId: "ind_primary_v1" },
    ],
    knownLimitations: ["Eligibility remains bounded to the exact evidence and validity window"],
    modelQualificationReport: {
      definitionSha256: sha("c"),
      reportId: "mqr_model_safety_v1",
    },
    nonModelEvidence: {
      observations: [
        {
          definitionSha256: sha("d"),
          observationId: "obs_non_model_oracle_v1",
        },
      ],
      oracles: [
        {
          definitionSha256: sha("e"),
          oracleId: "orc_agent_policy",
          oracleVersionId: "orv_agent_policy_v1",
        },
      ],
    },
    policy: artifact("art_model_assurance_policy", "f", "text/plain"),
    reasons: [],
    riskTier: "high",
    validUntil: "2026-09-03T06:00:00.000Z",
  };
}

function modelAssuranceAssessment(): ModelAssuranceAssessment {
  return {
    ...modelAssuranceAssessmentDefinition(),
    definitionSha256: sha("0"),
    recordedAt: "2026-09-02T06:00:01.000Z",
    schemaVersion: MODEL_ASSURANCE_ASSESSMENT_SCHEMA_VERSION,
    scope,
  };
}

describe("model assurance assessment contracts", () => {
  it("binds a base assessment to exact model, blind, critique, non-model, and human evidence", () => {
    expect(
      ModelAssuranceAssessmentDefinitionSchema.parse(modelAssuranceAssessmentDefinition()),
    ).toEqual(modelAssuranceAssessmentDefinition());
    expect(ModelAssuranceAssessmentSchema.parse(modelAssuranceAssessment())).toEqual(
      modelAssuranceAssessment(),
    );
  });

  it("separates eligible evidence from explicit ineligibility reasons", () => {
    const contradictory = modelAssuranceAssessmentDefinition();
    contradictory.reasons = ["calibration_stale"];
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(contradictory)).toThrow(
      "cannot contain ineligibility reasons",
    );

    const unexplained = modelAssuranceAssessmentDefinition();
    unexplained.eligibility = "ineligible";
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(unexplained)).toThrow(
      "require at least one reason",
    );

    unexplained.reasons = ["calibration_stale"];
    expect(ModelAssuranceAssessmentDefinitionSchema.parse(unexplained)).toEqual(unexplained);
  });

  it("requires independent critic lineage, non-model evidence, and high-risk human review", () => {
    const independence = modelAssuranceAssessmentDefinition();
    independence.independenceDeclarations = [independence.independenceDeclarations[0] as never];
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(independence)).toThrow();

    const nonModel = modelAssuranceAssessmentDefinition();
    nonModel.nonModelEvidence.observations = [];
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(nonModel)).toThrow();

    const human = modelAssuranceAssessmentDefinition();
    human.humanReviews = [];
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(human)).toThrow(
      "requires at least one human review",
    );
  });

  it("requires exact ordered lineage and a positive validity interval", () => {
    const reviews = modelAssuranceAssessmentDefinition();
    reviews.humanReviews = [...reviews.humanReviews].reverse();
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(reviews)).toThrow(
      "ordered by exact reference",
    );

    const declarations = modelAssuranceAssessmentDefinition();
    declarations.independenceDeclarations = [...declarations.independenceDeclarations].reverse();
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(declarations)).toThrow(
      "ordered by exact reference",
    );

    const population = modelAssuranceAssessmentDefinition();
    population.calibrationContext.populationTags = ["deployment:test", "agent:tool-using"];
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(population)).toThrow(
      "population tags must be unique and ordered",
    );

    const expired = modelAssuranceAssessmentDefinition();
    expired.validUntil = expired.evaluatedAt;
    expect(() => ModelAssuranceAssessmentDefinitionSchema.parse(expired)).toThrow(
      "validity must follow evaluation",
    );
  });

  it("rejects model majority override, evidence mutation, release authority, and approval", () => {
    for (const forbidden of [
      { modelMajorityOverridesOracle: true },
      { mutateEvidence: true },
      { releaseAuthority: "allow" },
      { approvalDecision: "approved" },
    ]) {
      expect(() =>
        ModelAssuranceAssessmentDefinitionSchema.parse({
          ...modelAssuranceAssessmentDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});
