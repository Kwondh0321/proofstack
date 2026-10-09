import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvidenceScope } from "./evidence.js";
import { encodeProtocolDefinition } from "./protocol-definition-encoding.js";
import {
  type ProtocolDefinition,
  MAX_PROTOCOL_DEFINITION_LIMITATIONS,
  ProtocolDefinitionRecordSchema,
  ProtocolDefinitionSchema,
  ProtocolDefinitionSelectorSchema,
} from "./protocol-definition.js";

const vectors = (
  JSON.parse(
    readFileSync(new URL("../vectors/protocol-definition-v1.json", import.meta.url), "utf8"),
  ) as {
    vectors: {
      name: string;
      input: { definition: ProtocolDefinition; scope: EvidenceScope };
      canonicalUtf8: string;
      utf8Bytes: number;
      sha256: string;
    }[];
  }
).vectors;
const families = vectors.slice(0, 7);
function vector(index = 0) {
  const item = vectors[index];
  if (!item) throw new Error("Missing independently computed protocol vector");
  return structuredClone(item);
}
const digest = (input: Parameters<typeof encodeProtocolDefinition>[0]) =>
  createHash("sha256").update(encodeProtocolDefinition(input)).digest("hex");

describe("separate retained protocol families and canonical bytes", () => {
  it.each(vectors)("matches independent canonical vector $name", (v) => {
    const bytes = encodeProtocolDefinition(v.input);
    expect(Buffer.from(bytes).toString("utf8")).toBe(v.canonicalUtf8);
    expect(bytes.byteLength).toBe(v.utf8Bytes);
    expect(digest(v.input)).toBe(v.sha256);
    expect(ProtocolDefinitionSchema.parse(v.input.definition)).toEqual(v.input.definition);
    expect(
      ProtocolDefinitionSelectorSchema.parse({
        family: v.input.definition.family,
        descriptor: v.input.definition.descriptor,
      }),
    ).toEqual({ family: v.input.definition.family, descriptor: v.input.definition.descriptor });
  });

  it.each(families)(
    "keeps original maximum name/version and storage identity distinct for $name",
    (v) => {
      const input = structuredClone(v.input);
      input.definition.descriptor.name = `N${"x".repeat(248)}:+/@-._`;
      expect(input.definition.descriptor.name.length).toBe(256);
      input.definition.descriptor.version = `V${"x".repeat(59)}+RC1`;
      expect(input.definition.descriptor.version.length).toBe(64);
      input.definition.protocolDefinitionId = `p${"x".repeat(63)}`;
      if (input.definition.family === "released_target_adapter")
        input.definition.descriptor.protocolVersion = input.definition.descriptor.version;
      expect(ProtocolDefinitionSchema.parse(input.definition)).toEqual(input.definition);
      expect(digest(input)).not.toBe(v.sha256);
      for (const field of ["name", "version"] as const) {
        const over = structuredClone(input.definition);
        over.descriptor[field] += "x";
        expect(ProtocolDefinitionSchema.safeParse(over).success).toBe(false);
      }
      const overId = structuredClone(input.definition);
      overId.protocolDefinitionId += "x";
      expect(ProtocolDefinitionSchema.safeParse(overId).success).toBe(false);
    },
  );

  it.each(families)("rejects malformed and coercible descriptors for $name", (v) => {
    for (const field of ["name", "version"] as const)
      for (const bad of ["", " x", "x ", "x\ny", "x?y", "이름", null, 1]) {
        const definition = structuredClone(v.input.definition);
        Reflect.set(definition.descriptor, field, bad);
        expect(ProtocolDefinitionSchema.safeParse(definition).success, `${field}:${bad}`).toBe(
          false,
        );
      }
    for (const bad of ["id", "UPPER_CASE", "contains:colon", "lower/case", "three+plus", null, 1]) {
      const definition = structuredClone(v.input.definition);
      Reflect.set(definition, "protocolDefinitionId", bad);
      expect(ProtocolDefinitionSchema.safeParse(definition).success).toBe(false);
    }
  });

  it.each(families)("strictly binds all semantic fields and scopes for $name", (v) => {
    const patches: ((d: ProtocolDefinition) => void)[] = [
      (d) => {
        d.protocolDefinitionId = "protocol_other";
      },
      (d) => {
        d.descriptor.name = "different/name:@wire";
      },
      (d) => {
        d.descriptor.version = d.descriptor.version.toLowerCase();
      },
      (d) => {
        d.limitations = ["Another explicit limitation"];
      },
      (d) => {
        d.specification.sha256 = "d".repeat(64);
      },
      (d) => {
        d.specification.artifactId = "artifact_other";
      },
      (d) => {
        d.specification.mediaType = "text/plain";
      },
      (d) => {
        d.specification.classification = "restricted";
      },
      (d) => {
        d.specification.sizeBytes++;
      },
      (d) => {
        d.specification.redactedAt = "ingest";
      },
    ];
    if ("configuration" in v.input.definition) {
      patches.push((d) => {
        if ("configuration" in d) d.configuration.sizeBytes++;
      });
      patches.push((d) => {
        if ("implementation" in d) d.implementation.sha256 = "e".repeat(64);
      });
    }
    if (v.input.definition.family === "released_target_adapter")
      patches.push((d) => {
        if (d.family === "released_target_adapter") d.descriptor.protocolVersion = "WIRE-3.0";
      });
    for (const patch of patches) {
      const input = structuredClone(v.input);
      patch(input.definition);
      expect(digest(input)).not.toBe(v.sha256);
    }
    for (const key of ["tenantId", "projectId", "environmentId"] as const) {
      const input = structuredClone(v.input);
      input.scope[key] = "scope_other";
      expect(digest(input)).not.toBe(v.sha256);
    }
  });

  it.each(families)(
    "requires exact dependencies and rejects unknown body/descriptor/artifact fields for $name",
    (v) => {
      for (const add of [
        (d: ProtocolDefinition) => Reflect.set(d, "credentials", {}),
        (d: ProtocolDefinition) => Reflect.set(d.descriptor, "expectedSha256", "a".repeat(64)),
        (d: ProtocolDefinition) => Reflect.set(d.specification, "url", "https://example.test"),
      ]) {
        const definition = structuredClone(v.input.definition);
        add(definition);
        expect(ProtocolDefinitionSchema.safeParse(definition).success).toBe(false);
      }
      for (const field of [
        "specification",
        ...("implementation" in v.input.definition ? ["implementation", "configuration"] : []),
      ]) {
        const definition = structuredClone(v.input.definition);
        Reflect.deleteProperty(definition, field);
        expect(ProtocolDefinitionSchema.safeParse(definition).success).toBe(false);
      }
      if (!("implementation" in v.input.definition)) {
        const definition = structuredClone(v.input.definition);
        Reflect.set(definition, "implementation", definition.specification);
        expect(ProtocolDefinitionSchema.safeParse(definition).success).toBe(false);
      }
    },
  );

  it("distinguishes families and the released protocolVersion without shape equivalence", () => {
    const v = vector();
    for (const family of ["request_normalizer", "recorded_target_adapter"] as const) {
      const input = structuredClone(v.input);
      Reflect.set(input.definition, "family", family);
      expect(ProtocolDefinitionSchema.safeParse(input.definition).success).toBe(true);
      expect(digest(input)).not.toBe(v.sha256);
    }
    const released = vector(4).input.definition;
    Reflect.deleteProperty(released.descriptor, "protocolVersion");
    expect(ProtocolDefinitionSchema.safeParse(released).success).toBe(false);
    Reflect.set(released, "family", "recorded_target_adapter");
    expect(ProtocolDefinitionSchema.safeParse(released).success).toBe(true);
    Reflect.set(released.descriptor, "protocolVersion", "WIRE-2.0");
    expect(ProtocolDefinitionSchema.safeParse(released).success).toBe(false);
    Reflect.set(released, "family", "unknown_protocol");
    expect(ProtocolDefinitionSchema.safeParse(released).success).toBe(false);
  });

  it("admits exact ordered limitation limits and rejects duplicate, unordered or extra limits", () => {
    const definition = vector().input.definition;
    definition.limitations = Array.from(
      { length: MAX_PROTOCOL_DEFINITION_LIMITATIONS },
      (_, i) => `limitation_${String(i).padStart(2, "0")}`,
    );
    expect(ProtocolDefinitionSchema.safeParse(definition).success).toBe(true);
    for (const limitations of [
      [...definition.limitations, "limitation_extra"],
      [...definition.limitations].reverse(),
      ["duplicate", "duplicate"],
    ])
      expect(ProtocolDefinitionSchema.safeParse({ ...definition, limitations }).success).toBe(
        false,
      );
    expect(ProtocolDefinitionSchema.safeParse({ ...definition, limitations: [] }).success).toBe(
      true,
    );
  });

  it("separates exact original receipts from definition bytes and rejects injected encoding fields", () => {
    const v = vector();
    const record = {
      ...v.input.definition,
      scope: v.input.scope,
      schemaVersion: "0.1",
      definitionSha256: v.sha256,
      registeredAt: "2026-10-09T00:00:00.001Z",
      registeredByPrincipalId: "operator_protocol",
    };
    expect(ProtocolDefinitionRecordSchema.parse(record)).toEqual(record);
    for (const patch of [
      { registeredAt: "2026-10-09T00:00:00.001001Z" },
      { registeredByPrincipalId: "Wrong" },
      { schemaVersion: "0.2" },
      { authority: true },
    ])
      expect(ProtocolDefinitionRecordSchema.safeParse({ ...record, ...patch }).success).toBe(false);
    expect(() => encodeProtocolDefinition({ ...v.input, definition: record })).toThrow();
    expect(() =>
      encodeProtocolDefinition({ ...v.input, domain: "other" } as unknown as Parameters<
        typeof encodeProtocolDefinition
      >[0]),
    ).toThrow();
    expect(() =>
      encodeProtocolDefinition({ ...v.input, scope: { ...v.input.scope, tenantId: "bad/id" } }),
    ).toThrow();
  });
});
