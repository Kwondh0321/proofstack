export class InvalidReleaseCandidateRecordInputError extends TypeError {
  readonly code = "release_candidate_record_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidReleaseCandidateRecordInputError";
  }
}
