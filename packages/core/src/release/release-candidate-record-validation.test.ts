import { readFileSync } from "node:fs";
import {
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { InvalidReleaseCandidateRecordInputError } from "./release-candidate-errors.js";
import {
  digestReleaseCandidateDefinition,
  releaseCandidateReference,
  validateReleaseCandidateRecord,
} from "./release-candidate-record-validation.js";

interface VectorDocument {
  readonly vectors: readonly {
    readonly input: {
      readonly definition: ReleaseCandidateDefinition;
      readonly scope: ReleaseCandidate["scope"];
    };
  }[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/release-candidate-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function candidate(): ReleaseCandidate {
  const input = document.vectors[0]?.input;
  if (!input) throw new Error("Expected a release candidate vector");
  const definition = structuredClone(input.definition);
  const scope = structuredClone(input.scope);
  return {
    ...definition,
    createdAt: "2026-09-06T14:00:00.000Z",
    createdByPrincipalId: "principal_release_publisher",
    definitionSha256: digestReleaseCandidateDefinition(scope, definition),
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    scope,
  };
}

describe("release candidate record validation", () => {
  it("accepts a strict record with an independently recomputed canonical digest", () => {
    const value = candidate();
    expect(validateReleaseCandidateRecord(value)).toEqual(value);
    expect(releaseCandidateReference(value)).toEqual({
      candidateId: value.candidateId,
      candidateVersionId: value.candidateVersionId,
      definitionSha256: value.definitionSha256,
    });
  });

  it("excludes server receipt metadata but binds every semantic candidate field", () => {
    const value = candidate();
    const changedReceipt = {
      ...value,
      createdAt: "2026-09-06T14:00:01.000Z",
      createdByPrincipalId: "principal_retry",
    };
    expect(validateReleaseCandidateRecord(changedReceipt)).toEqual(changedReceipt);

    const changedSemantics = structuredClone(value);
    changedSemantics.target.purpose = "A changed release purpose.";
    expect(() => validateReleaseCandidateRecord(changedSemantics)).toThrow(
      /invalid canonical definition digest/,
    );
  });

  it("rejects malformed, forged, and metadata-smuggling records with a stable error", () => {
    const value = candidate();
    for (const invalid of [
      { ...value, definitionSha256: "0".repeat(64) },
      { ...value, policyEvaluation: "satisfied" },
      { ...value, releaseDecision: "proceed" },
      { ...value, deploymentToken: "secret" },
      { ...value, scope: { ...value.scope, environmentId: "env_production" } },
    ]) {
      expect(() => validateReleaseCandidateRecord(invalid)).toThrow(
        InvalidReleaseCandidateRecordInputError,
      );
    }
  });

  it("rejects receipt fields passed into the digest definition boundary", () => {
    const value = candidate();
    expect(() =>
      digestReleaseCandidateDefinition(value.scope, {
        ...value,
        definitionSha256: value.definitionSha256,
      } as never),
    ).toThrow();
  });
});
