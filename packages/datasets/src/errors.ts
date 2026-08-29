export class RegressionVersionConflictError extends Error {
  readonly code = "regression_version_conflict";

  constructor() {
    super("Regression version is already bound to a different immutable definition");
    this.name = "RegressionVersionConflictError";
  }
}

export class RegressionVersionNotFoundError extends Error {
  readonly code = "regression_version_not_found";

  constructor() {
    super("Regression version was not found in the authorized scope");
    this.name = "RegressionVersionNotFoundError";
  }
}

export class RegressionVersionLineageError extends Error {
  readonly code = "regression_version_lineage_invalid";

  constructor() {
    super("Regression version lineage is invalid for the authorized logical resource");
    this.name = "RegressionVersionLineageError";
  }
}

export class RegressionArtifactBindingError extends Error {
  readonly code = "regression_artifact_binding_invalid";

  constructor() {
    super("Interaction fixture artifacts are unavailable or ineligible for exclusive ownership");
    this.name = "RegressionArtifactBindingError";
  }
}

export class RegressionFixtureContentRevocationConflictError extends Error {
  readonly code = "regression_fixture_content_revocation_conflict";

  constructor() {
    super("Fixture content has already been revoked under a different immutable decision");
    this.name = "RegressionFixtureContentRevocationConflictError";
  }
}

export class InvalidRegressionVersionInputError extends TypeError {
  readonly code = "regression_version_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidRegressionVersionInputError";
  }
}

export class RegressionRepositoryContractError extends Error {
  readonly code = "regression_repository_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegressionRepositoryContractError";
  }
}
