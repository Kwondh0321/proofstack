import { describe, expect, it } from "vitest";
import {
  ArtifactConflictError,
  ArtifactContentInspectionConfigurationError,
  ArtifactContentInspectionUnavailableError,
  ArtifactContentMismatchError,
  ArtifactContentRejectedError,
  ArtifactIdentifierGenerationError,
  ArtifactKeyringConfigurationError,
  ArtifactNotFoundError,
  ArtifactObjectConflictError,
  ArtifactObjectMissingError,
  ArtifactProtectionError,
  ArtifactStateTransitionError,
  ArtifactUnavailableError,
  InvalidArtifactLifecycleInputError,
} from "./errors.js";

describe("artifact errors", () => {
  it.each([
    [new ArtifactConflictError(), "artifact_conflict"],
    [
      new ArtifactContentInspectionConfigurationError(),
      "artifact_content_inspection_configuration_invalid",
    ],
    [new ArtifactContentInspectionUnavailableError(), "artifact_content_inspection_unavailable"],
    [new ArtifactContentMismatchError(), "artifact_content_mismatch"],
    [new ArtifactContentRejectedError(), "artifact_content_rejected"],
    [new ArtifactIdentifierGenerationError(), "artifact_identifier_generation_failed"],
    [new ArtifactKeyringConfigurationError(), "artifact_keyring_configuration_invalid"],
    [new ArtifactNotFoundError(), "artifact_not_found"],
    [new ArtifactObjectConflictError(), "artifact_object_conflict"],
    [new ArtifactObjectMissingError(), "artifact_object_missing"],
    [new ArtifactProtectionError(), "artifact_protection_failed"],
    [new ArtifactStateTransitionError(), "artifact_state_transition_invalid"],
    [new ArtifactUnavailableError(), "artifact_unavailable"],
    [new InvalidArtifactLifecycleInputError("Invalid input"), "artifact_lifecycle_input_invalid"],
  ])("exposes a stable public code for %s", (error, code) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
    expect(error.message.length).toBeGreaterThan(0);
  });
});
