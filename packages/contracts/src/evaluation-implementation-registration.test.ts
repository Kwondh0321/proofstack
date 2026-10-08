import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type EvaluationImplementationRegistrationDefinition,
  EvaluationImplementationRegistrationDefinitionSchema,
  EvaluationImplementationRegistrationRecordSchema,
} from "./evaluation-implementation-registration.js";
import { encodeEvaluationImplementationRegistration } from "./evaluation-implementation-registration-encoding.js";
import type { EvidenceScope } from "./evidence.js";

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-implementation-registration-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  format: string;
  vectors: {
    input: { definition: EvaluationImplementationRegistrationDefinition; scope: EvidenceScope };
    encodedByteLength: number;
    sha256: string;
  }[];
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

describe("retained evaluation implementation registration", () => {
  it("binds every descriptor leaf and scope coordinate", () => {
    const input = document.vectors[0]?.input;
    if (!input) throw new Error("Missing fixed registration vector");
    const original = hash(encodeEvaluationImplementationRegistration(input));
    const visit = (value: unknown, path: string[]) => {
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
        return;
      }
      if (path.at(-1) === "recordKind") return; // The fixed kind is independently rejected below.
      const next = structuredClone(input);
      let parent: unknown = next;
      for (const key of path.slice(0, -1)) parent = (parent as Record<string, unknown>)[key];
      const key = path.at(-1) as string;
      (parent as Record<string, unknown>)[key] =
        key.endsWith("Sha256") || key === "sourceRevision"
          ? "d".repeat((value as string).length)
          : key === "architecture"
            ? "arm64"
            : key === "family"
              ? "python"
              : key === "platform"
                ? "portable"
                : `${value}x`;
      expect(hash(encodeEvaluationImplementationRegistration(next))).not.toBe(original);
    };
    visit(input, []);
  });

  it("separates original receipts from semantic definitions and rejects authority fields", () => {
    const vector = document.vectors[0];
    if (!vector) throw new Error("Missing fixed registration vector");
    const record = {
      ...vector.input.definition,
      scope: vector.input.scope,
      schemaVersion: "0.1",
      registeredAt: "2026-10-08T00:00:00.000Z",
      registeredByPrincipalId: "operator_registration",
      definitionSha256: vector.sha256,
    };
    expect(EvaluationImplementationRegistrationRecordSchema.parse(record)).toEqual(record);
    for (const name of ["approved", "qualified", "installed", "credentials", "execute"])
      for (const value of [true, undefined]) {
        expect(
          EvaluationImplementationRegistrationRecordSchema.safeParse({ ...record, [name]: value })
            .success,
        ).toBe(false);
        expect(
          EvaluationImplementationRegistrationDefinitionSchema.safeParse({
            ...vector.input.definition,
            [name]: value,
          }).success,
        ).toBe(false);
      }
    for (const bad of [
      { ...record, schemaVersion: "9" },
      { ...record, registeredAt: "2026-10-08T00:00:00.000001Z" },
      { ...record, registeredByPrincipalId: "" },
      { ...record, recordKind: "oracle_spec" },
      {
        ...record,
        implementation: { ...record.implementation, sourceRevision: "unverified_label" },
      },
      {
        ...record,
        implementation: { ...record.implementation, entryPointPath: "/tmp/arbitrary.js" },
      },
    ])
      expect(EvaluationImplementationRegistrationRecordSchema.safeParse(bad).success).toBe(false);
    expect(() =>
      encodeEvaluationImplementationRegistration({
        ...vector.input,
        registeredAt: record.registeredAt,
      } as typeof vector.input),
    ).toThrow();
    expect(EvaluationImplementationRegistrationDefinitionSchema.safeParse(record).success).toBe(
      false,
    );
  });

  it("pins two colliding scope identities and one portable implementation", () => {
    expect(document.format).toBe("proofstack.evaluation-implementation-registration.v1");
    expect(document.vectors).toHaveLength(3);
    expect(document.vectors[0]?.input.definition).toEqual(document.vectors[1]?.input.definition);
    expect(document.vectors[0]?.sha256).not.toBe(document.vectors[1]?.sha256);
    expect(document.vectors[2]?.input.definition.implementation.runtime.family).toBe("wasm");
  });

  for (const [index, vector] of document.vectors.entries())
    it(`vector ${index}: matches fixed independently computed canonical bytes and hash`, () => {
      const bytes = encodeEvaluationImplementationRegistration(vector.input);
      expect(bytes.byteLength).toBe(vector.encodedByteLength);
      expect(hash(bytes)).toBe(vector.sha256);
      expect(Buffer.from(bytes).toString("utf8")).toBe(
        canonical({
          ...vector.input,
          definitionDomain: "proofstack.evaluation-implementation-registration.v1",
          encodingVersion: "proofstack.evaluation-implementation-registration-jcs.v1",
          schemaVersion: "0.1",
        }),
      );
      expect(
        encodeEvaluationImplementationRegistration({
          scope: vector.input.scope,
          definition: Object.fromEntries(
            Object.entries(vector.input.definition).reverse(),
          ) as EvaluationImplementationRegistrationDefinition,
        }),
      ).toEqual(bytes);
    });
});
