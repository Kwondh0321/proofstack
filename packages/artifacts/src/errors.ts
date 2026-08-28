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
