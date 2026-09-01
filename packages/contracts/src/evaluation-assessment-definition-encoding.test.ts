import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_SCHEMA_VERSION,
  type AssessmentDefinition,
  EVALUATION_AGGREGATE_SCHEMA_VERSION,
  EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION,
  type EvaluationAggregateDefinition,
  type EvaluationAggregationPolicyDefinition,
} from "./evaluation-assessment.js";
import {
  ASSESSMENT_DEFINITION_DOMAIN,
  encodeAssessmentDefinition,
  encodeEvaluationAggregateDefinition,
  encodeEvaluationAggregationPolicyDefinition,
  EVALUATION_AGGREGATE_DEFINITION_DOMAIN,
  EVALUATION_AGGREGATION_POLICY_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface StaticVectorBase {
  readonly encodedByteLength: number;
  readonly name: string;
  readonly sha256: string;
}

interface PolicyVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<EvaluationAggregationPolicyDefinition>;
  readonly kind: "aggregation_policy";
}

interface AggregateVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<EvaluationAggregateDefinition>;
  readonly kind: "evaluation_aggregate";
}

interface AssessmentVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<AssessmentDefinition>;
  readonly kind: "assessment";
}

type StaticVector = PolicyVector | AggregateVector | AssessmentVector;

const vectorsDocument = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-assessment-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly format: string;
  readonly vectors: readonly StaticVector[];
};

function encode(vector: StaticVector): Uint8Array {
  switch (vector.kind) {
    case "aggregation_policy":
      return encodeEvaluationAggregationPolicyDefinition(vector.input);
    case "evaluation_aggregate":
      return encodeEvaluationAggregateDefinition(vector.input);
    case "assessment":
      return encodeAssessmentDefinition(vector.input);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireVector<Kind extends StaticVector["kind"]>(kind: Kind) {
  const vector = vectorsDocument.vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Expected a ${kind} vector`);
  return vector as Extract<StaticVector, { readonly kind: Kind }>;
}

describe("canonical aggregate and assessment definition encoding", () => {
  it("matches fixed UTF-8 and SHA-256 vectors", () => {
    expect(vectorsDocument.format).toBe("proofstack.evaluation-assessment-definition.v1");
    expect(vectorsDocument.vectors.map(({ kind }) => kind)).toEqual([
      "aggregation_policy",
      "evaluation_aggregate",
      "assessment",
    ]);
    for (const vector of vectorsDocument.vectors) {
      const encoded = encode(vector);
      expect(encoded.byteLength, vector.name).toBe(vector.encodedByteLength);
      expect(sha256(encoded), vector.name).toBe(vector.sha256);
    }
  });

  it("separates policy, aggregate, and assessment domains with schema lineage", () => {
    const policyText = Buffer.from(encode(requireVector("aggregation_policy"))).toString("utf8");
    const aggregateText = Buffer.from(encode(requireVector("evaluation_aggregate"))).toString(
      "utf8",
    );
    const assessmentText = Buffer.from(encode(requireVector("assessment"))).toString("utf8");
    expect(policyText).toContain(EVALUATION_AGGREGATION_POLICY_DEFINITION_DOMAIN);
    expect(aggregateText).toContain(EVALUATION_AGGREGATE_DEFINITION_DOMAIN);
    expect(assessmentText).toContain(ASSESSMENT_DEFINITION_DOMAIN);
    expect(policyText).toContain(
      `"schemaVersion":"${EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION}"`,
    );
    expect(aggregateText).toContain(`"schemaVersion":"${EVALUATION_AGGREGATE_SCHEMA_VERSION}"`);
    expect(assessmentText).toContain(`"schemaVersion":"${ASSESSMENT_SCHEMA_VERSION}"`);
  });

  it("changes bytes for selection, members, intervals, qualifications, and rationale", () => {
    const policy = requireVector("aggregation_policy");
    const policyChanged = structuredClone(policy);
    policyChanged.input.definition.selectionSha256 = "f".repeat(64);
    expect(encode(policyChanged)).not.toEqual(encode(policy));

    const aggregate = requireVector("evaluation_aggregate");
    const memberChanged = structuredClone(aggregate);
    const member = memberChanged.input.definition.members[0];
    if (!member) throw new Error("Expected aggregate member");
    member.result.definitionSha256 = "e".repeat(64);
    expect(encode(memberChanged)).not.toEqual(encode(aggregate));
    const intervalChanged = structuredClone(aggregate);
    if (intervalChanged.input.definition.passInterval.status !== "reported") {
      throw new Error("Expected reported interval");
    }
    intervalChanged.input.definition.passInterval.interval.lowerBound = "0.09";
    expect(encode(intervalChanged)).not.toEqual(encode(aggregate));

    const assessment = requireVector("assessment");
    const qualificationChanged = structuredClone(assessment);
    const qualification = qualificationChanged.input.definition.qualifications[0];
    if (!qualification) throw new Error("Expected qualification lineage");
    qualification.definitionSha256 = "d".repeat(64);
    expect(encode(qualificationChanged)).not.toEqual(encode(assessment));
    const rationaleChanged = structuredClone(assessment);
    rationaleChanged.input.definition.supportRationale =
      "The same bounded aggregate remains contestable under a revised explicit rationale.";
    expect(encode(rationaleChanged)).not.toEqual(encode(assessment));
  });

  it("rejects forged counts, eligibility downgrade, reordered lineage, decisions, and receipts", () => {
    const aggregate = requireVector("evaluation_aggregate").input;
    const forgedCounts = structuredClone(aggregate);
    forgedCounts.definition.counts.passCount = 2;
    expect(() => encodeEvaluationAggregateDefinition(forgedCounts)).toThrow();
    const reorderedMembers = structuredClone(aggregate);
    reorderedMembers.definition.members.reverse();
    expect(() => encodeEvaluationAggregateDefinition(reorderedMembers)).toThrow();

    const assessment = requireVector("assessment").input;
    const forgedEligibility = structuredClone(assessment);
    forgedEligibility.definition.eligibility = {
      reasons: ["insufficient_coverage"],
      status: "ineligible",
    };
    expect(() => encodeAssessmentDefinition(forgedEligibility)).toThrow();
    expect(() =>
      encodeAssessmentDefinition({
        ...assessment,
        definition: { ...assessment.definition, releaseDecision: "allow" },
      } as never),
    ).toThrow();
    expect(() =>
      encodeAssessmentDefinition({ ...assessment, createdAt: "hidden" } as never),
    ).toThrow();

    const policy = requireVector("aggregation_policy").input;
    expect(() =>
      encodeEvaluationAggregationPolicyDefinition({ ...policy, publishedAt: "hidden" } as never),
    ).toThrow();
  });
});
