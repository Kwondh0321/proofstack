export class ArtifactContentMismatchError extends Error {
  readonly code = "artifact_content_mismatch";

  constructor() {
    super("Artifact content does not match its reserved digest and length");
    this.name = "ArtifactContentMismatchError";
  }
}

export class ArtifactProtectionError extends Error {
  readonly code = "artifact_protection_failed";

  constructor(options?: ErrorOptions) {
    super("Artifact encryption or integrity verification failed", options);
    this.name = "ArtifactProtectionError";
  }
}

export class ArtifactKeyringConfigurationError extends Error {
  readonly code = "artifact_keyring_configuration_invalid";

  constructor() {
    super("Artifact keyring configuration is invalid");
    this.name = "ArtifactKeyringConfigurationError";
  }
}

export class ArtifactConflictError extends Error {
  readonly code = "artifact_conflict";

  constructor() {
    super("Artifact identifier is already bound to different immutable metadata");
    this.name = "ArtifactConflictError";
  }
}

export class ArtifactNotFoundError extends Error {
  readonly code = "artifact_not_found";

  constructor() {
    super("Artifact was not found in the authorized scope");
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactStateTransitionError extends Error {
  readonly code = "artifact_state_transition_invalid";

  constructor() {
    super("Artifact lifecycle transition is not allowed from its current state");
    this.name = "ArtifactStateTransitionError";
  }
}
