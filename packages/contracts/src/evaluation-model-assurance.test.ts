import { describe, expect, it } from "vitest";
import {
  BLINDED_EVALUATION_PLAN_SCHEMA_VERSION,
  type BlindedEvaluationPlan,
  type BlindedEvaluationPlanDefinition,
  BlindedEvaluationPlanDefinitionSchema,
  BlindedEvaluationPlanSchema,
  CALIBRATION_REPORT_SCHEMA_VERSION,
  type CalibrationReport,
  type CalibrationReportDefinition,
  CalibrationReportDefinitionSchema,
  CalibrationReportSchema,
  INDEPENDENCE_DECLARATION_SCHEMA_VERSION,
  INDEPENDENT_CRITIQUE_SCHEMA_VERSION,
  type IndependentCritique,
  type IndependentCritiqueDefinition,
  IndependentCritiqueDefinitionSchema,
  IndependentCritiqueSchema,
  HUMAN_REVIEW_PROTOCOL_SCHEMA_VERSION,
  type HumanReviewProtocol,
  type HumanReviewProtocolDefinition,
  HumanReviewProtocolDefinitionSchema,
  HumanReviewProtocolSchema,
  HUMAN_REVIEW_RECORD_SCHEMA_VERSION,
  type HumanReviewRecord,
  type HumanReviewRecordDefinition,
  HumanReviewRecordDefinitionSchema,
  HumanReviewRecordSchema,
  HUMAN_REVIEWER_INDEPENDENCE_SCHEMA_VERSION,
  type HumanReviewerIndependence,
  type HumanReviewerIndependenceDefinition,
  HumanReviewerIndependenceDefinitionSchema,
  HumanReviewerIndependenceSchema,
  type IndependenceDeclaration,
  type IndependenceDeclarationDefinition,
  IndependenceDeclarationDefinitionSchema,
  IndependenceDeclarationSchema,
  MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION,
  MODEL_ASSISTED_EVALUATOR_SPEC_SCHEMA_VERSION,
  type ModelAssistedEvaluatorSpec,
  type ModelAssistedEvaluatorSpecDefinition,
  ModelAssistedEvaluatorSpecDefinitionSchema,
  ModelAssistedEvaluatorSpecSchema,
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
    riskTiers: ["critical", "high", "low", "moderate"],
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

function modelAssistedEvaluatorSpecDefinition(): ModelAssistedEvaluatorSpecDefinition {
  return {
    changeRationale: "Initial qualified model-assisted safety evaluator",
    configurationSha256: sha("9"),
    evaluatorId: "evl_model_safety",
    evaluatorVersionId: "evv_model_safety_v1",
    inputSchema: artifact("art_model_input_schema", "a", "application/schema+json"),
    kind: "model_assisted",
    knownLimitations: ["A model judgment remains contestable evidence"],
    modelProfile: {
      definitionSha256: sha("8"),
      modelProfileId: "mep_safety",
      modelProfileVersionId: "mpv_safety_v1",
    },
    outputSchema: artifact("art_model_output_schema", "1", "application/schema+json"),
    qualificationFixtureSet: {
      definitionSha256: sha("2"),
      fixtureSetId: "qfs_model_safety",
      fixtureSetVersionId: "qfv_model_safety_v1",
    },
    resultSemantics:
      "Return a five-state observation with exact evidence references and no release decision.",
    supportedCriteria: [
      {
        criterionId: "crt_no_unsafe_tool_request",
        criterionSetId: "crs_agent_safety",
        criterionSetVersionId: "csv_agent_safety_v1",
      },
    ],
  };
}

function modelAssistedEvaluatorSpec(): ModelAssistedEvaluatorSpec {
  return {
    ...modelAssistedEvaluatorSpecDefinition(),
    definitionSha256: sha("b"),
    publishedAt: "2026-09-02T00:05:00.000Z",
    publishedByPrincipalId: "usr_model_evaluator_publisher",
    schemaVersion: MODEL_ASSISTED_EVALUATOR_SPEC_SCHEMA_VERSION,
    scope,
  };
}

describe("model-assisted evaluator specification contracts", () => {
  it("binds one exact model profile and qualification corpus without provider authority", () => {
    expect(
      ModelAssistedEvaluatorSpecDefinitionSchema.parse(modelAssistedEvaluatorSpecDefinition()),
    ).toEqual(modelAssistedEvaluatorSpecDefinition());
    expect(ModelAssistedEvaluatorSpecSchema.parse(modelAssistedEvaluatorSpec())).toEqual(
      modelAssistedEvaluatorSpec(),
    );
  });

  it("keeps semantic changes versioned through stable predecessor identity", () => {
    const wrongId = modelAssistedEvaluatorSpecDefinition();
    wrongId.predecessor = {
      definitionSha256: sha("c"),
      evaluatorId: "evl_other",
      evaluatorVersionId: "evv_model_safety_v0",
    };
    expect(() => ModelAssistedEvaluatorSpecDefinitionSchema.parse(wrongId)).toThrow(
      "retain the logical evaluatorId",
    );

    const self = modelAssistedEvaluatorSpecDefinition();
    self.predecessor = {
      definitionSha256: sha("c"),
      evaluatorId: self.evaluatorId,
      evaluatorVersionId: self.evaluatorVersionId,
    };
    expect(() => ModelAssistedEvaluatorSpecDefinitionSchema.parse(self)).toThrow("name itself");

    const successor = modelAssistedEvaluatorSpecDefinition();
    successor.predecessor = {
      definitionSha256: sha("c"),
      evaluatorId: successor.evaluatorId,
      evaluatorVersionId: "evv_model_safety_v0",
    };
    expect(ModelAssistedEvaluatorSpecDefinitionSchema.parse(successor)).toEqual(successor);
  });

  it("rejects duplicate criteria, embedded credentials, destinations, prompts, and release policy", () => {
    const duplicate = modelAssistedEvaluatorSpecDefinition();
    duplicate.supportedCriteria = [
      duplicate.supportedCriteria[0] as never,
      duplicate.supportedCriteria[0] as never,
    ];
    expect(() => ModelAssistedEvaluatorSpecDefinitionSchema.parse(duplicate)).toThrow(
      "criteria must be unique",
    );

    for (const forbidden of [
      { apiKey: "secret" },
      { endpoint: "https://example.invalid" },
      { prompt: "hidden mutable prompt" },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        ModelAssistedEvaluatorSpecDefinitionSchema.parse({
          ...modelAssistedEvaluatorSpecDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});

const declared = (identifier: string) => ({
  identifiers: [identifier],
  status: "declared" as const,
});

function independenceDeclarationDefinition(): IndependenceDeclarationDefinition {
  return {
    declaredConflicts: ["The evaluator and criterion are maintained in the same repository"],
    dimensions: {
      baseModelFamilies: declared("model-family:reference"),
      criterionAuthors: declared("principal:usr_criterion_author"),
      evaluatorDevelopers: declared("principal:usr_evaluator_developer"),
      evaluatorImplementations: declared("sha256:implementation-a"),
      fineTuneLineage: declared("fine-tune:none"),
      labelSources: declared("dataset:qualification-v1"),
      operatingOrganizations: declared("organization:proofstack"),
      promptAuthors: declared("principal:usr_prompt_author"),
      providers: declared("provider:reference"),
      sharedInfrastructure: declared("infrastructure:local-harness"),
    },
    independenceDeclarationId: "ind_model_safety_v1",
    knownLimitations: ["Organizational declarations require accountable external verification"],
    reviewBasis: [artifact("art_independence_review", "a")],
    reviewStatus: "verified",
    reviewedAt: "2026-09-02T00:10:00.000Z",
    reviewedByPrincipalId: "usr_independence_reviewer",
    subject: {
      evaluator: {
        definitionSha256: sha("b"),
        evaluatorId: "evl_model_safety",
        evaluatorVersionId: "evv_model_safety_v1",
      },
      modelProfile: {
        definitionSha256: sha("8"),
        modelProfileId: "mep_safety",
        modelProfileVersionId: "mpv_safety_v1",
      },
    },
    validFrom: "2026-09-02T00:10:00.000Z",
    validUntil: "2026-12-01T00:00:00.000Z",
  };
}

function independenceDeclaration(): IndependenceDeclaration {
  return {
    ...independenceDeclarationDefinition(),
    definitionSha256: sha("c"),
    recordedAt: "2026-09-02T00:10:01.000Z",
    schemaVersion: INDEPENDENCE_DECLARATION_SCHEMA_VERSION,
    scope,
  };
}

describe("independence declaration contracts", () => {
  it("accepts a fully declared, reviewed evidence path without claiming pairwise independence", () => {
    expect(
      IndependenceDeclarationDefinitionSchema.parse(independenceDeclarationDefinition()),
    ).toEqual(independenceDeclarationDefinition());
    expect(IndependenceDeclarationSchema.parse(independenceDeclaration())).toEqual(
      independenceDeclaration(),
    );
  });

  it("fails closed when required material lineage is unknown", () => {
    const missing = independenceDeclarationDefinition() as unknown as {
      dimensions: Partial<IndependenceDeclarationDefinition["dimensions"]>;
    };
    delete missing.dimensions.providers;
    expect(() => IndependenceDeclarationDefinitionSchema.parse(missing)).toThrow();

    const verified = independenceDeclarationDefinition();
    verified.dimensions.providers = {
      reason: "The provider lineage cannot be verified from retained evidence.",
      status: "unknown",
    };
    expect(() => IndependenceDeclarationDefinitionSchema.parse(verified)).toThrow(
      "cannot contain unknown material lineage",
    );

    const unverifiable = independenceDeclarationDefinition();
    unverifiable.dimensions.providers = {
      reason: "The provider lineage cannot be verified from retained evidence.",
      status: "unknown",
    };
    unverifiable.reviewStatus = "unverifiable";
    expect(IndependenceDeclarationDefinitionSchema.parse(unverifiable)).toEqual(unverifiable);

    const unjustified = independenceDeclarationDefinition();
    unjustified.reviewStatus = "unverifiable";
    expect(() => IndependenceDeclarationDefinitionSchema.parse(unjustified)).toThrow(
      "requires unknown material lineage",
    );
  });

  it("requires review before validity and a positive validity interval", () => {
    const premature = independenceDeclarationDefinition();
    premature.validFrom = "2026-09-02T00:09:59.000Z";
    expect(() => IndependenceDeclarationDefinitionSchema.parse(premature)).toThrow(
      "cannot begin before review",
    );

    const empty = independenceDeclarationDefinition();
    empty.validUntil = empty.validFrom;
    expect(() => IndependenceDeclarationDefinitionSchema.parse(empty)).toThrow("positive interval");
  });

  it("preserves predecessor history without accepting self-reference", () => {
    const self = independenceDeclarationDefinition();
    self.predecessor = {
      definitionSha256: sha("d"),
      independenceDeclarationId: self.independenceDeclarationId,
    };
    expect(() => IndependenceDeclarationDefinitionSchema.parse(self)).toThrow("name itself");

    const successor = independenceDeclarationDefinition();
    successor.predecessor = {
      definitionSha256: sha("d"),
      independenceDeclarationId: "ind_model_safety_v0",
    };
    expect(IndependenceDeclarationDefinitionSchema.parse(successor)).toEqual(successor);
  });

  it("rejects unordered material lineage, duplicate conflicts, missing basis, and authority fields", () => {
    const lineage = independenceDeclarationDefinition();
    lineage.dimensions.providers = {
      identifiers: ["provider:z", "provider:a"],
      status: "declared",
    };
    expect(() => IndependenceDeclarationDefinitionSchema.parse(lineage)).toThrow(
      "Material lineage identifiers must be unique and ordered",
    );

    const conflicts = independenceDeclarationDefinition();
    conflicts.declaredConflicts = ["same", "same"];
    expect(() => IndependenceDeclarationDefinitionSchema.parse(conflicts)).toThrow(
      "conflicts must be unique and ordered",
    );

    const basis = independenceDeclarationDefinition();
    basis.reviewBasis = [];
    expect(() => IndependenceDeclarationDefinitionSchema.parse(basis)).toThrow();

    for (const forbidden of [
      { independent: true },
      { releaseAuthority: "allow" },
      { waiveCorrelation: true },
    ]) {
      expect(() =>
        IndependenceDeclarationDefinitionSchema.parse({
          ...independenceDeclarationDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});

function calibrationReportDefinition(): CalibrationReportDefinition {
  return {
    calibrationEvidence: [artifact("art_calibration_predictions", "d")],
    calibrationReportId: "cal_model_safety_v1",
    completedAt: "2026-09-02T00:20:00.000Z",
    criteria: [
      {
        criterionId: "crt_no_unsafe_tool_request",
        criterionSet: {
          criterionSetId: "crs_agent_safety",
          criterionSetVersionId: "csv_agent_safety_v1",
          definitionSha256: sha("e"),
        },
      },
    ],
    dataset: {
      datasetId: "dst_model_calibration",
      datasetVersionId: "dsv_model_calibration_v1",
      definitionSha256: sha("f"),
    },
    distributionShift: {
      evidence: [artifact("art_shift_evidence", "1")],
      method: "Population stability index v1 over declared feature summaries",
      status: "no_shift_detected",
    },
    evaluator: {
      definitionSha256: sha("b"),
      evaluatorId: "evl_model_safety",
      evaluatorVersionId: "evv_model_safety_v1",
    },
    executedByPrincipalId: "svc_calibration_worker",
    knownLimitations: ["Synthetic labels do not establish production-distribution calibration"],
    labelSources: [artifact("art_calibration_labels", "2")],
    method: {
      configurationSha256: sha("3"),
      implementationSha256: sha("4"),
      kind: "histogram_binning",
      methodVersion: "1.0.0",
    },
    metrics: {
      brierScore: "0.18",
      expectedCalibrationError: {
        value: "0.09",
        variant: "equal_width_absolute",
      },
      logLoss: "0.55",
      reliabilityBins: [
        {
          lowerBoundBasisPoints: 0,
          meanPredictedProbability: { status: "available", value: "0.20" },
          observedPositiveFrequency: { status: "available", value: "0.25" },
          positiveCount: 10,
          sampleCount: 40,
          upperBoundBasisPoints: 5_000,
        },
        {
          lowerBoundBasisPoints: 5_000,
          meanPredictedProbability: { status: "available", value: "0.80" },
          observedPositiveFrequency: { status: "available", value: "0.833333333333333333" },
          positiveCount: 50,
          sampleCount: 60,
          upperBoundBasisPoints: 10_000,
        },
      ],
      selectiveRisk: [
        { errorCount: 2, selectedCount: 25, totalCount: 100 },
        { errorCount: 20, selectedCount: 100, totalCount: 100 },
      ],
    },
    modelProfile: {
      definitionSha256: sha("8"),
      modelProfileId: "mep_safety",
      modelProfileVersionId: "mpv_safety_v1",
    },
    population: {
      locale: "en",
      populationTags: ["agent:tool-using", "deployment:test"],
      riskTier: "high",
      taskKindIds: ["task_code_change", "task_tool_use"],
    },
    qualificationReport: {
      definitionSha256: sha("5"),
      qualificationReportId: "qlr_model_safety_v1",
    },
    sampleSummary: {
      excludedCount: 10,
      includedCount: 100,
      minimumRequiredCount: 100,
      negativeCount: 40,
      positiveCount: 60,
      totalCount: 110,
    },
    startedAt: "2026-09-02T00:15:00.000Z",
    status: "calibrated",
    statusReasons: [],
    validFrom: "2026-09-02T00:20:00.000Z",
    validUntil: "2026-10-02T00:20:00.000Z",
  };
}

function calibrationReport(): CalibrationReport {
  return {
    ...calibrationReportDefinition(),
    definitionSha256: sha("6"),
    recordedAt: "2026-09-02T00:20:01.000Z",
    schemaVersion: CALIBRATION_REPORT_SCHEMA_VERSION,
    scope,
  };
}

describe("calibration report contracts", () => {
  it("accepts exact slice-specific empirical calibration without renaming raw confidence", () => {
    expect(CalibrationReportDefinitionSchema.parse(calibrationReportDefinition())).toEqual(
      calibrationReportDefinition(),
    );
    expect(CalibrationReportSchema.parse(calibrationReport())).toEqual(calibrationReport());
  });

  it("reconstructs included, excluded, positive, and negative counts exactly", () => {
    const total = calibrationReportDefinition();
    total.sampleSummary.totalCount += 1;
    expect(() => CalibrationReportDefinitionSchema.parse(total)).toThrow(
      "included and excluded counts",
    );

    const labels = calibrationReportDefinition();
    labels.sampleSummary.positiveCount -= 1;
    expect(() => CalibrationReportDefinitionSchema.parse(labels)).toThrow(
      "positive and negative counts",
    );
  });

  it("requires reliability bins to partition probability space and reconstruct labels", () => {
    const interval = calibrationReportDefinition();
    const intervalBin = interval.metrics.reliabilityBins[0];
    if (!intervalBin) throw new Error("Expected a first reliability bin");
    intervalBin.upperBoundBasisPoints = intervalBin.lowerBoundBasisPoints;
    expect(() => CalibrationReportDefinitionSchema.parse(interval)).toThrow(
      "requires a positive interval",
    );

    const gap = calibrationReportDefinition();
    const second = gap.metrics.reliabilityBins[1];
    if (!second) throw new Error("Expected a second reliability bin");
    second.lowerBoundBasisPoints = 5_001;
    expect(() => CalibrationReportDefinitionSchema.parse(gap)).toThrow(
      "ordered complete partition",
    );

    const counts = calibrationReportDefinition();
    const first = counts.metrics.reliabilityBins[0];
    if (!first) throw new Error("Expected a first reliability bin");
    first.sampleCount += 1;
    expect(() => CalibrationReportDefinitionSchema.parse(counts)).toThrow(
      "reconstruct included labels",
    );

    const positive = calibrationReportDefinition();
    const positiveBin = positive.metrics.reliabilityBins[0];
    if (!positiveBin) throw new Error("Expected a first reliability bin");
    positiveBin.positiveCount = positiveBin.sampleCount + 1;
    expect(() => CalibrationReportDefinitionSchema.parse(positive)).toThrow(
      "positiveCount cannot exceed sampleCount",
    );
  });

  it("makes empty-bin measurements unavailable and non-empty measurements available", () => {
    const empty = calibrationReportDefinition();
    const nonempty = empty.metrics.reliabilityBins[1];
    if (!nonempty) throw new Error("Expected a non-empty reliability bin");
    empty.metrics.reliabilityBins = [
      {
        lowerBoundBasisPoints: 0,
        meanPredictedProbability: { reason: "empty_bin", status: "unavailable" },
        observedPositiveFrequency: { reason: "empty_bin", status: "unavailable" },
        positiveCount: 0,
        sampleCount: 0,
        upperBoundBasisPoints: 1_000,
      },
      {
        ...nonempty,
        lowerBoundBasisPoints: 1_000,
        positiveCount: 60,
        sampleCount: 100,
        upperBoundBasisPoints: 10_000,
      },
    ] as never;
    expect(CalibrationReportDefinitionSchema.parse(empty)).toEqual(empty);

    const unavailableNonempty = calibrationReportDefinition();
    const first = unavailableNonempty.metrics.reliabilityBins[0];
    if (!first) throw new Error("Expected a first reliability bin");
    first.meanPredictedProbability = { reason: "empty_bin", status: "unavailable" };
    expect(() => CalibrationReportDefinitionSchema.parse(unavailableNonempty)).toThrow(
      "available exactly when the bin is non-empty",
    );
  });

  it("requires selective risk to use the included denominator and increasing coverage", () => {
    const overSelected = calibrationReportDefinition();
    const overSelectedPoint = overSelected.metrics.selectiveRisk[0];
    if (!overSelectedPoint) throw new Error("Expected a selective-risk point");
    overSelectedPoint.selectedCount = overSelectedPoint.totalCount + 1;
    expect(() => CalibrationReportDefinitionSchema.parse(overSelected)).toThrow(
      "selectedCount cannot exceed totalCount",
    );

    const denominator = calibrationReportDefinition();
    const first = denominator.metrics.selectiveRisk[0];
    if (!first) throw new Error("Expected a selective-risk point");
    first.totalCount = 99;
    expect(() => CalibrationReportDefinitionSchema.parse(denominator)).toThrow(
      "included denominator",
    );

    const order = calibrationReportDefinition();
    const second = order.metrics.selectiveRisk[1];
    if (!second) throw new Error("Expected a second selective-risk point");
    second.selectedCount = 25;
    expect(() => CalibrationReportDefinitionSchema.parse(order)).toThrow("increasing coverage");

    const impossible = calibrationReportDefinition();
    const point = impossible.metrics.selectiveRisk[0];
    if (!point) throw new Error("Expected a selective-risk point");
    point.errorCount = point.selectedCount + 1;
    expect(() => CalibrationReportDefinitionSchema.parse(impossible)).toThrow(
      "errorCount cannot exceed selectedCount",
    );
  });

  it("fails calibrated status closed on insufficient labels, shift, or status reasons", () => {
    const insufficient = calibrationReportDefinition();
    insufficient.sampleSummary.minimumRequiredCount = 101;
    expect(() => CalibrationReportDefinitionSchema.parse(insufficient)).toThrow(
      "requires sufficient mixed labels",
    );

    const shifted = calibrationReportDefinition();
    shifted.distributionShift = {
      evidence: [artifact("art_shift_detected", "7")],
      method: "Population stability index v1 over declared feature summaries",
      status: "shift_detected",
    };
    expect(() => CalibrationReportDefinitionSchema.parse(shifted)).toThrow(
      "requires sufficient mixed labels",
    );

    const reason = calibrationReportDefinition();
    reason.statusReasons = ["Calibration is known to be incomplete"];
    expect(() => CalibrationReportDefinitionSchema.parse(reason)).toThrow(
      "requires sufficient mixed labels",
    );
  });

  it("accepts unavailable calibration only with an explicit reason", () => {
    const unavailable = calibrationReportDefinition();
    unavailable.status = "unavailable";
    unavailable.statusReasons = ["Current population shift was not assessed"];
    unavailable.distributionShift = {
      reason: "No current population feature sample was retained.",
      status: "not_assessed",
    };
    expect(CalibrationReportDefinitionSchema.parse(unavailable)).toEqual(unavailable);

    unavailable.statusReasons = [];
    expect(() => CalibrationReportDefinitionSchema.parse(unavailable)).toThrow(
      "requires at least one status reason",
    );
  });

  it("enforces chronological validity and immutable predecessor history", () => {
    const completion = calibrationReportDefinition();
    completion.completedAt = "2026-09-02T00:14:59.000Z";
    expect(() => CalibrationReportDefinitionSchema.parse(completion)).toThrow(
      "cannot precede its start",
    );

    const validity = calibrationReportDefinition();
    validity.validFrom = "2026-09-02T00:19:59.000Z";
    expect(() => CalibrationReportDefinitionSchema.parse(validity)).toThrow(
      "cannot begin before completion",
    );

    const emptyWindow = calibrationReportDefinition();
    emptyWindow.validUntil = emptyWindow.validFrom;
    expect(() => CalibrationReportDefinitionSchema.parse(emptyWindow)).toThrow("positive interval");

    const self = calibrationReportDefinition();
    self.predecessor = {
      calibrationReportId: self.calibrationReportId,
      definitionSha256: sha("8"),
    };
    expect(() => CalibrationReportDefinitionSchema.parse(self)).toThrow("name itself");
  });

  it("rejects unordered slice identity and caller-authored probability or release authority", () => {
    const tags = calibrationReportDefinition();
    tags.population.populationTags = [...tags.population.populationTags].reverse();
    expect(() => CalibrationReportDefinitionSchema.parse(tags)).toThrow(
      "population tags must be unique and ordered",
    );

    for (const forbidden of [
      { correctnessProbability: "0.99" },
      { releaseAuthority: "allow" },
      { waiveDistributionShift: true },
    ]) {
      expect(() =>
        CalibrationReportDefinitionSchema.parse({
          ...calibrationReportDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});

function blindedEvaluationPlanDefinition(): BlindedEvaluationPlanDefinition {
  return {
    attempts: [
      { attemptId: "bat_01", presentationId: "prs_ab", seed: 11 },
      { attemptId: "bat_02", presentationId: "prs_ba", seed: 22 },
    ],
    attemptsPerOrder: 1,
    blindMap: artifact("art_blind_map", "7"),
    blindedPlanId: "blp_safety",
    blindedPlanVersionId: "blv_safety_v1",
    calibrationReport: {
      calibrationReportId: "cal_model_safety_v1",
      definitionSha256: sha("6"),
    },
    criteria: [
      {
        criterionId: "crt_no_unsafe_tool_request",
        criterionSet: {
          criterionSetId: "crs_agent_safety",
          criterionSetVersionId: "csv_agent_safety_v1",
          definitionSha256: sha("e"),
        },
      },
    ],
    evaluator: {
      definitionSha256: sha("b"),
      evaluatorId: "evl_model_safety",
      evaluatorVersionId: "evv_model_safety_v1",
    },
    independenceDeclaration: {
      definitionSha256: sha("c"),
      independenceDeclarationId: "ind_model_safety_v1",
    },
    leakageChecks: [
      {
        checkId: "chk_content",
        evidence: artifact("art_leak_content", "8"),
        kind: "content",
        status: "passed",
      },
      {
        checkId: "chk_identifier",
        evidence: artifact("art_leak_identifier", "9"),
        kind: "identifier",
        status: "passed",
      },
      {
        checkId: "chk_metadata",
        evidence: artifact("art_leak_metadata", "a"),
        kind: "metadata",
        status: "passed",
      },
    ],
    maskingMethod:
      "Replace subject identity, origin metadata, and order markers before evaluator access.",
    modelProfile: {
      definitionSha256: sha("8"),
      modelProfileId: "mep_safety",
      modelProfileVersionId: "mpv_safety_v1",
    },
    opaqueLabels: ["sample_alpha", "sample_beta"],
    planStatus: "valid",
    presentations: [
      { labels: ["sample_alpha", "sample_beta"], presentationId: "prs_ab" },
      { labels: ["sample_beta", "sample_alpha"], presentationId: "prs_ba" },
    ],
    redactionReport: artifact("art_blind_redaction", "b"),
    statusReasons: [],
    subjectArtifacts: [artifact("art_subject_one", "c"), artifact("art_subject_two", "d")],
    validFrom: "2026-09-02T00:30:00.000Z",
    validUntil: "2026-09-03T00:30:00.000Z",
  };
}

function blindedEvaluationPlan(): BlindedEvaluationPlan {
  return {
    ...blindedEvaluationPlanDefinition(),
    definitionSha256: sha("e"),
    publishedAt: "2026-09-02T00:30:00.000Z",
    publishedByPrincipalId: "usr_blind_plan_publisher",
    schemaVersion: BLINDED_EVALUATION_PLAN_SCHEMA_VERSION,
    scope,
  };
}

describe("blinded evaluation plan contracts", () => {
  it("freezes two exact subject artifacts and both opaque presentation orders", () => {
    expect(BlindedEvaluationPlanDefinitionSchema.parse(blindedEvaluationPlanDefinition())).toEqual(
      blindedEvaluationPlanDefinition(),
    );
    expect(BlindedEvaluationPlanSchema.parse(blindedEvaluationPlan())).toEqual(
      blindedEvaluationPlan(),
    );
  });

  it("rejects revealing, duplicate, unordered, or non-reversed labels", () => {
    const revealing = blindedEvaluationPlanDefinition();
    revealing.opaqueLabels = ["baseline", "sample_beta"];
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(revealing)).toThrow(
      "cannot reveal subject identity",
    );

    const duplicate = blindedEvaluationPlanDefinition();
    duplicate.opaqueLabels = ["sample_alpha", "sample_alpha"];
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(duplicate)).toThrow(
      "must be unique and ordered",
    );

    const reversal = blindedEvaluationPlanDefinition();
    reversal.presentations[1] = {
      labels: ["sample_alpha", "sample_beta"],
      presentationId: "prs_ba",
    };
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(reversal)).toThrow(
      "ordered exact reversals",
    );
  });

  it("requires a finite predeclared attempt set for every order", () => {
    const missing = blindedEvaluationPlanDefinition();
    missing.attempts = [
      missing.attempts[0] as never,
      {
        attemptId: "bat_02",
        presentationId: "prs_ab",
        seed: 22,
      },
    ];
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(missing)).toThrow(
      "predeclared number of attempts",
    );

    const undeclared = blindedEvaluationPlanDefinition();
    undeclared.attempts[1] = {
      attemptId: "bat_02",
      presentationId: "prs_other",
      seed: 22,
    };
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(undeclared)).toThrow(
      "declared presentation",
    );

    const unordered = blindedEvaluationPlanDefinition();
    unordered.attempts = [...unordered.attempts].reverse();
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(unordered)).toThrow(
      "ordered by attemptId",
    );
  });

  it("requires all three leakage classes and a restricted blind map for a valid plan", () => {
    const missingKind = blindedEvaluationPlanDefinition();
    const third = missingKind.leakageChecks[2];
    if (!third) throw new Error("Expected a third leakage check");
    third.kind = "content";
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(missingKind)).toThrow(
      "cover content, identifier, and metadata",
    );

    const failed = blindedEvaluationPlanDefinition();
    const first = failed.leakageChecks[0];
    if (!first) throw new Error("Expected a leakage check");
    first.status = "failed";
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(failed)).toThrow(
      "requires a restricted map, passed checks",
    );

    const map = blindedEvaluationPlanDefinition();
    map.blindMap.classification = "confidential";
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(map)).toThrow(
      "requires a restricted map, passed checks",
    );
  });

  it("accepts invalid plans only with reasons and preserves predecessor history", () => {
    const invalid = blindedEvaluationPlanDefinition();
    invalid.planStatus = "invalid";
    invalid.statusReasons = ["A content leakage check failed"];
    const check = invalid.leakageChecks[0];
    if (!check) throw new Error("Expected a leakage check");
    check.status = "failed";
    expect(BlindedEvaluationPlanDefinitionSchema.parse(invalid)).toEqual(invalid);

    invalid.statusReasons = [];
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(invalid)).toThrow(
      "requires at least one status reason",
    );

    const self = blindedEvaluationPlanDefinition();
    self.predecessor = {
      blindedPlanId: self.blindedPlanId,
      blindedPlanVersionId: self.blindedPlanVersionId,
      definitionSha256: sha("f"),
    };
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(self)).toThrow("name itself");
  });

  it("requires positive validity and rejects unblinding, dropped orders, and release authority", () => {
    const validity = blindedEvaluationPlanDefinition();
    validity.validUntil = validity.validFrom;
    expect(() => BlindedEvaluationPlanDefinitionSchema.parse(validity)).toThrow(
      "positive interval",
    );

    for (const forbidden of [
      { dropUnfavorableOrder: true },
      { releaseAuthority: "allow" },
      { unblindBeforeEvaluation: true },
    ]) {
      expect(() =>
        BlindedEvaluationPlanDefinitionSchema.parse({
          ...blindedEvaluationPlanDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});

export function independentCritiqueDefinition(): IndependentCritiqueDefinition {
  return {
    accessAttestation: {
      attestedAt: "2026-09-02T01:00:01.000Z",
      evidence: artifact("art_critique_access_attestation", "1"),
      status: "original_judgment_withheld",
    },
    allowedEvidence: [
      artifact("art_critique_evidence_one", "2"),
      artifact("art_critique_evidence_two", "3"),
    ],
    calibrationReport: {
      calibrationReportId: "cal_model_safety_v1",
      definitionSha256: sha("4"),
    },
    completedAt: "2026-09-02T01:01:00.000Z",
    criterion: {
      criterionId: "crt_no_unsafe_tool_request",
      criterionSet: {
        criterionSetId: "crs_agent_safety",
        criterionSetVersionId: "csv_agent_safety_v1",
        definitionSha256: sha("5"),
      },
    },
    critiqueId: "crq_observation_safety_v1",
    evaluator: {
      definitionSha256: sha("6"),
      evaluatorId: "evl_model_critic",
      evaluatorVersionId: "evv_model_critic_v1",
    },
    evidenceAccessManifest: artifact("art_critique_access_manifest", "7"),
    independenceDeclaration: {
      definitionSha256: sha("8"),
      independenceDeclarationId: "ind_model_critic_v1",
    },
    modelProfile: {
      definitionSha256: sha("9"),
      modelProfileId: "mep_critic",
      modelProfileVersionId: "mpv_critic_v1",
    },
    observation: {
      definitionSha256: sha("a"),
      observationId: "obs_primary_judgment_v1",
    },
    outcome: {
      findings: [
        {
          evidence: [artifact("art_finding_counterexample", "b")],
          findingId: "cfd_counterexample",
          impact: "opposes",
          kind: "counterexample",
          summary: "The allowed evidence contains a tool request outside the declared scope.",
        },
        {
          evidence: [artifact("art_finding_injection", "c")],
          findingId: "cfd_injection_signal",
          impact: "uncertain",
          kind: "injection_signal",
          summary: "Retrieved content includes instructions that may have influenced the judgment.",
        },
      ],
      output: artifact("art_critique_output", "d"),
      status: "produced",
    },
    qualificationReport: {
      definitionSha256: sha("e"),
      qualificationReportId: "qlr_model_critic_v1",
    },
    question: artifact("art_critique_question", "f", "text/plain"),
    rationaleAccess: "withheld_until_critique_recorded",
    selectedAt: "2026-09-02T01:00:00.000Z",
    startedAt: "2026-09-02T01:00:02.000Z",
  };
}

function independentCritique(): IndependentCritique {
  return {
    ...independentCritiqueDefinition(),
    definitionSha256: sha("0"),
    recordedAt: "2026-09-02T01:01:01.000Z",
    recordedByPrincipalId: "wrk_model_critique_recorder",
    schemaVersion: INDEPENDENT_CRITIQUE_SCHEMA_VERSION,
    scope,
  };
}

describe("independent critique contracts", () => {
  it("accepts a critic selected before rationale-withholding attestation and execution", () => {
    expect(IndependentCritiqueDefinitionSchema.parse(independentCritiqueDefinition())).toEqual(
      independentCritiqueDefinition(),
    );
    expect(IndependentCritiqueSchema.parse(independentCritique())).toEqual(independentCritique());
  });

  it("requires critic selection, withholding attestation, execution, and completion in order", () => {
    const earlyAttestation = independentCritiqueDefinition();
    earlyAttestation.accessAttestation.attestedAt = "2026-09-02T00:59:59.000Z";
    expect(() => IndependentCritiqueDefinitionSchema.parse(earlyAttestation)).toThrow(
      "cannot precede critic selection",
    );

    const earlyStart = independentCritiqueDefinition();
    earlyStart.startedAt = "2026-09-02T01:00:00.000Z";
    expect(() => IndependentCritiqueDefinitionSchema.parse(earlyStart)).toThrow(
      "cannot begin before withholding is attested",
    );

    const earlyCompletion = independentCritiqueDefinition();
    earlyCompletion.completedAt = "2026-09-02T01:00:01.000Z";
    expect(() => IndependentCritiqueDefinitionSchema.parse(earlyCompletion)).toThrow(
      "cannot precede execution start",
    );
  });

  it("requires exact ordered evidence and findings", () => {
    const evidence = independentCritiqueDefinition();
    evidence.allowedEvidence = [...evidence.allowedEvidence].reverse();
    expect(() => IndependentCritiqueDefinitionSchema.parse(evidence)).toThrow(
      "ordered by exact artifact reference",
    );

    const findings = independentCritiqueDefinition();
    if (findings.outcome.status !== "produced") throw new Error("Expected produced critique");
    findings.outcome.findings = [...findings.outcome.findings].reverse();
    expect(() => IndependentCritiqueDefinitionSchema.parse(findings)).toThrow(
      "ordered by findingId",
    );
  });

  it("records abstention and typed errors without fabricating findings", () => {
    const abstained = independentCritiqueDefinition();
    abstained.outcome = {
      evidence: [artifact("art_abstention_evidence", "b")],
      reasons: ["The available evidence does not establish the relevant execution context"],
      status: "abstained",
    };
    expect(IndependentCritiqueDefinitionSchema.parse(abstained)).toEqual(abstained);

    const failed = independentCritiqueDefinition();
    failed.outcome = {
      code: "output_malformed",
      evidence: [],
      reason: "The provider response did not satisfy the exact output schema.",
      status: "error",
    };
    expect(IndependentCritiqueDefinitionSchema.parse(failed)).toEqual(failed);
  });

  it("rejects access to original judgment and any release or adjudication authority", () => {
    for (const forbidden of [
      { originalRationale: artifact("art_original_rationale", "1") },
      { originalVerdict: "pass" },
      { adjudication: "accept" },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        IndependentCritiqueDefinitionSchema.parse({
          ...independentCritiqueDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});

export function humanReviewProtocolDefinition(): HumanReviewProtocolDefinition {
  return {
    accessibility: {
      accommodationProcess: artifact("art_accommodation_process", "1", "text/plain"),
      requiredLocales: ["en", "ko"],
    },
    allowedActions: [
      "abstain",
      "oppose",
      "recuse",
      "request_changes",
      "require_escalation",
      "support",
    ],
    claim: {
      criteria: [
        {
          criterionId: "crt_no_unsafe_tool_request",
          criterionSet: {
            criterionSetId: "crs_agent_safety",
            criterionSetVersionId: "csv_agent_safety_v1",
            definitionSha256: sha("2"),
          },
        },
      ],
      description:
        "Review whether the exact recorded agent action satisfies the no-unsafe-tool-request criterion.",
      evidenceBundle: [
        artifact("art_review_agent_trace", "3"),
        artifact("art_review_counterevidence", "4"),
      ],
      riskTier: "high",
    },
    conflictPolicy: {
      disclosureRequired: true,
      forbiddenRelationships: ["criterion author", "evaluated agent operator"],
      recusalRequiredOnConflict: true,
      unverifiableIndependenceAction: "require_escalation",
    },
    dissentPolicy: {
      adjudicationRules: artifact("art_review_adjudication_rules", "5", "text/plain"),
      dissentPreservation: "append_only",
      minorityRationaleRequired: true,
      unresolvedDissentAction: "require_escalation",
    },
    escalationTriggers: [
      "critical_counterevidence",
      "material_conflict",
      "protocol_expired",
      "quorum_shortfall",
      "unresolved_dissent",
      "unverifiable_independence",
    ],
    independenceRequirements: {
      declarationRequired: true,
      minimumIndependentGroups: 2,
      modelOnlyQuorumPermitted: false,
      sameOrganizationPermitted: false,
    },
    knownLimitations: [
      "Credential evidence does not prove current expertise",
      "Reviewer declarations do not prove honesty",
    ],
    protocolId: "hrp_agent_safety",
    protocolVersionId: "hrv_agent_safety_v1",
    quorum: {
      abstentionsCountTowardQuorum: false,
      minimumCompletedReviews: 2,
      recusalsCountTowardQuorum: false,
    },
    rationalePolicy: {
      freeTextArtifactRequired: true,
      minimumStructuredReasons: 1,
      sourceCitationsRequired: true,
    },
    reviewerRoles: [
      {
        credentialRequirements: [artifact("art_domain_credential_rules", "6")],
        expertiseAreas: ["agent tool semantics", "task domain"],
        minimumReviewers: 1,
        roleId: "role_domain_reviewer",
        trainingRequirements: [artifact("art_domain_training_rules", "7")],
      },
      {
        credentialRequirements: [artifact("art_safety_credential_rules", "8")],
        expertiseAreas: ["agent safety", "evidence review"],
        minimumReviewers: 1,
        roleId: "role_safety_reviewer",
        trainingRequirements: [artifact("art_safety_training_rules", "9")],
      },
    ],
    supersessionPolicy: {
      correctionMode: "append_superseding_record",
      originalVisibility: "retained",
      protocolPinning: "exact_version",
    },
    timePolicy: {
      maximumReviewMilliseconds: 3_600_000,
      reviewExpiryMilliseconds: 86_400_000,
    },
    validFrom: "2026-09-02T02:00:00.000Z",
    validUntil: "2026-12-01T02:00:00.000Z",
  };
}

function humanReviewProtocol(): HumanReviewProtocol {
  return {
    ...humanReviewProtocolDefinition(),
    definitionSha256: sha("a"),
    publishedAt: "2026-09-02T02:00:00.000Z",
    publishedByPrincipalId: "usr_review_protocol_publisher",
    schemaVersion: HUMAN_REVIEW_PROTOCOL_SCHEMA_VERSION,
    scope,
  };
}

describe("human review protocol contracts", () => {
  it("accepts an exact accountable protocol with independent role and quorum requirements", () => {
    expect(HumanReviewProtocolDefinitionSchema.parse(humanReviewProtocolDefinition())).toEqual(
      humanReviewProtocolDefinition(),
    );
    expect(HumanReviewProtocolSchema.parse(humanReviewProtocol())).toEqual(humanReviewProtocol());
  });

  it("requires abstention, recusal, and escalation safeguards", () => {
    for (const action of ["abstain", "recuse", "require_escalation"] as const) {
      const input = humanReviewProtocolDefinition();
      input.allowedActions = input.allowedActions.filter((candidate) => candidate !== action);
      expect(() => HumanReviewProtocolDefinitionSchema.parse(input), action).toThrow(
        `requires the ${action} safeguard action`,
      );
    }
  });

  it("rejects a quorum below role counts or independence requirements", () => {
    const roles = humanReviewProtocolDefinition();
    roles.quorum.minimumCompletedReviews = 1;
    expect(() => HumanReviewProtocolDefinitionSchema.parse(roles)).toThrow(
      "cannot be smaller than the required role counts",
    );

    const groups = humanReviewProtocolDefinition();
    groups.independenceRequirements.minimumIndependentGroups = 3;
    expect(() => HumanReviewProtocolDefinitionSchema.parse(groups)).toThrow(
      "cannot exceed the completed-review quorum",
    );
  });

  it("requires ordered identity, evidence, locale, conflict, and escalation fields", () => {
    const roles = humanReviewProtocolDefinition();
    roles.reviewerRoles = [...roles.reviewerRoles].reverse();
    expect(() => HumanReviewProtocolDefinitionSchema.parse(roles)).toThrow("ordered by roleId");

    const evidence = humanReviewProtocolDefinition();
    evidence.claim.evidenceBundle = [...evidence.claim.evidenceBundle].reverse();
    expect(() => HumanReviewProtocolDefinitionSchema.parse(evidence)).toThrow(
      "ordered by exact artifact reference",
    );

    const locales = humanReviewProtocolDefinition();
    locales.accessibility.requiredLocales = ["ko", "en"];
    expect(() => HumanReviewProtocolDefinitionSchema.parse(locales)).toThrow(
      "locales must be unique and ordered",
    );

    const triggers = humanReviewProtocolDefinition();
    triggers.escalationTriggers = [...triggers.escalationTriggers].reverse();
    expect(() => HumanReviewProtocolDefinitionSchema.parse(triggers)).toThrow(
      "must be complete, unique, and ordered",
    );
  });

  it("preserves version history and rejects release, capability, and evidence mutation fields", () => {
    const self = humanReviewProtocolDefinition();
    self.predecessor = {
      definitionSha256: sha("b"),
      protocolId: self.protocolId,
      protocolVersionId: self.protocolVersionId,
    };
    expect(() => HumanReviewProtocolDefinitionSchema.parse(self)).toThrow("name itself");

    const invalidWindow = humanReviewProtocolDefinition();
    invalidWindow.validUntil = invalidWindow.validFrom;
    expect(() => HumanReviewProtocolDefinitionSchema.parse(invalidWindow)).toThrow(
      "positive interval",
    );

    for (const forbidden of [
      { capabilityGrant: "release:manage" },
      { evidenceMutationPermitted: true },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        HumanReviewProtocolDefinitionSchema.parse({
          ...humanReviewProtocolDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});

export function humanReviewerIndependenceDefinition(): HumanReviewerIndependenceDefinition {
  return {
    affiliations: ["org:independent-safety-lab"],
    conflicts: [],
    declarationId: "hri_reviewer_v1",
    independenceGroupIds: ["hig_independent_safety_lab"],
    relationships: ["reviewer:external-contractor"],
    reviewBasis: [artifact("art_human_independence_review", "1")],
    reviewedAt: "2026-09-02T02:30:00.000Z",
    reviewedByPrincipalId: "usr_independence_reviewer",
    reviewerPrincipalId: "usr_independent_reviewer",
    status: "verified",
    statusReasons: [],
    validFrom: "2026-09-02T02:30:00.000Z",
    validUntil: "2026-10-02T02:30:00.000Z",
  };
}

function humanReviewerIndependence(): HumanReviewerIndependence {
  return {
    ...humanReviewerIndependenceDefinition(),
    definitionSha256: sha("2"),
    recordedAt: "2026-09-02T02:30:01.000Z",
    schemaVersion: HUMAN_REVIEWER_INDEPENDENCE_SCHEMA_VERSION,
    scope,
  };
}

describe("human reviewer independence contracts", () => {
  it("binds one reviewer to reviewed affiliations, relationships, and material groups", () => {
    expect(
      HumanReviewerIndependenceDefinitionSchema.parse(humanReviewerIndependenceDefinition()),
    ).toEqual(humanReviewerIndependenceDefinition());
    expect(HumanReviewerIndependenceSchema.parse(humanReviewerIndependence())).toEqual(
      humanReviewerIndependence(),
    );
  });

  it("fails verified status closed on conflict or status reason", () => {
    const conflict = humanReviewerIndependenceDefinition();
    conflict.conflicts = ["Reviewer authored the evaluated criterion"];
    expect(() => HumanReviewerIndependenceDefinitionSchema.parse(conflict)).toThrow(
      "cannot retain conflicts",
    );

    const reason = humanReviewerIndependenceDefinition();
    reason.statusReasons = ["Employment relationship could not be verified"];
    expect(() => HumanReviewerIndependenceDefinitionSchema.parse(reason)).toThrow(
      "cannot retain conflicts",
    );
  });

  it("requires reasons for unverifiable or rejected status", () => {
    const unverifiable = humanReviewerIndependenceDefinition();
    unverifiable.status = "unverifiable";
    expect(() => HumanReviewerIndependenceDefinitionSchema.parse(unverifiable)).toThrow(
      "requires at least one status reason",
    );
    unverifiable.statusReasons = ["Affiliation evidence is incomplete"];
    expect(HumanReviewerIndependenceDefinitionSchema.parse(unverifiable)).toEqual(unverifiable);
  });

  it("requires reviewed chronological validity and append-only predecessor history", () => {
    const early = humanReviewerIndependenceDefinition();
    early.validFrom = "2026-09-02T02:29:59.000Z";
    expect(() => HumanReviewerIndependenceDefinitionSchema.parse(early)).toThrow(
      "cannot begin before review",
    );

    const window = humanReviewerIndependenceDefinition();
    window.validUntil = window.validFrom;
    expect(() => HumanReviewerIndependenceDefinitionSchema.parse(window)).toThrow(
      "positive interval",
    );

    const self = humanReviewerIndependenceDefinition();
    self.predecessor = { declarationId: self.declarationId, definitionSha256: sha("3") };
    expect(() => HumanReviewerIndependenceDefinitionSchema.parse(self)).toThrow("name itself");
  });
});

export function humanReviewRecordDefinition(): HumanReviewRecordDefinition {
  return {
    action: "support",
    assessment: {
      assessmentId: "asm_agent_safety_v1",
      definitionSha256: sha("1"),
    },
    completedAt: "2026-09-02T03:20:00.000Z",
    conflicts: [],
    counterevidence: [artifact("art_review_counterevidence", "2")],
    credentialEvidence: [artifact("art_reviewer_credential", "3")],
    critiques: [
      {
        critiqueId: "crq_observation_safety_v1",
        definitionSha256: sha("4"),
      },
    ],
    evidenceAccessManifest: artifact("art_human_access_manifest", "5"),
    expertiseEvidence: [artifact("art_reviewer_expertise", "6")],
    expiresAt: "2026-09-03T03:20:00.000Z",
    independenceDeclaration: {
      declarationId: "hri_reviewer_v1",
      definitionSha256: sha("7"),
    },
    observations: [
      {
        definitionSha256: sha("8"),
        observationId: "obs_primary_judgment_v1",
      },
    ],
    protocol: {
      definitionSha256: sha("9"),
      protocolId: "hrp_agent_safety",
      protocolVersionId: "hrv_agent_safety_v1",
    },
    rationale: artifact("art_human_review_rationale", "a", "text/plain"),
    relationships: [],
    reviewId: "hrr_agent_safety_reviewer_one",
    reviewedArtifacts: [
      artifact("art_reviewed_assessment", "b"),
      artifact("art_reviewed_trace", "c"),
    ],
    reviewer: {
      authenticatedAt: "2026-09-02T03:00:00.000Z",
      authenticationMethod: "oidc",
      credentialId: "oidc_reviewer_credential",
      principalId: "usr_independent_reviewer",
      principalType: "user",
      requestId: "req_human_review_0001",
      sessionEvidence: artifact("art_reviewer_session", "d"),
      sessionId: "ses_human_review_0001",
    },
    reviewerRoleId: "role_domain_reviewer",
    sourceCitations: [artifact("art_review_source_citation", "e")],
    startedAt: "2026-09-02T03:00:01.000Z",
    structuredReasons: ["exact_evidence_supports_criterion"],
    trainingEvidence: [artifact("art_reviewer_training", "f")],
  };
}

function humanReviewRecord(): HumanReviewRecord {
  return {
    ...humanReviewRecordDefinition(),
    definitionSha256: sha("0"),
    recordedAt: "2026-09-02T03:20:01.000Z",
    schemaVersion: HUMAN_REVIEW_RECORD_SCHEMA_VERSION,
    scope,
  };
}

describe("human review record contracts", () => {
  it("binds one authenticated user to exact protocol, evidence, review, and rationale lineage", () => {
    expect(HumanReviewRecordDefinitionSchema.parse(humanReviewRecordDefinition())).toEqual(
      humanReviewRecordDefinition(),
    );
    expect(HumanReviewRecordSchema.parse(humanReviewRecord())).toEqual(humanReviewRecord());
  });

  it("requires authentication, review, completion, and expiry in order", () => {
    const earlyStart = humanReviewRecordDefinition();
    earlyStart.startedAt = "2026-09-02T02:59:59.000Z";
    expect(() => HumanReviewRecordDefinitionSchema.parse(earlyStart)).toThrow(
      "cannot begin before reviewer authentication",
    );

    const earlyCompletion = humanReviewRecordDefinition();
    earlyCompletion.completedAt = "2026-09-02T03:00:00.000Z";
    expect(() => HumanReviewRecordDefinitionSchema.parse(earlyCompletion)).toThrow(
      "cannot precede its start",
    );

    const expired = humanReviewRecordDefinition();
    expired.expiresAt = expired.completedAt;
    expect(() => HumanReviewRecordDefinitionSchema.parse(expired)).toThrow(
      "expiry must follow completion",
    );
  });

  it("forces disclosed conflicts to produce recusal and requires a reason for recusal", () => {
    const conflicted = humanReviewRecordDefinition();
    conflicted.conflicts = ["Reviewer operates the evaluated agent"];
    expect(() => HumanReviewRecordDefinitionSchema.parse(conflicted)).toThrow("must recuse");

    conflicted.action = "recuse";
    expect(HumanReviewRecordDefinitionSchema.parse(conflicted)).toEqual(conflicted);

    const unexplained = humanReviewRecordDefinition();
    unexplained.action = "recuse";
    expect(() => HumanReviewRecordDefinitionSchema.parse(unexplained)).toThrow(
      "requires at least one disclosed conflict",
    );
  });

  it("requires exact ordered observation, critique, artifact, and citation references", () => {
    const observations = humanReviewRecordDefinition();
    observations.observations = [
      observations.observations[0] as never,
      observations.observations[0] as never,
    ];
    expect(() => HumanReviewRecordDefinitionSchema.parse(observations)).toThrow(
      "ordered by exact reference",
    );

    const artifacts = humanReviewRecordDefinition();
    artifacts.reviewedArtifacts = [...artifacts.reviewedArtifacts].reverse();
    expect(() => HumanReviewRecordDefinitionSchema.parse(artifacts)).toThrow(
      "ordered by exact artifact reference",
    );

    const missingCitation = humanReviewRecordDefinition();
    missingCitation.sourceCitations = [];
    expect(() => HumanReviewRecordDefinitionSchema.parse(missingCitation)).toThrow();
  });

  it("appends corrections without self-supersession or decision authority", () => {
    const correction = humanReviewRecordDefinition();
    correction.reviewId = "hrr_agent_safety_reviewer_one_correction";
    correction.supersedes = {
      definitionSha256: sha("1"),
      reviewId: "hrr_agent_safety_reviewer_one",
    };
    expect(HumanReviewRecordDefinitionSchema.parse(correction)).toEqual(correction);

    correction.supersedes.reviewId = correction.reviewId;
    expect(() => HumanReviewRecordDefinitionSchema.parse(correction)).toThrow("supersede itself");

    for (const forbidden of [
      { criterionMutation: true },
      { evidenceMutation: true },
      { releaseAuthority: "allow" },
      { verdictOverride: "pass" },
    ]) {
      expect(() =>
        HumanReviewRecordDefinitionSchema.parse({
          ...humanReviewRecordDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});
