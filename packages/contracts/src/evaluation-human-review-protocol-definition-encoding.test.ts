import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HUMAN_REVIEW_PROTOCOL_SCHEMA_VERSION,
  type HumanReviewProtocolDefinition,
} from "./evaluation-model-assurance.js";
import {
  encodeHumanReviewProtocolDefinition,
  HUMAN_REVIEW_PROTOCOL_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface ProtocolVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<HumanReviewProtocolDefinition>;
  readonly kind: "human_review_protocol";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly ProtocolVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-human-review-protocol-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): ProtocolVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a human-review protocol vector");
  return value;
}

describe("canonical human-review protocol encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-human-review-protocol-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["human_review_protocol"]);
    const value = vector();
    const encoded = encodeHumanReviewProtocolDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds domain, scope, evidence, roles, independence, quorum, and dissent policy", () => {
    const value = vector();
    const original = encodeHumanReviewProtocolDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(HUMAN_REVIEW_PROTOCOL_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${HUMAN_REVIEW_PROTOCOL_SCHEMA_VERSION}"`);

    const mutations: ((candidate: ProtocolVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.projectId = "prj_other";
      },
      (candidate) => {
        const evidence = candidate.definition.claim.evidenceBundle[0];
        if (!evidence) throw new Error("Expected evidence");
        evidence.sha256 = "f".repeat(64);
      },
      (candidate) => {
        const role = candidate.definition.reviewerRoles[0];
        if (!role) throw new Error("Expected role");
        role.minimumReviewers += 1;
        candidate.definition.quorum.minimumCompletedReviews += 1;
      },
      (candidate) => {
        candidate.definition.independenceRequirements.minimumIndependentGroups = 1;
      },
      (candidate) => {
        candidate.definition.dissentPolicy.adjudicationRules.sha256 = "e".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeHumanReviewProtocolDefinition(changed)).not.toEqual(original);
    }
  });

  it("rejects authority to mutate evidence, grant capabilities, or release", () => {
    const input = vector().input;
    for (const forbidden of [
      { evidenceMutationPermitted: true },
      { capabilityGrant: "release:manage" },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        encodeHumanReviewProtocolDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
