import { describe, expect, it } from "vitest";
import {
  CALIBRATION_REPORT_SCHEMA_VERSION,
  type CalibrationReport,
  type CalibrationReportDefinition,
  CalibrationReportDefinitionSchema,
  CalibrationReportSchema,
  INDEPENDENCE_DECLARATION_SCHEMA_VERSION,
  type IndependenceDeclaration,
  type IndependenceDeclarationDefinition,
  IndependenceDeclarationDefinitionSchema,
  IndependenceDeclarationSchema,
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
