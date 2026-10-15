import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceScopeSchema } from "./evidence.js";
import { encodeReleaseDecisionDefinition } from "./release-decision-encoding.js";
import { ReleaseDecisionDefinitionSchema } from "./release-decision.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/release-decision-definition-v1.json", import.meta.url), "utf8"),
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
  if (!vector) throw new Error("Missing decision vector");
  return {
    definition: ReleaseDecisionDefinitionSchema.parse(structuredClone(vector.input.definition)),
    scope: EvidenceScopeSchema.parse(vector.input.scope),
  };
}
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("accountable decision canonical bytes", () => {
  it.each(document.vectors.map((vector, index) => ({ ...vector, index })))(
    "matches independent Python $name",
    (vector) => {
      const bytes = encodeReleaseDecisionDefinition(input(vector.index));
      expect(bytes.byteLength).toBe(vector.encodedByteLength);
      expect(sha(bytes)).toBe(vector.sha256);
    },
  );
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects mismatched %s digest scope",
    (field) => {
      const value = input();
      expect(() =>
        encodeReleaseDecisionDefinition({
          ...value,
          scope: { ...value.scope, [field]: "scope_another" },
        }),
      ).toThrow(/canonical digest scope/);
    },
  );
  it("binds original accountability, closed authority reference, native time, rationale and subject", () => {
    const value = input();
    const original = sha(encodeReleaseDecisionDefinition(value));
    for (const change of [
      { decisionId: "decision_changed" },
      { rationale: "A different accountable rationale." },
      { expiresAt: "2026-10-15T12:08:00.000002Z" },
      { decidedAt: "2026-10-15T12:02:00.000002Z" },
      { publisher: { ...value.definition.publisher, requestId: "new-login" } },
      {
        authoritySnapshot: {
          ...value.definition.authoritySnapshot,
          definitionSha256: "0".repeat(64),
        },
      },
      { candidate: { ...value.definition.candidate, definitionSha256: "0".repeat(64) } },
      { input: { ...value.definition.input, definitionSha256: "0".repeat(64) } },
    ])
      expect(
        sha(
          encodeReleaseDecisionDefinition({
            ...value,
            definition: { ...value.definition, ...change },
          }),
        ),
      ).not.toBe(original);
  });
  it("ignores object key insertion order and absent optional JS fields", () => {
    const value = input(1);
    const bytes = encodeReleaseDecisionDefinition(value);
    const policy = value.definition.policies[1];
    if (!policy) throw new Error("Missing advisory fixture");
    const reversed = Object.fromEntries(Object.entries(value.definition).reverse());
    expect(
      encodeReleaseDecisionDefinition({
        ...value,
        definition: ReleaseDecisionDefinitionSchema.parse(reversed),
      }),
    ).toEqual(bytes);
    const changed = input(1);
    const first = changed.definition.policies[0];
    if (first?.state !== "unavailable") throw new Error("Missing unavailable fixture");
    first.snapshot = undefined;
    const without = structuredClone(changed);
    const other = without.definition.policies[0];
    if (other?.state === "unavailable") delete other.snapshot;
    expect(encodeReleaseDecisionDefinition(changed)).toEqual(
      encodeReleaseDecisionDefinition(without),
    );
    bytes.fill(0);
    expect(encodeReleaseDecisionDefinition(value).some((byte) => byte !== 0)).toBe(true);
  });
});
