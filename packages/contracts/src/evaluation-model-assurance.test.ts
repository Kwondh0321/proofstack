import { describe, expect, it } from "vitest";
import {
  MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION,
  type ModelEvaluatorProfile,
  type ModelEvaluatorProfileDefinition,
  ModelEvaluatorProfileDefinitionSchema,
  ModelEvaluatorProfileSchema,
} from "./evaluation-model-assurance.js";

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

export function modelEvaluatorProfileDefinition(): ModelEvaluatorProfileDefinition {
  return {
    budgets: {
      elapsedMilliseconds: 30_000,
      inputBytes: 1_048_576,
      inputTokens: 32_000,
      maximumCostMicrousd: 25_000,
      outputBytes: 262_144,
      outputTokens: 4_096,
      requests: 4,
    },
    changeRationale: "Initial bounded provider-neutral model evaluator profile",
    dataPolicy: {
      artifactPlaintext: "selected_evidence_only" as const,
      dataEgress: "selected_evidence" as const,
      geographicRegions: ["kr", "us"],
      logging: "provider_declared_metadata_only" as const,
      network: "registered_provider_only" as const,
      providerRetention: { maximumDays: 30, mode: "declared_bounded" as const },
      redirects: "denied" as const,
      toolRequests: "record_only" as const,
    },
    evaluator: {
      evaluatorId: "evl_model_safety",
      evaluatorVersionId: "evv_model_safety_v1",
    },
    knownLimitations: [
      "Provider model revision availability depends on provider metadata",
      "Synthetic qualification does not prove production fitness",
    ],
    locale: "en",
    malformedOutputPolicy: "error" as const,
    modelProfileId: "mep_safety",
    modelProfileVersionId: "mpv_safety_v1",
    outputSchema: artifact("art_model_output_schema", "1", "application/schema+json"),
    prompts: [
      {
        purpose: "counteranalysis" as const,
        template: artifact("art_prompt_counteranalysis", "2", "text/plain"),
      },
      {
        purpose: "rubric" as const,
        template: artifact("art_prompt_rubric", "3", "text/plain"),
      },
      {
        purpose: "system" as const,
        template: artifact("art_prompt_system", "4", "text/plain"),
      },
      {
        purpose: "task" as const,
        template: artifact("art_prompt_task", "5", "text/plain"),
      },
    ],
    provider: {
      adapterId: "mad_local_http",
      adapterVersionId: "mav_local_http_v1",
      baseModelFamily: "reference-model-family",
      fineTuneLineage: ["base:reference-model-family", "tune:none"],
      modelResolution: {
        resolutionEvidence: artifact("art_model_resolution", "6"),
        resolvedModelVersion: "reference-model-2026-09-01",
        status: "exact" as const,
      },
      providerId: "mdp_reference",
      providerModelId: "reference-model",
      trainingDataRelationship: "unknown" as const,
    },
    reproducibility: "bounded" as const,
    riskTiers: ["high", "low", "medium"],
    sampling: {
      maximumOutputTokens: 4_096,
      seed: { status: "fixed" as const, value: 42 },
      temperatureMilli: 0,
      topPBasisPoints: 10_000,
    },
    supportedCriteria: [
      {
        criterionId: "crt_no_unsafe_tool_request",
        criterionSetId: "crs_agent_safety",
        criterionSetVersionId: "csv_agent_safety_v1",
      },
    ],
    toolContracts: [artifact("art_tool_contract", "7", "application/schema+json")],
    validFrom: "2026-09-02T00:00:00.000Z",
    validUntil: "2026-12-01T00:00:00.000Z",
  };
}

function profile(): ModelEvaluatorProfile {
  return {
    ...modelEvaluatorProfileDefinition(),
    definitionSha256: sha("8"),
    publishedAt: "2026-09-02T00:00:01.000Z",
    publishedByPrincipalId: "usr_model_profile_publisher",
    schemaVersion: MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION,
    scope,
  };
}

describe("model evaluator profile contracts", () => {
  it("accepts an exact provider-neutral profile without credentials or destinations", () => {
    expect(ModelEvaluatorProfileDefinitionSchema.parse(modelEvaluatorProfileDefinition())).toEqual(
      modelEvaluatorProfileDefinition(),
    );
    expect(ModelEvaluatorProfileSchema.parse(profile())).toEqual(profile());
  });

  it("records bounded provider aliases honestly when an exact revision is unavailable", () => {
    const input = modelEvaluatorProfileDefinition();
    input.provider.modelResolution = {
      limitation: "The provider exposes a mutable alias and no immutable revision identifier.",
      status: "provider_alias_only",
    };
    input.reproducibility = "best_effort";
    input.dataPolicy.providerRetention = { mode: "zero_retention" };
    input.sampling.seed = { status: "not_supported" };
    expect(ModelEvaluatorProfileDefinitionSchema.parse(input)).toEqual(input);
  });

  it("requires the four authority-separating prompt purposes", () => {
    for (const purpose of ["counteranalysis", "rubric", "system", "task"] as const) {
      const input = modelEvaluatorProfileDefinition();
      input.prompts = input.prompts.filter((prompt) => prompt.purpose !== purpose) as never;
      expect(() => ModelEvaluatorProfileDefinitionSchema.parse(input), purpose).toThrow(
        `requires a ${purpose} prompt`,
      );
    }
  });

  it("rejects duplicate or unordered prompts, tools, criteria, limitations, and lineage", () => {
    const prompts = modelEvaluatorProfileDefinition();
    prompts.prompts = [...prompts.prompts].reverse() as never;
    expect(() => ModelEvaluatorProfileDefinitionSchema.parse(prompts)).toThrow(
      "ordered by purpose",
    );

    const tools = modelEvaluatorProfileDefinition();
    tools.toolContracts = [tools.toolContracts[0] as never, tools.toolContracts[0] as never];
    expect(() => ModelEvaluatorProfileDefinitionSchema.parse(tools)).toThrow(
      "ordered by exact artifact reference",
    );

    const criteria = modelEvaluatorProfileDefinition();
    criteria.supportedCriteria = [
      criteria.supportedCriteria[0] as never,
      criteria.supportedCriteria[0] as never,
    ];
    expect(() => ModelEvaluatorProfileDefinitionSchema.parse(criteria)).toThrow(
      "criteria must be unique",
    );

    const limitations = modelEvaluatorProfileDefinition();
    limitations.knownLimitations = [...limitations.knownLimitations].reverse();
    expect(() => ModelEvaluatorProfileDefinitionSchema.parse(limitations)).toThrow(
      "limitations must be unique and ordered",
    );

    const lineage = modelEvaluatorProfileDefinition();
    lineage.provider.fineTuneLineage = [...lineage.provider.fineTuneLineage].reverse();
    expect(() => ModelEvaluatorProfileDefinitionSchema.parse(lineage)).toThrow(
      "Fine-tune lineage must be unique and ordered",
    );
  });

  it("requires positive validity and a stable predecessor identity", () => {
    const invalidWindow = modelEvaluatorProfileDefinition();
    invalidWindow.validUntil = invalidWindow.validFrom;
    expect(() => ModelEvaluatorProfileDefinitionSchema.parse(invalidWindow)).toThrow(
      "positive interval",
    );

    const wrongLogicalId = modelEvaluatorProfileDefinition();
    wrongLogicalId.predecessor = {
      definitionSha256: sha("9"),
      modelProfileId: "mep_other",
      modelProfileVersionId: "mpv_safety_v0",
    };
    expect(() => ModelEvaluatorProfileDefinitionSchema.parse(wrongLogicalId)).toThrow(
      "retain the logical modelProfileId",
    );

    const self = modelEvaluatorProfileDefinition();
    self.predecessor = {
      definitionSha256: sha("9"),
      modelProfileId: self.modelProfileId,
      modelProfileVersionId: self.modelProfileVersionId,
    };
    expect(() => ModelEvaluatorProfileDefinitionSchema.parse(self)).toThrow("name itself");

    const valid = modelEvaluatorProfileDefinition();
    valid.predecessor = {
      definitionSha256: sha("9"),
      modelProfileId: valid.modelProfileId,
      modelProfileVersionId: "mpv_safety_v0",
    };
    expect(ModelEvaluatorProfileDefinitionSchema.parse(valid)).toEqual(valid);
  });

  it("rejects credentials, arbitrary endpoints, mutable authority, executable prompts, and extras", () => {
    const definition = modelEvaluatorProfileDefinition();
    for (const forbidden of [
      { apiKey: "secret" },
      { endpoint: "https://example.invalid" },
      { releaseAuthority: "allow" },
      { toolExecution: "allowed" },
    ]) {
      expect(() =>
        ModelEvaluatorProfileDefinitionSchema.parse({ ...definition, ...forbidden }),
      ).toThrow();
    }
    expect(() =>
      ModelEvaluatorProfileDefinitionSchema.parse({
        ...definition,
        prompts: [
          ...definition.prompts,
          {
            executable: "process.exit()",
            purpose: "output_repair",
            template: artifact("art_prompt_repair", "9", "text/plain"),
          },
        ],
      }),
    ).toThrow();
  });

  it("enforces finite provider and cost bounds", () => {
    const invalid = [
      ["budgets", "requests", 0],
      ["budgets", "maximumCostMicrousd", -1],
      ["sampling", "temperatureMilli", 2_001],
      ["sampling", "topPBasisPoints", 0],
      ["sampling", "maximumOutputTokens", 0],
    ] as const;
    for (const [section, field, value] of invalid) {
      const input = modelEvaluatorProfileDefinition() as unknown as Record<
        string,
        Record<string, unknown>
      >;
      const target = input[section];
      if (!target) throw new Error(`Missing ${section}`);
      target[field] = value;
      expect(
        () => ModelEvaluatorProfileDefinitionSchema.parse(input),
        `${section}.${field}`,
      ).toThrow();
    }
  });
});
