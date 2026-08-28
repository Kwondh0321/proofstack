import { describe, expect, it } from "vitest";
import {
  ArtifactConflictError,
  ArtifactContentMismatchError,
  ArtifactIdentifierGenerationError,
  ArtifactKeyringConfigurationError,
  ArtifactNotFoundError,
  ArtifactProtectionError,
  ArtifactStateTransitionError,
} from "./errors.js";

describe("artifact errors", () => {
  it.each([
    [new ArtifactConflictError(), "artifact_conflict"],
    [new ArtifactContentMismatchError(), "artifact_content_mismatch"],
    [new ArtifactIdentifierGenerationError(), "artifact_identifier_generation_failed"],
    [new ArtifactKeyringConfigurationError(), "artifact_keyring_configuration_invalid"],
    [new ArtifactNotFoundError(), "artifact_not_found"],
    [new ArtifactProtectionError(), "artifact_protection_failed"],
    [new ArtifactStateTransitionError(), "artifact_state_transition_invalid"],
  ])("exposes a stable public code for %s", (error, code) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
    expect(error.message.length).toBeGreaterThan(0);
  });
});
