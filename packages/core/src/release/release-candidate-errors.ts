export class InvalidReleaseCandidateRecordInputError extends TypeError {
  readonly code = "release_candidate_record_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidReleaseCandidateRecordInputError";
  }
}

export class ReleaseCandidateVersionConflictError extends Error {
  readonly code = "release_candidate_version_conflict";

  constructor(readonly candidateVersionId: string) {
    super(
      `Release candidate version ${candidateVersionId} is already bound to different immutable semantics`,
    );
    this.name = "ReleaseCandidateVersionConflictError";
  }
}

export class ReleaseCandidateResourceConflictError extends Error {
  readonly code = "release_candidate_resource_conflict";

  constructor(readonly candidateId: string) {
    super(`Release candidate resource ${candidateId} is already bound to a different tenant scope`);
    this.name = "ReleaseCandidateResourceConflictError";
  }
}

export class ReleaseCandidateLineageError extends Error {
  readonly code = "release_candidate_lineage_invalid";

  constructor(
    readonly candidateVersionId: string,
    readonly predecessorVersionId: string,
  ) {
    super(
      `Release candidate ${candidateVersionId} references unavailable or conflicting predecessor ${predecessorVersionId}`,
    );
    this.name = "ReleaseCandidateLineageError";
  }
}

export class ReleaseCandidateRepositoryContractError extends Error {
  readonly code = "release_candidate_repository_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseCandidateRepositoryContractError";
  }
}
