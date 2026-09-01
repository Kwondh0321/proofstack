import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HUMAN_REVIEW_RECORD_SCHEMA_VERSION,
  type HumanReviewRecordDefinition,
} from "./evaluation-model-assurance.js";
import {
  encodeHumanReviewRecordDefinition,
  HUMAN_REVIEW_RECORD_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface ReviewVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<HumanReviewRecordDefinition>;
  readonly kind: "human_review_record";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly ReviewVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-human-review-record-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): ReviewVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a human-review record vector");
  return value;
}

describe("canonical human-review record encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-human-review-record-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["human_review_record"]);
    const value = vector();
    const encoded = encodeHumanReviewRecordDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds scope, authenticated reviewer, protocol, evidence, action, and rationale", () => {
    const value = vector();
    const original = encodeHumanReviewRecordDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(HUMAN_REVIEW_RECORD_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${HUMAN_REVIEW_RECORD_SCHEMA_VERSION}"`);

    const mutations: ((candidate: ReviewVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.environmentId = "env_other";
      },
      (candidate) => {
        candidate.definition.reviewer.sessionId = "ses_other";
      },
      (candidate) => {
        candidate.definition.protocol.definitionSha256 = "f".repeat(64);
      },
      (candidate) => {
        const evidence = candidate.definition.reviewedArtifacts[0];
        if (!evidence) throw new Error("Expected reviewed artifact");
        evidence.sha256 = "e".repeat(64);
      },
      (candidate) => {
        candidate.definition.action = "oppose";
      },
      (candidate) => {
        candidate.definition.rationale.sha256 = "d".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeHumanReviewRecordDefinition(changed)).not.toEqual(original);
    }
  });

  it("rejects evidence mutation, verdict override, capability grant, and release authority", () => {
    const input = vector().input;
    for (const forbidden of [
      { evidenceMutation: true },
      { verdictOverride: "pass" },
      { capabilityGrant: "release:manage" },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        encodeHumanReviewRecordDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
