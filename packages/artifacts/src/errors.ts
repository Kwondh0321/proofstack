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

export class ArtifactOwnershipConflictError extends Error {
  readonly code = "artifact_ownership_conflict";

  constructor() {
    super("Artifact ownership is already bound to a different immutable resource");
    this.name = "ArtifactOwnershipConflictError";
  }
}

export class ArtifactOwnedDeletionError extends Error {
  readonly code = "artifact_fixture_owned";

  constructor() {
    super("Fixture-owned content must be removed through fixture content revocation");
    this.name = "ArtifactOwnedDeletionError";
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

export class ArtifactIdentifierGenerationError extends Error {
  readonly code = "artifact_identifier_generation_failed";

  constructor(options?: ErrorOptions) {
    super("Artifact storage identity generation failed", options);
    this.name = "ArtifactIdentifierGenerationError";
  }
}

export class InvalidArtifactLifecycleInputError extends TypeError {
  readonly code = "artifact_lifecycle_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidArtifactLifecycleInputError";
  }
}

export class ArtifactObjectConflictError extends Error {
  readonly code = "artifact_object_conflict";

  constructor() {
    super("Immutable artifact object does not match the reserved encrypted content");
    this.name = "ArtifactObjectConflictError";
  }
}

export class ArtifactUnavailableError extends Error {
  readonly code = "artifact_unavailable";

  constructor() {
    super("Artifact content is not available");
    this.name = "ArtifactUnavailableError";
  }
}

export class ArtifactObjectMissingError extends Error {
  readonly code = "artifact_object_missing";

  constructor() {
    super("Available artifact content is missing from object storage");
    this.name = "ArtifactObjectMissingError";
  }
}
