import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PublishReleaseCandidateResponseSchema,
  ReadReleaseCandidateResponseSchema,
} from "./release-candidate-api.js";
import { RELEASE_CANDIDATE_SCHEMA_VERSION } from "./release-candidate.js";

interface ReleaseCandidateVectorDocument {
  readonly vectors: readonly {
    readonly input: {
      readonly definition: Readonly<Record<string, unknown>>;
      readonly scope: Readonly<Record<string, unknown>>;
    };
    readonly sha256: string;
  }[];
}

function candidateRecord(): Readonly<Record<string, unknown>> {
  const document = JSON.parse(
    readFileSync(
      new URL("../vectors/release-candidate-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as ReleaseCandidateVectorDocument;
  const vector = document.vectors[0];
  if (!vector) throw new Error("Expected a release candidate definition vector");
  return {
    ...structuredClone(vector.input.definition),
    createdAt: "2026-09-06T15:00:00.000Z",
    createdByPrincipalId: "usr_release_candidate_api",
    definitionSha256: vector.sha256,
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    scope: structuredClone(vector.input.scope),
  };
}

describe("release candidate API contracts", () => {
  it("accepts exact publication and read receipts", () => {
    const candidate = candidateRecord();
    expect(
      PublishReleaseCandidateResponseSchema.parse({
        candidate,
        created: true,
        requestId: "req_release_candidate_api",
      }),
    ).toEqual({ candidate, created: true, requestId: "req_release_candidate_api" });
    expect(
      ReadReleaseCandidateResponseSchema.parse({
        candidate,
        requestId: "req_release_candidate_api",
      }),
    ).toEqual({ candidate, requestId: "req_release_candidate_api" });
  });

  it("rejects unknown fields and malformed candidate receipts", () => {
    const candidate = candidateRecord();
    expect(() =>
      PublishReleaseCandidateResponseSchema.parse({
        candidate,
        created: true,
        requestId: "req_release_candidate_api",
        releaseDecision: "allow",
      }),
    ).toThrow();
    expect(() =>
      ReadReleaseCandidateResponseSchema.parse({
        candidate: { ...candidate, definitionSha256: "not-a-digest" },
        requestId: "req_release_candidate_api",
      }),
    ).toThrow();
  });
});
