import type { PrincipalContext } from "@proofstack/contracts";
import {
  CreateEvaluationAggregate,
  type EvaluationRepository,
  ForbiddenError,
  RecordEvaluationRunResult,
  RecordQualificationReport,
  RecordRawObservation,
  type RecordEvaluationCommand,
  type RecordEvaluationDependencies,
  type RecordEvaluationResult,
} from "@proofstack/core";

export interface EvaluationWorkerOperations {
  createEvaluationAggregate(
    command: RecordEvaluationCommand<"evaluation_aggregate">,
  ): Promise<RecordEvaluationResult<"evaluation_aggregate">>;
  recordEvaluationRunResult(
    command: RecordEvaluationCommand<"evaluation_run_result">,
  ): Promise<RecordEvaluationResult<"evaluation_run_result">>;
  recordQualificationReport(
    command: RecordEvaluationCommand<"qualification_report">,
  ): Promise<RecordEvaluationResult<"qualification_report">>;
  recordRawObservation(
    command: RecordEvaluationCommand<"raw_observation">,
  ): Promise<RecordEvaluationResult<"raw_observation">>;
}

interface EvaluationWorkerUseCases {
  readonly createEvaluationAggregate: CreateEvaluationAggregate;
  readonly recordEvaluationRunResult: RecordEvaluationRunResult;
  readonly recordQualificationReport: RecordQualificationReport;
  readonly recordRawObservation: RecordRawObservation;
}

function requireServicePrincipal(principal: PrincipalContext): void {
  if (
    principal.principalType !== "service" ||
    principal.authentication.method !== "service_token"
  ) {
    throw new ForbiddenError(
      "Evaluation worker writes require a service principal authenticated with a service token",
    );
  }
}

export function createEvaluationWorkerBoundary(
  dependencies: RecordEvaluationDependencies & { readonly repository: EvaluationRepository },
): EvaluationWorkerOperations {
  const useCases: EvaluationWorkerUseCases = {
    createEvaluationAggregate: new CreateEvaluationAggregate(dependencies),
    recordEvaluationRunResult: new RecordEvaluationRunResult(dependencies),
    recordQualificationReport: new RecordQualificationReport(dependencies),
    recordRawObservation: new RecordRawObservation(dependencies),
  };
  return {
    async createEvaluationAggregate(command) {
      requireServicePrincipal(command.principal);
      return useCases.createEvaluationAggregate.execute(command);
    },
    async recordEvaluationRunResult(command) {
      requireServicePrincipal(command.principal);
      return useCases.recordEvaluationRunResult.execute(command);
    },
    async recordQualificationReport(command) {
      requireServicePrincipal(command.principal);
      return useCases.recordQualificationReport.execute(command);
    },
    async recordRawObservation(command) {
      requireServicePrincipal(command.principal);
      return useCases.recordRawObservation.execute(command);
    },
  };
}
