import type { IndependenceDeclaration } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  compareEvaluatorIndependence,
  InvalidIndependenceComparisonInputError,
} from "./model-assurance-independence.js";

const sha = (character: string) => character.repeat(64);
const artifact = (artifactId: string, character: string) => ({
  artifactId,
  classification: "restricted" as const,
  mediaType: "application/json",
  sha256: sha(character),
  sizeBytes: 1_024,
});

function declaration(subject: string): IndependenceDeclaration {
  const dimension = (name: string) => ({
    identifiers: [`${name}_${subject}`],
    status: "declared" as const,
  });
  return {
    declaredConflicts: [],
    definitionSha256: sha(subject === "left" ? "1" : "2"),
    dimensions: {
      baseModelFamilies: dimension("base"),
      criterionAuthors: dimension("criterion"),
      evaluatorDevelopers: dimension("developer"),
      evaluatorImplementations: dimension("implementation"),
      fineTuneLineage: dimension("fine_tune"),
      labelSources: dimension("labels"),
      operatingOrganizations: dimension("organization"),
      promptAuthors: dimension("prompt"),
      providers: dimension("provider"),
      sharedInfrastructure: dimension("infrastructure"),
    },
    independenceDeclarationId: `ind_${subject}`,
    knownLimitations: [],
    recordedAt: "2026-09-02T00:00:00.000Z",
    reviewBasis: [artifact(`art_review_${subject}`, subject === "left" ? "3" : "4")],
    reviewStatus: "verified",
    reviewedAt: "2026-09-02T00:00:00.000Z",
    reviewedByPrincipalId: `usr_reviewer_${subject}`,
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_assurance",
      projectId: "prj_assurance",
      tenantId: "ten_assurance",
    },
    subject: {
      evaluator: {
        definitionSha256: sha(subject === "left" ? "5" : "6"),
        evaluatorId: `evl_${subject}`,
        evaluatorVersionId: `evv_${subject}_v1`,
      },
      modelProfile: {
        definitionSha256: sha(subject === "left" ? "7" : "8"),
        modelProfileId: `mep_${subject}`,
        modelProfileVersionId: `mpv_${subject}_v1`,
      },
    },
    validFrom: "2026-09-02T00:00:00.000Z",
    validUntil: "2026-10-02T00:00:00.000Z",
  };
}

describe("material evaluator independence comparison", () => {
  it("forms two stable groups only when every material dimension is distinct and current", () => {
    const result = compareEvaluatorIndependence(
      declaration("left"),
      declaration("right"),
      "2026-09-15T00:00:00.000Z",
    );
    expect(result.status).toBe("independent");
    if (result.status !== "independent") throw new Error("Expected independence");
    expect(result.groupKeys).toHaveLength(2);
    expect(result.groupKeys[0]).toContain("evl_left");
    expect(result.groupKeys[1]).toContain("evl_right");
  });

  it("reports every shared material lineage dimension instead of trusting different names", () => {
    const left = declaration("left");
    const right = declaration("right");
    if (
      right.dimensions.baseModelFamilies.status !== "declared" ||
      right.dimensions.providers.status !== "declared"
    ) {
      throw new Error("Expected declared lineage");
    }
    right.dimensions.baseModelFamilies.identifiers = ["base_left"];
    right.dimensions.providers.identifiers = ["provider_left"];
    const result = compareEvaluatorIndependence(left, right, "2026-09-15T00:00:00.000Z");
    expect(result).toEqual({
      sameSubject: false,
      sharedDimensions: ["baseModelFamilies", "providers"],
      status: "correlated",
    });
  });

  it("treats the same exact evaluator and model profile as correlated", () => {
    const left = declaration("left");
    const right = declaration("right");
    right.subject = structuredClone(left.subject);
    const result = compareEvaluatorIndependence(left, right, "2026-09-15T00:00:00.000Z");
    expect(result.status).toBe("correlated");
    if (result.status !== "correlated") throw new Error("Expected correlation");
    expect(result.sameSubject).toBe(true);
  });

  it("fails closed on unknown lineage, unverifiable review, stale validity, or scope mismatch", () => {
    const left = declaration("left");
    left.dimensions.labelSources = {
      reason: "The provider did not disclose label provenance.",
      status: "unknown",
    };
    left.reviewStatus = "unverifiable";
    const right = declaration("right");
    right.scope.environmentId = "env_other";
    const result = compareEvaluatorIndependence(left, right, "2026-10-02T00:00:00.000Z");
    expect(result).toEqual({
      reasons: [
        "declaration_not_current",
        "declaration_not_verified",
        "scope_mismatch",
        "unknown_material_lineage",
      ],
      status: "unverifiable",
    });
  });

  it("rejects malformed declarations and evaluation instants", () => {
    expect(() =>
      compareEvaluatorIndependence({}, declaration("right"), "2026-09-15T00:00:00.000Z"),
    ).toThrow(InvalidIndependenceComparisonInputError);
    expect(() =>
      compareEvaluatorIndependence(declaration("left"), {}, "2026-09-15T00:00:00.000Z"),
    ).toThrow(InvalidIndependenceComparisonInputError);
    expect(() =>
      compareEvaluatorIndependence(declaration("left"), declaration("right"), "soon"),
    ).toThrow(InvalidIndependenceComparisonInputError);
  });
});
