import {
  type ComparisonDefinition,
  OpaqueIdSchema,
  type PublishComparisonDefinitionRequest,
  PublishComparisonDefinitionRequestSchema,
} from "@proofstack/contracts";
import type { ComparisonEvidenceResolution } from "@proofstack/core";
import { comparisonDefinitionTemplate, comparisonSnapshotTemplate } from "./templates.js";

export interface ComparisonExperimentScenarioOptions {
  readonly baselineMilliseconds: number;
  readonly candidateMilliseconds: number;
  readonly namespace: string;
}

export interface ComparisonScenario {
  readonly ids: {
    readonly comparison: string;
    readonly comparisonVersion: string;
    readonly result: string;
    readonly snapshotBaseline: string;
    readonly snapshotCandidate: string;
  };
  definition(): PublishComparisonDefinitionRequest;
  resolve(
    comparison: ComparisonDefinition,
    role: "baseline" | "candidate",
  ): ComparisonEvidenceResolution;
}

export class ComparisonExperimentScenario implements ComparisonScenario {
  readonly baselineMilliseconds: number;
  readonly candidateMilliseconds: number;
  readonly ids: {
    readonly comparison: string;
    readonly comparisonVersion: string;
    readonly result: string;
    readonly snapshotBaseline: string;
    readonly snapshotCandidate: string;
  };

  constructor(options: ComparisonExperimentScenarioOptions) {
    if (!/^[a-z0-9]{1,20}$/.test(options.namespace)) {
      throw new TypeError("Comparison namespace must contain 1-20 lowercase characters or digits");
    }
    for (const [name, value] of [
      ["baselineMilliseconds", options.baselineMilliseconds],
      ["candidateMilliseconds", options.candidateMilliseconds],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`);
      }
    }
    this.baselineMilliseconds = options.baselineMilliseconds;
    this.candidateMilliseconds = options.candidateMilliseconds;
    const id = (prefix: string): string => OpaqueIdSchema.parse(`${prefix}_${options.namespace}`);
    this.ids = Object.freeze({
      comparison: id("comparison_latency"),
      comparisonVersion: id("comparison_latency_v1"),
      result: id("result_latency"),
      snapshotBaseline: id("snapshot_baseline"),
      snapshotCandidate: id("snapshot_candidate"),
    });
  }

  definition() {
    const definitionTemplate = comparisonDefinitionTemplate();
    const {
      comparisonId: _comparisonId,
      predecessor: _predecessor,
      ...request
    } = structuredClone(definitionTemplate);
    return PublishComparisonDefinitionRequestSchema.parse({
      ...request,
      comparisonVersionId: this.ids.comparisonVersion,
      description:
        "Run the real exact comparison engine against synthetic baseline and candidate evidence",
      name: `Latency experiment ${this.ids.comparisonVersion}`,
    });
  }

  resolve(
    comparison: ComparisonDefinition,
    role: "baseline" | "candidate",
  ): ComparisonEvidenceResolution {
    const snapshotTemplate = comparisonSnapshotTemplate();
    const subject = comparison[role];
    const fixture = subject.fixtures[0];
    const templateFixture = snapshotTemplate.fixtures[0];
    /* v8 ignore next -- Both inputs passed strict schemas that require at least one fixture. */
    if (!fixture || !templateFixture) throw new TypeError("Comparison vector omitted its fixture");
    return {
      dataset: structuredClone(subject.dataset),
      fixtures: [
        {
          artifacts: [
            { artifact: structuredClone(fixture.replay.result), availability: "available" },
          ],
          assurance: [
            ...fixture.assessments.map((reference) => ({
              eligibility: "ineligible" as const,
              kind: "assessment" as const,
              reasons: ["human_review_required" as const],
              reference: structuredClone(reference),
            })),
            ...fixture.modelAssuranceAssessments.map((reference) => ({
              eligibility: "eligible" as const,
              kind: "model_assurance" as const,
              reasons: [],
              reference: structuredClone(reference),
            })),
          ],
          evaluationOutcomes: [],
          fixture: structuredClone(fixture.fixture),
          numericObservations: [],
          replay: structuredClone(fixture.replay),
          safetyEvents: [],
          trace: structuredClone(templateFixture.trace),
          usage: [
            {
              dimension: "elapsedMilliseconds",
              value: {
                amount:
                  role === "baseline" ? this.baselineMilliseconds : this.candidateMilliseconds,
                observedCount: 1,
                sources: ["measured"],
                status: "available",
                unavailableCount: 0,
              },
            },
          ],
        },
      ],
      integrity: "verified",
      knownLimitations: [
        "This local experiment uses deterministic synthetic evidence; it does not claim production performance.",
      ],
      omissions: [],
      sourceCutoff: fixture.replay.completedAt,
    };
  }
}
