import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  encodeEvaluationCanonicalJson,
  type EvidenceScope,
  type ProtocolDefinition,
  type ProtocolDefinitionRecord,
  type ProtocolDefinitionSelector,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestProtocolDefinition,
  digestProtocolDefinitionRecord,
  InvalidProtocolDefinitionRecordError,
  MAX_STATIC_PROTOCOL_DEFINITIONS,
  StaticProtocolDefinitionCatalogue,
  validateProtocolDefinitionRecord,
} from "./protocol-definition.js";

const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/protocol-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    vectors: {
      name: string;
      input: { definition: ProtocolDefinition; scope: EvidenceScope };
      sha256: string;
    }[];
  }
).vectors;
function record(index = 0): ProtocolDefinitionRecord {
  const v = vectors[index];
  if (!v) throw new Error("Missing independently computed protocol vector");
  return structuredClone({
    ...v.input.definition,
    scope: v.input.scope,
    definitionSha256: v.sha256,
    schemaVersion: "0.1" as const,
    registeredAt: "2026-10-09T00:00:00.001Z",
    registeredByPrincipalId: "operator_protocol",
  });
}
function selector(r: ProtocolDefinitionRecord): ProtocolDefinitionSelector {
  return {
    family: r.family,
    descriptor: structuredClone(r.descriptor),
  } as ProtocolDefinitionSelector;
}
function rehash(r: ProtocolDefinitionRecord) {
  const {
    scope,
    schemaVersion: _version,
    definitionSha256: _sha,
    registeredAt: _at,
    registeredByPrincipalId: _by,
    ...definition
  } = r;
  r.definitionSha256 = digestProtocolDefinition(scope, definition);
  return r;
}

describe("copied independently retained protocol catalogue", () => {
  it("hashes every whole original record including receipts with an independent ordered-JSON oracle", () => {
    function canonical(value: unknown): string {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value !== null && typeof value === "object")
        return `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
          .join(",")}}`;
      return JSON.stringify(value);
    }
    for (let index = 0; index < vectors.length; index++) {
      const original = record(index);
      const expected = createHash("sha256").update(canonical(original)).digest("hex");
      expect(digestProtocolDefinitionRecord(original)).toBe(expected);
      expect(
        digestProtocolDefinitionRecord({ ...original, registeredByPrincipalId: "operator_other" }),
      ).not.toBe(expected);
      expect(
        digestProtocolDefinitionRecord({ ...original, registeredAt: "2099-01-01T00:00:00.000Z" }),
      ).not.toBe(expected);
      expect(() =>
        digestProtocolDefinitionRecord({ ...original, definitionSha256: "0".repeat(64) }),
      ).toThrow(InvalidProtocolDefinitionRecordError);
    }
    expect(() => digestProtocolDefinitionRecord(null)).toThrow(
      InvalidProtocolDefinitionRecordError,
    );
  });

  it.each(vectors.map((v, i) => ({ name: v.name, index: i })))(
    "retains complete independent $name bytes and original receipts",
    ({ index }) => {
      const r = record(index);
      const v = vectors[index];
      if (!v) throw new Error("Missing independent protocol vector");
      expect(digestProtocolDefinition(v.input.scope, v.input.definition)).toBe(v.sha256);
      expect(validateProtocolDefinitionRecord(r)).toEqual(r);
      const receipt = {
        ...r,
        registeredAt: "2026-10-09T00:00:00.002Z",
        registeredByPrincipalId: "operator_other",
      };
      expect(validateProtocolDefinitionRecord(receipt)).toEqual(receipt);
      expect(receipt.definitionSha256).toBe(r.definitionSha256);
      expect(
        createHash("sha256").update(encodeEvaluationCanonicalJson(receipt)).digest("hex"),
      ).not.toBe(createHash("sha256").update(encodeEvaluationCanonicalJson(r)).digest("hex"));
      expect(r).not.toHaveProperty("authority");
      expect(r).not.toHaveProperty("installed");
    },
  );

  it("uses every scope coordinate, exact storage identity, family and complete case-sensitive descriptor", async () => {
    const rows = vectors.map((_, i) => record(i));
    const original = record();
    for (const field of ["projectId", "environmentId"] as const)
      rows.push(rehash({ ...record(), scope: { ...original.scope, [field]: "scope_other" } }));
    const catalogue = new StaticProtocolDefinitionCatalogue(rows);
    for (const r of rows) {
      await expect(
        catalogue.findProtocolDefinition(r.scope, r.protocolDefinitionId),
      ).resolves.toEqual(r);
      await expect(catalogue.listProtocolDefinitions(r.scope, selector(r))).resolves.toEqual([r]);
    }
    await expect(
      catalogue.findProtocolDefinition(original.scope, "protocol_missing"),
    ).resolves.toBeNull();
    for (const field of ["tenantId", "projectId", "environmentId"] as const) {
      const scope = { ...original.scope, [field]: "scope_missing" };
      await expect(
        catalogue.findProtocolDefinition(scope, original.protocolDefinitionId),
      ).resolves.toBeNull();
      await expect(catalogue.listProtocolDefinitions(scope, selector(original))).resolves.toEqual(
        [],
      );
    }
    for (const field of ["name", "version"] as const) {
      const selected = selector(original);
      selected.descriptor[field] = selected.descriptor[field].toLowerCase();
      await expect(catalogue.listProtocolDefinitions(original.scope, selected)).resolves.toEqual(
        [],
      );
    }
    const released = record(4);
    const selected = selector(released);
    if (selected.family !== "released_target_adapter")
      throw new Error("Missing released descriptor");
    selected.descriptor.protocolVersion = "WIRE-OTHER";
    await expect(catalogue.listProtocolDefinitions(released.scope, selected)).resolves.toEqual([]);
    await expect(
      new StaticProtocolDefinitionCatalogue([original]).listProtocolDefinitions(original.scope, {
        family: "worker_protocol",
        descriptor: original.descriptor,
      }),
    ).resolves.toEqual([]);
    await expect(
      new StaticProtocolDefinitionCatalogue([]).findProtocolDefinition(
        original.scope,
        original.protocolDefinitionId,
      ),
    ).resolves.toBeNull();
  });

  it("preserves all ambiguous exact matches, original receipts and deterministic independent IDs without selecting a winner", async () => {
    const original = record();
    const alias = rehash({
      ...record(),
      protocolDefinitionId: "protocol_alias",
      registeredAt: "2026-10-10T00:00:00.001Z",
      registeredByPrincipalId: "operator_alias",
    });
    const catalogue = new StaticProtocolDefinitionCatalogue([alias, original]);
    const rows = await catalogue.listProtocolDefinitions(original.scope, selector(original));
    expect(rows).toEqual([alias, original]);
    expect(rows).toHaveLength(2);
    await expect(
      catalogue.findProtocolDefinition(original.scope, original.protocolDefinitionId),
    ).resolves.toEqual(original);
    await expect(
      catalogue.findProtocolDefinition(alias.scope, alias.protocolDefinitionId),
    ).resolves.toEqual(alias);
    expect(rows[0]?.registeredAt).toBe("2026-10-10T00:00:00.001Z");
  });

  it("rejects duplicate storage identity across family/body/receipt differences instead of merging records", () => {
    const r = record();
    for (const mutate of [
      (other: ProtocolDefinitionRecord) => other,
      (other: ProtocolDefinitionRecord) => {
        other.specification.sha256 = "d".repeat(64);
      },
      (other: ProtocolDefinitionRecord) => {
        other.registeredAt = "2026-10-09T00:00:00.002Z";
      },
      (other: ProtocolDefinitionRecord) => {
        Reflect.set(other, "family", "request_normalizer");
      },
    ]) {
      const other = record();
      mutate(other);
      rehash(other);
      expect(() => new StaticProtocolDefinitionCatalogue([r, other])).toThrow(
        "Duplicate protocol definition identity",
      );
    }
  });

  it("copies constructor data and every exact/multiple returned body, including selector and artifact fields", async () => {
    const original = record();
    const rows = [record()];
    const catalogue = new StaticProtocolDefinitionCatalogue(rows);
    const first = rows[0];
    if (!first) throw new Error("Missing copied fixture");
    first.protocolDefinitionId = "protocol_input_changed";
    first.descriptor.name = "input_changed";
    first.specification.sha256 = "0".repeat(64);
    rows.length = 0;
    const output = await catalogue.findProtocolDefinition(
      original.scope,
      original.protocolDefinitionId,
    );
    expect(output).toEqual(original);
    if (!output) throw new Error("Missing retained independent row");
    output.descriptor.version = "OUTPUT-CHANGED";
    output.specification.sizeBytes++;
    output.limitations.length = 0;
    const matches = await catalogue.listProtocolDefinitions(original.scope, selector(original));
    expect(matches).toEqual([original]);
    const returned = matches[0];
    if (!returned) throw new Error("Missing complete matches");
    returned.descriptor.name = "output_changed";
    returned.specification.sha256 = "0".repeat(64);
    matches.length = 0;
    await expect(
      catalogue.findProtocolDefinition(original.scope, original.protocolDefinitionId),
    ).resolves.toEqual(original);
    await expect(
      catalogue.listProtocolDefinitions(original.scope, selector(original)),
    ).resolves.toEqual([original]);
  });

  it("enforces exact/over catalogue size before reads and preserves all exact-limit ambiguous records", async () => {
    const rows = Array.from({ length: MAX_STATIC_PROTOCOL_DEFINITIONS }, (_, i) =>
      rehash({ ...record(), protocolDefinitionId: `protocol_${String(i).padStart(3, "0")}` }),
    );
    const catalogue = new StaticProtocolDefinitionCatalogue([...rows].reverse());
    await expect(
      catalogue.listProtocolDefinitions(record().scope, selector(record())),
    ).resolves.toEqual(rows);
    expect(
      () =>
        new StaticProtocolDefinitionCatalogue([
          ...rows,
          rehash({ ...record(), protocolDefinitionId: "protocol_over" }),
        ]),
    ).toThrow("entry limit");
    for (const invalid of [null, {}, { length: 0 }])
      expect(() => new StaticProtocolDefinitionCatalogue(invalid as readonly unknown[])).toThrow(
        "entry limit",
      );
    for (const count of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      const array = new Proxy([], {
        get: (target, name) => (name === "length" ? count : Reflect.get(target, name)),
      });
      expect(() => new StaticProtocolDefinitionCatalogue(array)).toThrow("entry limit");
    }
    expect(() => new StaticProtocolDefinitionCatalogue(Array(1))).toThrow(
      InvalidProtocolDefinitionRecordError,
    );
  });

  it("rejects malformed lookup coordinates/selectors before reporting missingness", async () => {
    const original = record();
    const catalogue = new StaticProtocolDefinitionCatalogue([original]);
    for (const scope of [
      null,
      { ...original.scope, tenantId: "Wrong" },
      { ...original.scope, projectId: 1 },
      { ...original.scope, extra: true },
    ]) {
      await expect(
        catalogue.findProtocolDefinition(scope as EvidenceScope, original.protocolDefinitionId),
      ).rejects.toThrow();
      await expect(
        catalogue.listProtocolDefinitions(scope as EvidenceScope, selector(original)),
      ).rejects.toThrow();
    }
    for (const id of ["id", "UPPER", "wrong:id", "p".repeat(65), null, 1])
      await expect(
        catalogue.findProtocolDefinition(original.scope, id as string),
      ).rejects.toThrow();
    for (const selected of [
      null,
      { family: "unknown", descriptor: original.descriptor },
      { ...selector(original), expectedSha256: original.definitionSha256 },
      { family: original.family, descriptor: { name: original.descriptor.name, version: 1 } },
    ])
      await expect(
        catalogue.listProtocolDefinitions(original.scope, selected as ProtocolDefinitionSelector),
      ).rejects.toThrow();
  });

  it("fails closed on corrupt strict bodies, semantic digests, scopes and original receipts", () => {
    const cases: unknown[] = [
      null,
      {},
      [],
      { ...record(), definitionSha256: "0".repeat(64) },
      { ...record(), registeredAt: "2026-10-09T00:00:00.001001Z" },
      { ...record(), registeredByPrincipalId: "Wrong" },
      { ...record(), authority: true },
    ];
    const semantic = record();
    semantic.descriptor.version = "OTHER";
    cases.push(semantic);
    const family = record();
    Reflect.set(family, "family", "source_format");
    cases.push(family);
    const scope = record();
    scope.scope.projectId = "project_other";
    cases.push(scope);
    for (const raw of cases) {
      expect(() => validateProtocolDefinitionRecord(raw)).toThrow(
        InvalidProtocolDefinitionRecordError,
      );
      expect(() => new StaticProtocolDefinitionCatalogue([raw])).toThrow(
        InvalidProtocolDefinitionRecordError,
      );
    }
    try {
      validateProtocolDefinitionRecord({});
      throw new Error("Invalid record accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProtocolDefinitionRecordError);
      expect(error).toMatchObject({
        name: "InvalidProtocolDefinitionRecordError",
        code: "protocol_definition_record_invalid",
      });
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });
});
