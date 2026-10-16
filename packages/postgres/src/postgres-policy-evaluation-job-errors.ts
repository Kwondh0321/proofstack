export class PostgresPolicyEvaluationJobContractError extends Error {
  readonly code = "postgres_policy_evaluation_job_contract_invalid";
  constructor(message: string) {
    super(message);
    this.name = "PostgresPolicyEvaluationJobContractError";
  }
}
