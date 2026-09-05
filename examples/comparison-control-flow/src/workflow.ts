import {
  type ComparisonResult,
  ComparisonResultSchema,
  type PrincipalContext,
} from "@proofstack/contracts";
import {
  CreateComparisonEvidenceSnapshot,
  DeriveComparisonResult,
  MemoryComparisonRepository,
  PublishComparisonDefinition,
  ReadComparisonRecord,
} from "@proofstack/core";
import { ComparisonExperimentScenario } from "./scenario.js";

export interface RunComparisonExperimentOptions {
  readonly baselineMilliseconds: number;
  readonly candidateMilliseconds: number;
  readonly namespace: string;
}

export interface ComparisonExperimentSummary {
  readonly evidence: {
    readonly baselineMilliseconds: number;
    readonly baselineSnapshotId: string;
    readonly candidateMilliseconds: number;
    readonly candidateSnapshotId: string;
    readonly integrity: "verified";
    readonly source: "synthetic";
  };
  readonly outcome: {
    readonly delta: unknown;
    readonly direction: string;
    readonly metricId: string;
    readonly status: string;
  };
  readonly readBack: {
    readonly definitionSha256: string;
    readonly resultId: string;
    readonly resultSha256: string;
  };
}

const scope = {
  environmentId: "env_local_experiment",
  projectId: "prj_local_experiment",
  tenantId: "ten_local_experiment",
} as const;

const principal: PrincipalContext = {
  authentication: { authenticatedAt: "2026-09-02T03:00:00.000Z", method: "development" },
  capabilities: ["comparison:manage", "comparison:read"],
  principalId: "usr_local_experiment",
  principalType: "user",
  requestId: "req_local_comparison_experiment",
  resourceScope: { mode: "tenant" },
  roles: ["owner"],
  tenantId: scope.tenantId,
};

function metric(result: ComparisonResult) {
  const metricResult = result.metricResults.find(({ metricId }) => metricId === "metric_elapsed");
  /* v8 ignore next -- The strict scenario definition always requests metric_elapsed. */
  if (!metricResult) throw new TypeError("Comparison result omitted metric_elapsed");
  const value = metricResult.value;
  /* v8 ignore next -- Two verified observations make this exact metric available by contract. */
  if (value.status !== "available") {
    throw new TypeError("Comparison result marked metric_elapsed unavailable");
  }
  return { metricId: metricResult.metricId, value };
}

export async function runComparisonExperiment(
  options: RunComparisonExperimentOptions,
): Promise<ComparisonExperimentSummary> {
  const scenario = new ComparisonExperimentScenario(options);
  const repository = new MemoryComparisonRepository();
  const clock = { now: () => new Date("2026-09-02T04:00:00.000Z") };
  const commandRoute = {
    environmentId: scope.environmentId,
    principal,
    projectId: scope.projectId,
  } as const;
  const definition = (
    await new PublishComparisonDefinition({ clock, repository }).execute({
      ...commandRoute,
      comparisonId: scenario.ids.comparison,
      comparisonVersionId: scenario.ids.comparisonVersion,
      input: scenario.definition(),
    })
  ).record;
  const exactComparison = {
    comparisonId: definition.comparisonId,
    comparisonVersionId: definition.comparisonVersionId,
    definitionSha256: definition.definitionSha256,
  };
  const snapshotUseCase = new CreateComparisonEvidenceSnapshot({
    clock,
    evidenceResolver: {
      resolve: async ({ comparison, role }) => scenario.resolve(comparison, role),
    },
    repository,
  });
  const baseline = (
    await snapshotUseCase.execute({
      ...commandRoute,
      input: {
        comparison: exactComparison,
        role: "baseline",
        snapshotId: scenario.ids.snapshotBaseline,
      },
      snapshotId: scenario.ids.snapshotBaseline,
    })
  ).record;
  const candidate = (
    await snapshotUseCase.execute({
      ...commandRoute,
      input: {
        comparison: exactComparison,
        role: "candidate",
        snapshotId: scenario.ids.snapshotCandidate,
      },
      snapshotId: scenario.ids.snapshotCandidate,
    })
  ).record;
  const result = (
    await new DeriveComparisonResult({ clock, repository }).execute({
      ...commandRoute,
      input: {
        baselineSnapshot: {
          definitionSha256: baseline.definitionSha256,
          role: "baseline",
          snapshotId: baseline.snapshotId,
        },
        candidateSnapshot: {
          definitionSha256: candidate.definitionSha256,
          role: "candidate",
          snapshotId: candidate.snapshotId,
        },
        comparison: exactComparison,
        resultId: scenario.ids.result,
      },
      resultId: scenario.ids.result,
    })
  ).record;
  const readBack = ComparisonResultSchema.parse(
    await new ReadComparisonRecord(repository).execute({
      ...commandRoute,
      kind: "comparison_result",
      recordId: result.resultId,
    }),
  );
  const elapsed = metric(readBack);

  return {
    evidence: {
      baselineMilliseconds: options.baselineMilliseconds,
      baselineSnapshotId: baseline.snapshotId,
      candidateMilliseconds: options.candidateMilliseconds,
      candidateSnapshotId: candidate.snapshotId,
      integrity: baseline.integrity,
      source: "synthetic",
    },
    outcome: {
      delta: elapsed.value.delta,
      direction: elapsed.value.direction,
      metricId: elapsed.metricId,
      status: elapsed.value.status,
    },
    readBack: {
      definitionSha256: definition.definitionSha256,
      resultId: readBack.resultId,
      resultSha256: readBack.definitionSha256,
    },
  };
}
