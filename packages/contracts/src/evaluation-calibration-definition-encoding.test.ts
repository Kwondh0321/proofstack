import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_REPORT_SCHEMA_VERSION,
  type CalibrationReportDefinition,
} from "./evaluation-model-assurance.js";
import {
  CALIBRATION_REPORT_DEFINITION_DOMAIN,
  encodeCalibrationReportDefinition,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface Vector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<CalibrationReportDefinition>;
  readonly kind: "calibration_report";
  readonly name: string;
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-calibration-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as { readonly format: string; readonly vectors: readonly Vector[] };

function vector(): Vector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a calibration report vector");
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("canonical calibration report encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-calibration-definition.v1");
    const value = vector();
    const bytes = encodeCalibrationReportDefinition(value.input);
    expect(bytes.byteLength).toBe(value.encodedByteLength);
    expect(sha256(bytes)).toBe(value.sha256);
  });

  it("binds exact subject, slice, labels, measurements, shift, validity, and scope", () => {
    const value = vector();
    const original = encodeCalibrationReportDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(CALIBRATION_REPORT_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${CALIBRATION_REPORT_SCHEMA_VERSION}"`);

    const mutations: ((candidate: Vector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.projectId = "prj_other";
      },
      (candidate) => {
        candidate.definition.modelProfile.definitionSha256 = "9".repeat(64);
      },
      (candidate) => {
        candidate.definition.population.locale = "ko";
      },
      (candidate) => {
        candidate.definition.metrics.brierScore = "0.19";
      },
      (candidate) => {
        candidate.definition.distributionShift = {
          reason: "Current population sample unavailable",
          status: "not_assessed",
        };
        candidate.definition.status = "unavailable";
        candidate.definition.statusReasons = ["Distribution shift was not assessed"];
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeCalibrationReportDefinition(changed)).not.toEqual(original);
    }
  });

  it("rejects raw-confidence probability claims, calibration waivers, and release authority", () => {
    const input = vector().input;
    for (const forbidden of [
      { correctnessProbability: "0.99" },
      { releaseAuthority: "allow" },
      { waiveDistributionShift: true },
    ]) {
      expect(() =>
        encodeCalibrationReportDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
