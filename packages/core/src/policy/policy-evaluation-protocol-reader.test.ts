import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  type ProtocolDefinition,
  type ProtocolDefinitionRecord,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestProtocolDefinition,
  InvalidProtocolDefinitionRecordError,
  StaticProtocolDefinitionCatalogue,
} from "../runtime/protocol-definition.js";
import { PolicyEvaluationDefinitionReadInputError } from "./policy-evaluation-definition-reader.js";
import {
  enumeratePolicyEvaluationProtocolReferences as enumerate,
  inspectPolicyEvaluationProtocolRecord as inspect,
  readPolicyEvaluationProtocolRecord as read,
} from "./policy-evaluation-protocol-reader.js";

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
function row(index = 0): ProtocolDefinitionRecord {
  const v = vectors[index];
  if (!v) throw new Error("Missing independent protocol vector");
  return {
    ...structuredClone(v.input.definition),
    scope: structuredClone(v.input.scope),
    definitionSha256: v.sha256,
    schemaVersion: "0.1",
    registeredAt: "2026-09-01T00:00:00.001Z",
    registeredByPrincipalId: "operator_protocol",
  };
}
function input(record = row()) {
  return {
    evaluationTime: "2026-10-01T00:00:00.000000Z",
    scope: structuredClone(record.scope),
    source: {
      kind: "protocol_definition" as const,
      reference: {
        protocolDefinitionId: record.protocolDefinitionId,
        definitionSha256: record.definitionSha256,
      },
    },
  };
}
function rehash(record: ProtocolDefinitionRecord) {
  const {
    scope,
    definitionSha256: _sha,
    registeredAt: _at,
    registeredByPrincipalId: _by,
    schemaVersion: _version,
    ...definition
  } = record;
  record.definitionSha256 = digestProtocolDefinition(scope, definition);
  return record;
}
function references(record: ProtocolDefinitionRecord) {
  return [
    { kind: "artifact", path: "/specification", reference: record.specification },
    ...("implementation" in record
      ? [
          { kind: "artifact", path: "/implementation", reference: record.implementation },
          { kind: "artifact", path: "/configuration", reference: record.configuration },
        ]
      : []),
  ];
}
const limits = { maxReferences: 10, maxReferenceBytes: 10_000 };

describe("exact retained protocol source acquisition", () => {
  it.each(vectors.map((v, index) => ({ name: v.name, index })))(
    "reads independent $name without a requested hash and retains every original dependency",
    async ({ index }) => {
      const record = row(index);
      const catalogue = new StaticProtocolDefinitionCatalogue([record]);
      const find = vi.fn(catalogue.findProtocolDefinition.bind(catalogue));
      const evidence = await read(input(record), { findProtocolDefinition: find });
      expect(find).toHaveBeenCalledExactlyOnceWith(record.scope, record.protocolDefinitionId);
      expect(evidence.record).toEqual(record);
      expect(evidence.observation.status).toBe("verified");
      expect(evidence).toEqual(inspect(input(record), record));
      const expanded = enumerate(input(record), evidence, limits);
      expect(expanded.references).toEqual(references(record));
      expect(expanded.referenceBytes).toBe(
        references(record).reduce((sum, r) => sum + encodeEvaluationCanonicalJson(r).byteLength, 0),
      );
      expect(expanded).not.toHaveProperty("sealed");
      expect(expanded).not.toHaveProperty("compatible");
    },
  );

  it("matches an independently computed complete original receipt hash and byte length", () => {
    // Python sorted UTF-8 JSON/hashlib oracle, separate from the production encoder.
    expect(inspect(input(), row()).observation).toEqual({
      status: "verified",
      recordSha256: "787e447789bca8973729acb5670631e2e9b474a3fd148a5a2f8458a941626f83",
    });
    expect(encodeEvaluationCanonicalJson(row()).byteLength).toBe(1285);
  });

  it("preserves missing and malformed observations instead of successful empty dependencies", async () => {
    const context = input();
    expect(await read(context, new StaticProtocolDefinitionCatalogue([]))).toEqual({
      source: context.source,
      record: null,
      observation: { status: "missing" },
    });
    for (const raw of [
      undefined,
      false,
      {},
      { ...row(), compatible: true },
      { ...row(), schemaVersion: "9.9" },
      { ...row(), definitionSha256: "0".repeat(64) },
      { ...row(), descriptor: { name: "reference/protocol", version: "v2" } },
    ]) {
      const result = inspect(context, raw);
      expect(result).toEqual({
        source: context.source,
        record: null,
        observation: { status: "unavailable", reason: "record_invalid" },
      });
      expect(() => enumerate(context, result, limits)).toThrow();
    }
    expect(() => enumerate(context, inspect(context, null), limits)).toThrow();
  });

  it("binds every original scope and reference field even when a substitute has a valid digest", () => {
    const original = row();
    const context = input(original);
    for (const field of ["tenantId", "projectId", "environmentId"] as const) {
      const changed = rehash({
        ...structuredClone(original),
        scope: {
          ...original.scope,
          [field]: "other_scope",
        },
      });
      expect(inspect(context, changed).observation).toEqual({
        status: "unavailable",
        reason: "reference_mismatch",
      });
    }
    const changedVersion = structuredClone(original);
    changedVersion.descriptor.version = original.descriptor.version.toLowerCase();
    const changes = [
      rehash({ ...structuredClone(original), protocolDefinitionId: "protocol_other" }),
      rehash(changedVersion),
      rehash({
        ...structuredClone(original),
        specification: {
          ...original.specification,
          classification: "restricted",
        },
      }),
    ];
    for (const changed of changes)
      expect(inspect(context, changed).observation).toEqual({
        status: "unavailable",
        reason: "reference_mismatch",
      });
    for (const field of ["protocolDefinitionId", "definitionSha256"] as const) {
      const changed = structuredClone(context);
      changed.source.reference[field] =
        field === "definitionSha256" ? "f".repeat(64) : "protocol_other";
      expect(inspect(changed, original).observation).toEqual({
        status: "unavailable",
        reason: "reference_mismatch",
      });
    }
  });

  it("preserves native cut precision and includes original receipts in the full observation", () => {
    const record = row();
    const context = input(record);
    expect(
      inspect(
        { ...context, evaluationTime: "2026-09-01T00:00:00.000999999999999999999999999999Z" },
        record,
      ).observation,
    ).toEqual({ status: "unavailable", reason: "not_yet_available" });
    for (const evaluationTime of [
      "2026-09-01T00:00:00.001Z",
      "2026-09-01T00:00:00.001000Z",
      "2026-09-01T00:00:00.001001Z",
    ])
      expect(inspect({ ...context, evaluationTime }, record).observation.status).toBe("verified");
    for (const patch of [
      { registeredAt: "2026-09-01T00:00:00.000Z" },
      { registeredByPrincipalId: "operator_other" },
    ]) {
      const changed = inspect(context, { ...record, ...patch });
      expect(changed.observation.status).toBe("verified");
      expect(changed.source).toEqual(context.source);
      expect(changed.observation).not.toEqual(inspect(context, record).observation);
    }
  });

  it("captures scope/source before I/O and validates malformed context before any lookup", async () => {
    const context = input();
    const original = structuredClone(context);
    const result = await read(context, {
      findProtocolDefinition: async (scope) => {
        scope.tenantId = "mutation_attempt";
        context.source.reference.definitionSha256 = "f".repeat(64);
        return row();
      },
    });
    expect(result).toEqual(inspect(original, row()));
    const find = vi.fn(async () => null);
    for (const bad of [
      null,
      { ...original, approved: true },
      { ...original, evaluationTime: "invalid" },
      { ...original, scope: { ...original.scope, projectId: "" } },
      { ...original, source: { kind: "endpoint_profile", reference: original.source.reference } },
      {
        ...original,
        source: {
          ...original.source,
          reference: { ...original.source.reference, name: "protocol" },
        },
      },
    ])
      await expect(
        read(bad as typeof original, { findProtocolDefinition: find }),
      ).rejects.toBeInstanceOf(PolicyEvaluationDefinitionReadInputError);
    expect(find).not.toHaveBeenCalled();
  });

  it("propagates storage failures rather than classifying a rejected lookup as invalid data", async () => {
    for (const cause of [new Error("storage offline"), new InvalidProtocolDefinitionRecordError()])
      await expect(
        read(input(), {
          findProtocolDefinition: async () => {
            throw cause;
          },
        }),
      ).rejects.toBe(cause);
  });

  it("retains repeated artifact occurrences at exact limits and rejects incompatible shared identities", () => {
    const record = row();
    if (!("implementation" in record)) throw new Error("Missing adapter definition");
    record.implementation = structuredClone(record.specification);
    record.configuration = structuredClone(record.specification);
    rehash(record);
    const context = input(record);
    const evidence = inspect(context, record);
    const result = enumerate(context, evidence, limits);
    expect(result.references).toHaveLength(3);
    expect(result.references.map(({ path }) => path)).toEqual([
      "/specification",
      "/implementation",
      "/configuration",
    ]);
    expect(
      enumerate(context, evidence, { maxReferences: 3, maxReferenceBytes: result.referenceBytes }),
    ).toEqual(result);
    expect(() =>
      enumerate(context, evidence, { maxReferences: 2, maxReferenceBytes: result.referenceBytes }),
    ).toThrow();
    expect(() =>
      enumerate(context, evidence, {
        maxReferences: 3,
        maxReferenceBytes: result.referenceBytes - 1,
      }),
    ).toThrow();
    record.configuration.sha256 = "f".repeat(64);
    rehash(record);
    expect(() => enumerate(input(record), inspect(input(record), record), limits)).toThrow(
      "reference_conflict",
    );
  });

  it("rejects forged source/body/receipt/full-observation material before enumeration", () => {
    const context = input();
    const original = inspect(context, row());
    if (!original.record || original.observation.status !== "verified")
      throw new Error("Missing captured record");
    for (const change of [
      (e: typeof original) => {
        e.record.registeredByPrincipalId = "operator_other";
      },
      (e: typeof original) => {
        e.record.registeredAt = "2026-09-01T00:00:00.000Z";
      },
      (e: typeof original) => {
        e.record.specification.sizeBytes++;
      },
      (e: typeof original) => {
        e.source.reference.protocolDefinitionId = "protocol_other";
      },
      (e: typeof original) => {
        Reflect.set(e.observation, "recordSha256", "0".repeat(64));
      },
      (e: typeof original) => {
        Reflect.set(e, "approved", true);
      },
    ]) {
      const forged = structuredClone(original);
      change(forged);
      expect(() => enumerate(context, forged, limits)).toThrow();
    }
  });
});
