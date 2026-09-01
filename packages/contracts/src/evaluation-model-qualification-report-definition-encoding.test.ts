import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODEL_QUALIFICATION_REPORT_SCHEMA_VERSION,
  type ModelQualificationReportDefinition,
} from "./evaluation-model-qualification.js";
import {
  encodeModelQualificationReportDefinition,
  MODEL_QUALIFICATION_REPORT_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface ReportVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<ModelQualificationReportDefinition>;
  readonly kind: "model_qualification_report";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly ReportVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-model-qualification-report-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): ReportVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a model qualification report vector");
  return value;
}

describe("canonical model qualification report encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-model-qualification-report-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["model_qualification_report"]);
    const value = vector();
    const encoded = encodeModelQualificationReportDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds scope, suite, model, independence, calibration, results, and exceptional counts", () => {
    const value = vector();
    const original = encodeModelQualificationReportDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(MODEL_QUALIFICATION_REPORT_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${MODEL_QUALIFICATION_REPORT_SCHEMA_VERSION}"`);

    const mutations: ((candidate: ReportVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.projectId = "prj_other";
      },
      (candidate) => {
        candidate.definition.suite.definitionSha256 = "f".repeat(64);
      },
      (candidate) => {
        candidate.definition.independenceDeclaration.definitionSha256 = "e".repeat(64);
      },
      (candidate) => {
        candidate.definition.calibrationReport.definitionSha256 = "d".repeat(64);
      },
      (candidate) => {
        candidate.definition.resultManifest.sha256 = "c".repeat(64);
      },
      (candidate) => {
        candidate.definition.statusSummary.disagreementAttemptCount += 1;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeModelQualificationReportDefinition(changed)).not.toEqual(original);
    }
  });
});
