import type {
  ModelAssuranceRepository,
  RecordModelAssuranceCommand,
  RecordModelAssuranceDependencies,
  RecordModelAssuranceResult,
} from "@proofstack/core";
import { ForbiddenError, RecordModelAssuranceExecution } from "@proofstack/core";

export interface ModelEvaluationWorkerOperations {
  recordBlindedEvaluationResult(
    command: RecordModelAssuranceCommand<"blinded_evaluation_result">,
  ): Promise<RecordModelAssuranceResult<"blinded_evaluation_result">>;
  recordIndependentCritique(
    command: RecordModelAssuranceCommand<"independent_critique">,
  ): Promise<RecordModelAssuranceResult<"independent_critique">>;
  recordModelQualificationReport(
    command: RecordModelAssuranceCommand<"model_qualification_report">,
  ): Promise<RecordModelAssuranceResult<"model_qualification_report">>;
}

function requireServicePrincipal(command: {
  readonly principal: {
    readonly authentication: { readonly method: string };
    readonly principalType: string;
  };
}): void {
  if (
    command.principal.principalType !== "service" ||
    command.principal.authentication.method !== "service_token"
  ) {
    throw new ForbiddenError(
      "Model evaluation writes require a service principal authenticated with a service token",
    );
  }
}

export function createModelEvaluationWorkerBoundary(
  dependencies: RecordModelAssuranceDependencies & {
    readonly repository: ModelAssuranceRepository;
  },
): ModelEvaluationWorkerOperations {
  const recorder = new RecordModelAssuranceExecution(dependencies);
  return {
    async recordBlindedEvaluationResult(command) {
      requireServicePrincipal(command);
      return recorder.execute(command);
    },
    async recordIndependentCritique(command) {
      requireServicePrincipal(command);
      return recorder.execute(command);
    },
    async recordModelQualificationReport(command) {
      requireServicePrincipal(command);
      return recorder.execute(command);
    },
  };
}
