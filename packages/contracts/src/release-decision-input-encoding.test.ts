import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceScopeSchema } from "./evidence.js";
import { encodePolicyEvaluationRequestDefinition } from "./policy-evaluation-request-encoding.js";
import { encodeReleaseDecisionInputDefinition } from "./release-decision-input-encoding.js";
import { ReleaseDecisionInputDefinitionSchema } from "./release-decision-input.js";

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/release-decision-input-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    encodedByteLength: number;
    sha256: string;
    input: { definition: unknown; scope: unknown };
  }[];
};
function input(index = 0) {
  const vector = document.vectors[index];
  if (!vector) throw new Error("Missing decision input vector");
  return {
    definition: ReleaseDecisionInputDefinitionSchema.parse(
      structuredClone(vector.input.definition),
    ),
    scope: EvidenceScopeSchema.parse(vector.input.scope),
  };
}
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("decision input canonical binding", () => {
  it.each(document.vectors.map((vector, index) => ({ ...vector, index })))(
    "matches independent Python UTF-8/hash vector $name",
    (vector) => {
      const value = input(vector.index);
      const bytes = encodeReleaseDecisionInputDefinition(value);
      expect(bytes.byteLength).toBe(vector.encodedByteLength);
      expect(sha(bytes)).toBe(vector.sha256);
      for (const entry of value.definition.evaluations) {
        expect(
          sha(
            encodePolicyEvaluationRequestDefinition({
              scope: value.scope,
              definition: entry.request,
            }),
          ),
        ).toBe(entry.requestSha256);
      }
    },
  );

  it("binds native creation, original authentication, limits, intent and every child hash", () => {
    const value = input();
    const original = sha(encodeReleaseDecisionInputDefinition(value));
    const changes = [
      { rationale: "A different explicit rationale." },
      { decisionInputRequestId: "decision_another" },
      { expiresAt: "2026-10-15T12:10:00.000002Z" },
      { publisher: { ...value.definition.publisher, requestId: "later-authentication" } },
      { publisher: { ...value.definition.publisher, credentialId: "credential_later" } },
      { verificationLimits: { ...value.definition.verificationLimits, maxApprovalRecords: 4095 } },
      {
        evaluations: value.definition.evaluations.map((entry) => ({
          ...entry,
          requestSha256: "f".repeat(64),
        })),
      },
    ];
    for (const change of changes)
      expect(
        sha(
          encodeReleaseDecisionInputDefinition({
            ...value,
            definition: { ...value.definition, ...change },
          }),
        ),
      ).not.toBe(original);
    const later = structuredClone(value);
    later.definition.createdAt = "2026-10-15T12:00:00.000002Z";
    for (const entry of later.definition.evaluations)
      entry.request.evaluationTime = later.definition.createdAt;
    expect(sha(encodeReleaseDecisionInputDefinition(later))).not.toBe(original);
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects a mismatched %s envelope",
    (field) => {
      const value = input();
      expect(() =>
        encodeReleaseDecisionInputDefinition({
          ...value,
          scope: { ...value.scope, [field]: "different_scope" },
        }),
      ).toThrow(/canonical digest scope/);
    },
  );

  it("is independent of object key insertion order and returns owned bytes", () => {
    const value = input();
    const original = encodeReleaseDecisionInputDefinition(value);
    const reversed = Object.fromEntries(Object.entries(value.definition).reverse());
    expect(
      encodeReleaseDecisionInputDefinition({
        ...value,
        definition: ReleaseDecisionInputDefinitionSchema.parse(reversed),
      }),
    ).toEqual(original);
    original.fill(0);
    expect(encodeReleaseDecisionInputDefinition(value).some((byte) => byte !== 0)).toBe(true);
  });
});
