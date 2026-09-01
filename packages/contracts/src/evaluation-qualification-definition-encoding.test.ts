import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_FIXTURE_SET_SCHEMA_VERSION,
  type QualificationFixtureSetDefinition,
  QUALIFICATION_REPORT_SCHEMA_VERSION,
  type QualificationReportDefinition,
} from "./evaluation-spec.js";
import {
  encodeQualificationFixtureSetDefinition,
  encodeQualificationReportDefinition,
  QUALIFICATION_FIXTURE_SET_DEFINITION_DOMAIN,
  QUALIFICATION_REPORT_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface StaticVectorBase {
  readonly encodedByteLength: number;
  readonly name: string;
  readonly sha256: string;
}

interface FixtureSetVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<QualificationFixtureSetDefinition>;
  readonly kind: "qualification_fixture_set";
}

interface ReportVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<QualificationReportDefinition>;
  readonly kind: "qualification_report";
}

type StaticVector = FixtureSetVector | ReportVector;

const vectorsDocument = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-qualification-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly format: string;
  readonly vectors: readonly StaticVector[];
};

function encode(vector: StaticVector): Uint8Array {
  return vector.kind === "qualification_fixture_set"
    ? encodeQualificationFixtureSetDefinition(vector.input)
    : encodeQualificationReportDefinition(vector.input);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireVector<Kind extends StaticVector["kind"]>(kind: Kind) {
  const vector = vectorsDocument.vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Expected a ${kind} vector`);
  return vector as Extract<StaticVector, { readonly kind: Kind }>;
}

describe("canonical evaluator qualification definition encoding", () => {
  it("matches fixed UTF-8 and SHA-256 vectors", () => {
    expect(vectorsDocument.format).toBe("proofstack.evaluation-qualification-definition.v1");
    expect(vectorsDocument.vectors.map(({ kind }) => kind)).toEqual([
      "qualification_fixture_set",
      "qualification_report",
    ]);
    for (const vector of vectorsDocument.vectors) {
      const encoded = encode(vector);
      expect(encoded.byteLength, vector.name).toBe(vector.encodedByteLength);
      expect(sha256(encoded), vector.name).toBe(vector.sha256);
    }
  });

  it("separates fixture and report domains and binds schema lineage", () => {
    const fixtureText = Buffer.from(encode(requireVector("qualification_fixture_set"))).toString(
      "utf8",
    );
    const reportText = Buffer.from(encode(requireVector("qualification_report"))).toString("utf8");
    expect(fixtureText).toContain(QUALIFICATION_FIXTURE_SET_DEFINITION_DOMAIN);
    expect(reportText).toContain(QUALIFICATION_REPORT_DEFINITION_DOMAIN);
    expect(fixtureText).toContain(`"schemaVersion":"${QUALIFICATION_FIXTURE_SET_SCHEMA_VERSION}"`);
    expect(reportText).toContain(`"schemaVersion":"${QUALIFICATION_REPORT_SCHEMA_VERSION}"`);
  });

  it("changes bytes for case expectations, fixtures, evidence, policy, subject, and validity", () => {
    const fixtureSet = requireVector("qualification_fixture_set");
    const originalFixtureSet = encode(fixtureSet);
    const expectationChanged = structuredClone(fixtureSet);
    const boundary = expectationChanged.input.definition.cases.find(
      ({ caseKind }) => caseKind === "boundary",
    );
    if (!boundary) throw new Error("Expected boundary case");
    boundary.expectedOutcome = "fail";
    expect(encode(expectationChanged)).not.toEqual(originalFixtureSet);
    const fixtureChanged = structuredClone(fixtureSet);
    const firstCase = fixtureChanged.input.definition.cases[0];
    if (!firstCase) throw new Error("Expected qualification case");
    firstCase.fixture.definitionSha256 = "f".repeat(64);
    expect(encode(fixtureChanged)).not.toEqual(originalFixtureSet);

    const report = requireVector("qualification_report");
    const originalReport = encode(report);
    const evidenceChanged = structuredClone(report);
    const firstResult = evidenceChanged.input.definition.caseResults[0];
    const firstEvidence = firstResult?.rawEvidence[0];
    if (!firstEvidence) throw new Error("Expected raw qualification evidence");
    firstEvidence.sha256 = "f".repeat(64);
    expect(encode(evidenceChanged)).not.toEqual(originalReport);
    const policyChanged = structuredClone(report);
    policyChanged.input.definition.policy.definitionSha256 = "e".repeat(64);
    expect(encode(policyChanged)).not.toEqual(originalReport);
    const subjectChanged = structuredClone(report);
    if (subjectChanged.input.definition.subject.kind !== "evaluator") {
      throw new Error("Expected evaluator subject");
    }
    subjectChanged.input.definition.subject.evaluator.definitionSha256 = "d".repeat(64);
    expect(encode(subjectChanged)).not.toEqual(originalReport);
    const validityChanged = structuredClone(report);
    validityChanged.input.definition.validUntil = "2027-01-01T00:00:00Z";
    expect(encode(validityChanged)).not.toEqual(originalReport);
  });

  it("rejects hidden cases, forged summaries, mutable receipts, and reordered evidence", () => {
    const fixtureSet = requireVector("qualification_fixture_set").input;
    const reordered = structuredClone(fixtureSet);
    reordered.definition.cases.reverse();
    expect(() => encodeQualificationFixtureSetDefinition(reordered)).toThrow();
    expect(() =>
      encodeQualificationFixtureSetDefinition({ ...fixtureSet, publishedAt: "hidden" } as never),
    ).toThrow();

    const report = requireVector("qualification_report").input;
    const forged = structuredClone(report);
    forged.definition.summary.matchedCount = 8;
    forged.definition.summary.mismatchedCount = 1;
    expect(() => encodeQualificationReportDefinition(forged)).toThrow();
    expect(() =>
      encodeQualificationReportDefinition({ ...report, recordedAt: "hidden" } as never),
    ).toThrow();
    expect(() =>
      encodeQualificationReportDefinition({
        ...report,
        definition: { ...report.definition, releaseDecision: "allow" },
      } as never),
    ).toThrow();
  });
});
