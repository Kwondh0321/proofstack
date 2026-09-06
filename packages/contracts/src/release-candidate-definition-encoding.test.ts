import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeReleaseCandidateDefinition,
  RELEASE_CANDIDATE_DEFINITION_DOMAIN,
  RELEASE_CANDIDATE_DEFINITION_ENCODING_VERSION,
  type ScopedReleaseCandidateDefinition,
} from "./release-candidate-definition-encoding.js";
import { RELEASE_CANDIDATE_SCHEMA_VERSION } from "./release-candidate.js";

interface ReleaseCandidateVector {
  readonly encodedByteLength: number;
  readonly input: ScopedReleaseCandidateDefinition;
  readonly kind: "release_candidate";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly ReleaseCandidateVector[];
}

const document = JSON.parse(
  readFileSync(new URL("../vectors/release-candidate-definition-v1.json", import.meta.url), "utf8"),
) as VectorDocument;

function vector(): ReleaseCandidateVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a release candidate vector");
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("canonical release candidate definition encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.release-candidate-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["release_candidate"]);
    const value = vector();
    const encoded = encodeReleaseCandidateDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds the candidate domain, encoding version, schema version, and exact scope", () => {
    const encoded = encodeReleaseCandidateDefinition(vector().input);
    const text = Buffer.from(encoded).toString("utf8");
    expect(text).toContain(`"definitionDomain":"${RELEASE_CANDIDATE_DEFINITION_DOMAIN}"`);
    expect(text).toContain(`"encodingVersion":"${RELEASE_CANDIDATE_DEFINITION_ENCODING_VERSION}"`);
    expect(text).toContain(`"schemaVersion":"${RELEASE_CANDIDATE_SCHEMA_VERSION}"`);
    expect(text).toContain('"tenantId":"tenant_example"');
    expect(text).toContain('"commit":{"algorithm":"sha1"');
    expect(text).toContain('"contentProjection":"artifact_references_only"');
  });

  it("normalizes object insertion order but binds every semantic candidate input", () => {
    const input = vector().input;
    const original = encodeReleaseCandidateDefinition(input);
    const reordered = {
      definition: Object.fromEntries(Object.entries(input.definition).reverse()),
      scope: Object.fromEntries(Object.entries(input.scope).reverse()),
    } as unknown as typeof input;
    expect(encodeReleaseCandidateDefinition(reordered)).toEqual(original);

    const mutations: ((candidate: ScopedReleaseCandidateDefinition) => void)[] = [
      (candidate) => {
        candidate.scope.tenantId = "tenant_other";
      },
      (candidate) => {
        candidate.definition.source.commit.value = "e".repeat(40);
      },
      (candidate) => {
        const buildArtifact = candidate.definition.buildArtifacts[0];
        if (!buildArtifact) throw new Error("Expected a build artifact");
        buildArtifact.artifact.sha256 = "f".repeat(64);
      },
      (candidate) => {
        const assessment = candidate.definition.assessments[0];
        if (!assessment) throw new Error("Expected an assessment");
        assessment.definitionSha256 = "0".repeat(64);
      },
      (candidate) => {
        candidate.definition.target.purpose = "Changed release purpose.";
      },
      (candidate) => {
        const omission = candidate.definition.omissions[0];
        if (!omission) throw new Error("Expected an omission");
        omission.rationale = "Changed omission rationale.";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(input);
      mutate(changed);
      expect(encodeReleaseCandidateDefinition(changed)).not.toEqual(original);
    }
  });

  it("rejects cross-environment scope and metadata or authority smuggling", () => {
    const input = vector().input;
    expect(() =>
      encodeReleaseCandidateDefinition({
        ...input,
        scope: { ...input.scope, environmentId: "env_production" },
      }),
    ).toThrow(/digest scope/);

    for (const forbidden of [
      { createdAt: "2026-09-06T01:00:00.000Z" },
      { definitionSha256: "f".repeat(64) },
      { releaseDecision: "proceed" },
      { policyEvaluation: "satisfied" },
      { deploymentToken: "secret" },
    ]) {
      expect(() =>
        encodeReleaseCandidateDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
