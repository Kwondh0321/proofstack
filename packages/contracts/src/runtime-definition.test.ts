import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvidenceScope } from "./evidence.js";
import type { RuntimeDefinition } from "./runtime-definition.js";
import { RuntimeDefinitionRecordSchema, RuntimeDefinitionSchema } from "./runtime-definition.js";
import { encodeRuntimeDefinition } from "./runtime-definition-encoding.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/runtime-definition-v1.json", import.meta.url), "utf8"),
) as {
  format: string;
  vectors: {
    input: { definition: RuntimeDefinition; scope: EvidenceScope };
    encodedByteLength: number;
    sha256: string;
  }[];
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function sorted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sorted).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${sorted(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

describe("retained runtime definition contracts", () => {
  it("retains one fixed public vector per definition kind", () => {
    expect(document.format).toBe("proofstack.runtime-definition.v1");
    expect(document.vectors.map((v) => v.input.definition.recordKind)).toEqual([
      "replay_runtime_profile",
      "replay_isolation_profile",
      "runtime_adapter",
    ]);
  });
  for (const vector of document.vectors) {
    const { input } = vector;
    it(`${input.definition.recordKind}: matches fixed bytes and an independent canonical oracle`, () => {
      const bytes = encodeRuntimeDefinition(input);
      expect(bytes.byteLength).toBe(vector.encodedByteLength);
      expect(hash(bytes)).toBe(vector.sha256);
      expect(Buffer.from(bytes).toString()).toBe(
        sorted({
          ...input,
          definitionDomain: "proofstack.runtime-definition.v1",
          encodingVersion: "proofstack.runtime-definition-jcs.v1",
          schemaVersion: "0.1",
        }),
      );
      expect(
        encodeRuntimeDefinition({
          scope: input.scope,
          definition: Object.fromEntries(
            Object.entries(input.definition).reverse(),
          ) as RuntimeDefinition,
        }),
      ).toEqual(bytes);
    });
    it(`${input.definition.recordKind}: binds scope and every semantic leaf`, () => {
      const original = hash(encodeRuntimeDefinition(input));
      const visit = (value: unknown, path: (string | number)[]) => {
        if (value !== null && typeof value === "object") {
          for (const [key, child] of Object.entries(value))
            visit(child, [...path, Array.isArray(value) ? Number(key) : key]);
          return;
        }
        const next = structuredClone(input);
        let parent: unknown = next;
        for (const key of path.slice(0, -1))
          parent = (parent as Record<string | number, unknown>)[key];
        (parent as Record<string | number, unknown>)[path.at(-1) as string | number] =
          typeof value === "number" ? value + 1 : `${value}x`;
        try {
          expect(hash(encodeRuntimeDefinition(next))).not.toBe(original);
        } catch (error) {
          // A semantic change is either bound or invalid under the owning contract, never ignored.
          if (!(error instanceof Error) || error.name !== "ZodError") throw error;
        }
      };
      visit(input, []);
    });
    it(`${input.definition.recordKind}: rejects authority, receipt and secret fields in definitions`, () => {
      for (const key of [
        "approved",
        "installed",
        "credentials",
        "registeredAt",
        "definitionSha256",
        "scope",
      ]) {
        expect(
          RuntimeDefinitionSchema.safeParse({ ...input.definition, [key]: undefined }).success,
        ).toBe(false);
      }
      expect(() => encodeRuntimeDefinition({ ...input, approved: true } as typeof input)).toThrow();
      const record = {
        ...input.definition,
        scope: input.scope,
        schemaVersion: "0.1",
        registeredAt: "2026-09-26T00:00:00.000Z",
        registeredByPrincipalId: "operator_test",
        definitionSha256: vector.sha256,
      };
      expect(RuntimeDefinitionRecordSchema.safeParse(record).success).toBe(true);
      for (const bad of [
        { ...record, schemaVersion: "9" },
        { ...record, registeredAt: "yesterday" },
        { ...record, registeredByPrincipalId: "" },
        { ...record, scope: { ...input.scope, tenantId: "" } },
        { ...record, approved: undefined },
      ])
        expect(RuntimeDefinitionRecordSchema.safeParse(bad).success).toBe(false);
    });
    it(`${input.definition.recordKind}: bounds and orders limitations and validates artifact descriptors`, () => {
      for (const limitations of [
        ["b", "a"],
        ["a", "a"],
        Array.from({ length: 33 }, (_, i) => `item_${String(i).padStart(2, "0")}`),
        ["x".repeat(513)],
      ])
        expect(
          RuntimeDefinitionSchema.safeParse({ ...input.definition, limitations }).success,
        ).toBe(false);
      expect(
        RuntimeDefinitionSchema.safeParse({ ...input.definition, limitations: [] }).success,
      ).toBe(true);
      expect(
        RuntimeDefinitionSchema.safeParse({ ...input.definition, limitations: ["한계 😀"] })
          .success,
      ).toBe(true);
      expect(
        RuntimeDefinitionSchema.safeParse({
          ...input.definition,
          configuration: { ...input.definition.configuration, sizeBytes: 0 },
        }).success,
      ).toBe(false);
      expect(
        RuntimeDefinitionSchema.safeParse({
          ...input.definition,
          implementation: { ...input.definition.implementation, executablePath: "/bin/sh" },
        }).success,
      ).toBe(false);
    });
  }
  it("keeps platform, isolation and adapter protocol declarations strict without implying execution", () => {
    const [runtime, isolation, adapter] = document.vectors.map((v) => v.input.definition);
    expect(
      RuntimeDefinitionSchema.safeParse({
        ...runtime,
        runtime: { architecture: "x64", platform: "linux", version: "24.0.0" },
      }).success,
    ).toBe(true);
    expect(
      RuntimeDefinitionSchema.safeParse({
        ...runtime,
        runtime: {
          architecture: "arm64",
          platform: "darwin",
          version: "24.0.0",
          entryPoint: "main.js",
        },
      }).success,
    ).toBe(false);
    expect(RuntimeDefinitionSchema.safeParse({ ...isolation, kind: "container" }).success).toBe(
      true,
    );
    expect(RuntimeDefinitionSchema.safeParse({ ...isolation, kind: "none" }).success).toBe(false);
    for (const boundaryKinds of [[], ["tool", "model"], ["model", "model"], ["unknown"]])
      expect(RuntimeDefinitionSchema.safeParse({ ...adapter, boundaryKinds }).success).toBe(false);
    expect(
      RuntimeDefinitionSchema.safeParse({
        ...adapter,
        boundaryKinds: ["data", "model", "retrieval", "tool"],
      }).success,
    ).toBe(true);
    expect(
      RuntimeDefinitionSchema.safeParse({
        ...adapter,
        protocol: { name: "provider", version: "1", credentials: "forbidden" },
      }).success,
    ).toBe(false);
  });
});
