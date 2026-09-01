import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HUMAN_REVIEWER_INDEPENDENCE_SCHEMA_VERSION,
  type HumanReviewerIndependenceDefinition,
} from "./evaluation-model-assurance.js";
import {
  encodeHumanReviewerIndependenceDefinition,
  HUMAN_REVIEWER_INDEPENDENCE_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface IndependenceVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<HumanReviewerIndependenceDefinition>;
  readonly kind: "human_reviewer_independence";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly IndependenceVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL(
      "../vectors/evaluation-human-reviewer-independence-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): IndependenceVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a human reviewer independence vector");
  return value;
}

describe("canonical human reviewer independence encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-human-reviewer-independence-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["human_reviewer_independence"]);
    const value = vector();
    const encoded = encodeHumanReviewerIndependenceDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds reviewer, affiliation, relationships, groups, review basis, and validity", () => {
    const value = vector();
    const original = encodeHumanReviewerIndependenceDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(HUMAN_REVIEWER_INDEPENDENCE_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${HUMAN_REVIEWER_INDEPENDENCE_SCHEMA_VERSION}"`);
    const changed = structuredClone(value.input);
    changed.definition.reviewerPrincipalId = "usr_other";
    expect(encodeHumanReviewerIndependenceDefinition(changed)).not.toEqual(original);
  });
});
