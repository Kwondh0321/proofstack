import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QualificationCaseKindSchema, QualificationReportSchema } from "./evaluation-spec.js";
import type { EvidenceScope } from "./evidence.js";
import {
  QUALIFICATION_POLICY_CASE_KINDS,
  type QualificationPolicyDefinition,
  QualificationPolicyDefinitionSchema,
  QualificationPolicyRecordSchema,
  QualificationPolicyReferenceSchema,
} from "./qualification-policy.js";
import { encodeQualificationPolicy } from "./qualification-policy-encoding.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/qualification-policy-v1.json", import.meta.url), "utf8"),
) as {
  format: string;
  vectors: {
    input: { definition: QualificationPolicyDefinition; scope: EvidenceScope };
    encodedByteLength: number;
    sha256: string;
  }[];
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function first() {
  const vector = document.vectors[0];
  if (!vector) throw new Error("Missing independent qualification policy vector");
  return structuredClone(vector);
}

describe("retained fixed qualification policy data", () => {
  it("retains the existing exact report reference without adding authority fields", () => {
    const vector = first();
    const reference = {
      policyId: vector.input.definition.policyId,
      policyVersionId: vector.input.definition.policyVersionId,
      definitionSha256: vector.sha256,
    };
    expect(QualificationPolicyReferenceSchema).toBe(QualificationReportSchema.shape.policy);
    expect(QualificationPolicyReferenceSchema.parse(reference)).toEqual(reference);
    for (const field of ["approved", "qualified", "latest", "execute"])
      expect(
        QualificationPolicyReferenceSchema.safeParse({ ...reference, [field]: true }).success,
      ).toBe(false);
  });

  it("rejects relaxed or unsupported semantics and omitted/duplicated/reordered case kinds", () => {
    const definition = first().input.definition;
    expect(QUALIFICATION_POLICY_CASE_KINDS).toEqual(QualificationCaseKindSchema.options);
    expect(Object.isFrozen(QUALIFICATION_POLICY_CASE_KINDS)).toBe(true);
    const kinds = definition.requiredCaseKinds;
    for (const patch of [
      { algorithmVersion: "unsupported" },
      { caseMatching: "majority" },
      { recordKind: "release_policy" },
      { unexpectedErrorLimit: 1 },
      { unexpectedErrorLimit: -1 },
      { unexpectedErrorLimit: 0.1 },
      { unexpectedErrorLimit: null },
      { requiredCaseKinds: kinds.slice(1) },
      { requiredCaseKinds: [...kinds, "positive"] },
      { requiredCaseKinds: [...kinds].reverse() },
      { requiredCaseKinds: kinds.map((kind, index) => (index === 0 ? "positive" : kind)) },
      { requiredCaseKinds: kinds.map((kind, index) => (index === 0 ? "invented" : kind)) },
    ])
      expect(
        QualificationPolicyDefinitionSchema.safeParse({ ...definition, ...patch }).success,
      ).toBe(false);
  });
  it("binds every scope coordinate and both policy identities in canonical definitions", () => {
    const vector = first();
    const original = hash(encodeQualificationPolicy(vector.input));
    for (const coordinate of ["tenantId", "projectId", "environmentId"] as const) {
      const input = structuredClone(vector.input);
      input.scope[coordinate] = "other_scope";
      expect(hash(encodeQualificationPolicy(input))).not.toBe(original);
    }
    for (const coordinate of ["policyId", "policyVersionId"] as const) {
      const input = structuredClone(vector.input);
      input.definition[coordinate] = "other_policy_coordinate";
      expect(hash(encodeQualificationPolicy(input))).not.toBe(original);
    }
  });

  it("retains original millisecond receipts separately and rejects invented authority", () => {
    const vector = first();
    const record = {
      ...vector.input.definition,
      scope: vector.input.scope,
      definitionSha256: vector.sha256,
      publishedAt: "2026-10-08T00:00:00.000Z",
      publishedByPrincipalId: "operator_policy",
      schemaVersion: "0.1",
    };
    expect(QualificationPolicyRecordSchema.parse(record)).toEqual(record);
    expect(QualificationPolicyDefinitionSchema.safeParse(record).success).toBe(false);
    for (const field of ["approved", "qualified", "credentials", "execute", "latest"])
      for (const value of [true, undefined])
        for (const schema of [
          QualificationPolicyDefinitionSchema,
          QualificationPolicyRecordSchema,
        ]) {
          const source =
            schema === QualificationPolicyRecordSchema ? record : vector.input.definition;
          expect(schema.safeParse({ ...source, [field]: value }).success).toBe(false);
        }
    for (const patch of [
      { publishedAt: "2026-10-08T00:00:00.000001Z" },
      { publishedAt: "invalid" },
      { publishedByPrincipalId: "" },
      { definitionSha256: "unverified" },
      { schemaVersion: "9" },
      { scope: { ...record.scope, approved: true } },
    ])
      expect(QualificationPolicyRecordSchema.safeParse({ ...record, ...patch }).success).toBe(
        false,
      );
    expect(() =>
      encodeQualificationPolicy({
        ...vector.input,
        publishedAt: record.publishedAt,
      } as typeof vector.input),
    ).toThrow();
  });

  it("pins independent scope collisions and a distinct exact version", () => {
    expect(document.format).toBe("proofstack.qualification-policy.v1");
    expect(document.vectors).toHaveLength(3);
    expect(document.vectors[0]?.input.definition).toEqual(document.vectors[1]?.input.definition);
    expect(document.vectors[0]?.sha256).not.toBe(document.vectors[1]?.sha256);
    expect(document.vectors[0]?.input.scope).toEqual(document.vectors[2]?.input.scope);
    expect(document.vectors[0]?.input.definition.policyVersionId).not.toBe(
      document.vectors[2]?.input.definition.policyVersionId,
    );
  });

  for (const [index, vector] of document.vectors.entries())
    it(`vector ${index}: matches independent complete canonical bytes and SHA-256`, () => {
      const bytes = encodeQualificationPolicy(vector.input);
      expect(bytes.byteLength).toBe(vector.encodedByteLength);
      expect(hash(bytes)).toBe(vector.sha256);
      expect(Buffer.from(bytes).toString("utf8")).toBe(
        canonical({
          ...vector.input,
          definitionDomain: "proofstack.qualification-policy.v1",
          encodingVersion: "proofstack.qualification-policy-jcs.v1",
          schemaVersion: "0.1",
        }),
      );
      expect(
        encodeQualificationPolicy({
          ...vector.input,
          definition: Object.fromEntries(
            Object.entries(vector.input.definition).reverse(),
          ) as QualificationPolicyDefinition,
        }),
      ).toEqual(bytes);
    });
});
