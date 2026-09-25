import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  EvidenceScope,
  RuntimeDefinition,
  RuntimeDefinitionRecord,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  enumeratePolicyEvaluationRuntimeReferences,
  inspectPolicyEvaluationRuntimeRecord,
  type PolicyEvaluationRuntimeRead,
  type PolicyEvaluationRuntimeSource,
  readPolicyEvaluationRuntimeRecord,
} from "../policy/policy-evaluation-runtime-reader.js";
import {
  MAX_STATIC_RUNTIME_DEFINITIONS,
  type RuntimeDefinitionReader,
  StaticRuntimeDefinitionCatalogue,
} from "./runtime-definition-catalogue.js";
import {
  digestRuntimeDefinition,
  InvalidRuntimeDefinitionRecordError,
  validateRuntimeDefinitionRecord,
} from "./runtime-definition-record.js";

const document = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/runtime-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: { input: { definition: RuntimeDefinition; scope: EvidenceScope }; sha256: string }[];
};
const scope = document.vectors[0]?.input.scope;
if (!scope) throw new Error("Missing vector scope");
const records = document.vectors.map(({ input, sha256 }) =>
  validateRuntimeDefinitionRecord({
    ...input.definition,
    scope: input.scope,
    definitionSha256: sha256,
    schemaVersion: "0.1",
    registeredAt: "2026-09-26T00:00:00.000Z",
    registeredByPrincipalId: "operator_runtime",
  }),
);
const limits = { maxReferences: 10, maxReferenceBytes: 10_000 };
const evaluationTime = "2026-10-01T00:00:00.000Z";

function source(record: RuntimeDefinitionRecord): PolicyEvaluationRuntimeSource {
  if (record.recordKind === "runtime_adapter")
    return {
      kind: "runtime_adapter",
      reference: {
        adapterId: record.adapterId,
        adapterVersionId: record.adapterVersionId,
        definitionSha256: record.definitionSha256,
      },
    };
  const reference = {
    id: record.id,
    version: record.version,
    definitionSha256: record.definitionSha256,
  };
  return record.recordKind === "replay_runtime_profile"
    ? { kind: "replay_runtime_profile", reference: { ...reference, family: record.family } }
    : { kind: "replay_isolation_profile", reference: { ...reference, kind: record.kind } };
}
function input(record: RuntimeDefinitionRecord) {
  return { scope: structuredClone(record.scope), evaluationTime, source: source(record) };
}
function rehash(record: RuntimeDefinitionRecord): RuntimeDefinitionRecord {
  const {
    scope,
    definitionSha256: _hash,
    schemaVersion: _version,
    registeredAt: _at,
    registeredByPrincipalId: _by,
    ...definition
  } = record;
  return { ...record, definitionSha256: digestRuntimeDefinition(scope, definition) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function fixture() {
  const catalogue = new StaticRuntimeDefinitionCatalogue(records);
  return {
    catalogue,
    reader: {
      findRuntimeProfile: vi.fn(catalogue.findRuntimeProfile.bind(catalogue)),
      findIsolationProfile: vi.fn(catalogue.findIsolationProfile.bind(catalogue)),
      findRuntimeAdapter: vi.fn(catalogue.findRuntimeAdapter.bind(catalogue)),
    },
  };
}
function port(kind: RuntimeDefinitionRecord["recordKind"]): keyof RuntimeDefinitionReader {
  return kind === "runtime_adapter"
    ? "findRuntimeAdapter"
    : kind === "replay_runtime_profile"
      ? "findRuntimeProfile"
      : "findIsolationProfile";
}

describe("exact runtime definition acquisition and dependency expansion", () => {
  for (const record of records) {
    const kind = record.recordKind;
    it(`${kind}: acquires a real catalogue record through only the owning read port`, async () => {
      const { reader } = fixture();
      const result = await readPolicyEvaluationRuntimeRecord(input(record), reader);
      expect(result).toEqual(inspectPolicyEvaluationRuntimeRecord(input(record), record));
      expect(result).toEqual({
        source: source(record),
        record,
        observation: {
          status: "verified",
          recordSha256: createHash("sha256").update(canonical(record)).digest("hex"),
        },
      });
      for (const name of Object.keys(reader) as (keyof typeof reader)[])
        expect(reader[name]).toHaveBeenCalledTimes(name === port(kind) ? 1 : 0);
      expect(reader[port(kind)]).toHaveBeenCalledWith(
        record.scope,
        ...(kind === "runtime_adapter" ? [record.adapterVersionId] : [record.id, record.version]),
      );
    });
    it(`${kind}: preserves absence, invalid content, reference mismatch and receipt-cut distinctions`, async () => {
      const original = input(record);
      expect(inspectPolicyEvaluationRuntimeRecord(original, null).observation).toEqual({
        status: "missing",
      });
      for (const raw of [
        undefined,
        true,
        original.source.reference,
        { ...record, approved: undefined },
        { ...record, definitionSha256: "f".repeat(64) },
        { ...record, registeredAt: "bad" },
      ])
        expect(inspectPolicyEvaluationRuntimeRecord(original, raw).observation).toEqual({
          status: "unavailable",
          reason: "record_invalid",
        });
      for (const key of Object.keys(original.source.reference)) {
        const query = structuredClone(original);
        const value = (query.source.reference as unknown as Record<string, unknown>)[key];
        (query.source.reference as unknown as Record<string, unknown>)[key] =
          key === "definitionSha256" ? "f".repeat(64) : key === "kind" ? "container" : `${value}x`;
        expect(inspectPolicyEvaluationRuntimeRecord(query, record).observation).toEqual({
          status: "unavailable",
          reason: "reference_mismatch",
        });
      }
      for (const key of ["tenantId", "projectId", "environmentId"] as const) {
        const other = input(record);
        other.scope[key] = "foreign";
        expect(inspectPolicyEvaluationRuntimeRecord(other, record).observation).toEqual({
          status: "unavailable",
          reason: "reference_mismatch",
        });
        expect(
          (await readPolicyEvaluationRuntimeRecord(other, fixture().catalogue)).observation,
        ).toEqual({ status: "missing" });
      }
      expect(
        inspectPolicyEvaluationRuntimeRecord(
          { ...original, evaluationTime: "2026-09-25T23:59:59.999999999Z" },
          record,
        ).observation,
      ).toEqual({ status: "unavailable", reason: "not_yet_available" });
      expect(
        inspectPolicyEvaluationRuntimeRecord(
          { ...original, evaluationTime: record.registeredAt },
          record,
        ).observation.status,
      ).toBe("verified");
    });
    it(`${kind}: never converts repository exceptions or unsupported inputs into successful records`, async () => {
      const { reader } = fixture();
      const failure = new Error("registry read failed");
      reader[port(kind)].mockRejectedValueOnce(failure);
      await expect(readPolicyEvaluationRuntimeRecord(input(record), reader)).rejects.toBe(failure);
      for (const query of [
        { ...input(record), approved: true },
        { ...input(record), evaluationTime: "bad" },
        { ...input(record), source: { kind: "unknown", reference: source(record).reference } },
      ])
        await expect(
          readPolicyEvaluationRuntimeRecord(query as ReturnType<typeof input>, reader),
        ).rejects.toMatchObject({ code: "policy_evaluation_definition_read_input_invalid" });
      expect(reader[port(kind)]).toHaveBeenCalledTimes(1);
      const wrongKind = records.find((other) => other.recordKind !== kind);
      expect(inspectPolicyEvaluationRuntimeRecord(input(record), wrongKind).observation).toEqual({
        status: "unavailable",
        reason: "record_invalid",
      });
    });
    it(`${kind}: isolates caller and repository mutation while retaining receipt metadata`, async () => {
      const query = input(record);
      const { reader } = fixture();
      reader[port(kind)].mockImplementationOnce(async (...args: unknown[]) => {
        (args[0] as EvidenceScope).tenantId = "changed_port_input";
        query.scope.tenantId = "changed_caller_input";
        return structuredClone(record);
      });
      const result = await readPolicyEvaluationRuntimeRecord(query, reader);
      expect(result.record).toEqual(record);
      if (!result.record) throw new Error("Expected record");
      result.record.implementation.artifactId = "changed_output";
      expect((await readPolicyEvaluationRuntimeRecord(input(record), reader)).record).toEqual(
        record,
      );
      const changedReceipt = { ...record, registeredByPrincipalId: "another_operator" };
      expect(validateRuntimeDefinitionRecord(changedReceipt)).toEqual(changedReceipt);
      expect(
        inspectPolicyEvaluationRuntimeRecord(input(record), changedReceipt).observation,
      ).not.toEqual(inspectPolicyEvaluationRuntimeRecord(input(record), record).observation);
    });
    it(`${kind}: expands all exact artifact occurrences with independent byte and full-record hashes`, async () => {
      const query = input(record);
      const evidence = await readPolicyEvaluationRuntimeRecord(query, fixture().catalogue);
      const actual = enumeratePolicyEvaluationRuntimeReferences(query, evidence, limits);
      const paths =
        kind === "runtime_adapter"
          ? ["configuration", "implementation", "interfaceContract"]
          : ["configuration", "implementation"];
      const expected = paths.map((key) => ({
        path: `/${key}`,
        kind: "artifact",
        reference: (record as unknown as Record<string, unknown>)[key],
      }));
      expect(actual.references).toEqual(expected);
      expect(actual.referenceBytes).toBe(
        expected.reduce((sum, entry) => sum + Buffer.byteLength(canonical(entry)), 0),
      );
      expect(actual.recordSha256).toBe(
        createHash("sha256").update(canonical(record)).digest("hex"),
      );
      const exact = { maxReferences: paths.length, maxReferenceBytes: actual.referenceBytes };
      expect(enumeratePolicyEvaluationRuntimeReferences(query, evidence, exact)).toEqual(actual);
      for (const [key, reason] of [
        ["maxReferences", "reference_limit_exceeded"],
        ["maxReferenceBytes", "reference_bytes_exceeded"],
      ] as const)
        expect(() =>
          enumeratePolicyEvaluationRuntimeReferences(query, evidence, {
            ...exact,
            [key]: exact[key] - 1,
          }),
        ).toThrow(expect.objectContaining({ reason }));
      const repeated = rehash({ ...record, implementation: structuredClone(record.configuration) });
      expect(
        enumeratePolicyEvaluationRuntimeReferences(
          input(repeated),
          inspectPolicyEvaluationRuntimeRecord(input(repeated), repeated),
          limits,
        ).references,
      ).toHaveLength(paths.length);
      const conflict = rehash({
        ...repeated,
        implementation: { ...repeated.configuration, sha256: "f".repeat(64) },
      });
      expect(() =>
        enumeratePolicyEvaluationRuntimeReferences(
          input(conflict),
          inspectPolicyEvaluationRuntimeRecord(input(conflict), conflict),
          limits,
        ),
      ).toThrow(expect.objectContaining({ reason: "reference_conflict" }));
    });
    it(`${kind}: reinspects before expansion, rejects body substitutions and reads accessor-backed bodies once`, () => {
      const query = input(record);
      const evidence = inspectPolicyEvaluationRuntimeRecord(query, record);
      for (const altered of [
        { ...evidence, record: null },
        { ...evidence, observation: { status: "missing" } },
        { ...evidence, observation: { status: "verified", recordSha256: "f".repeat(64) } },
        { ...evidence, record: { ...record, registeredAt: "2026-09-27T00:00:00.000Z" } },
      ])
        expect(() =>
          enumeratePolicyEvaluationRuntimeReferences(
            query,
            altered as PolicyEvaluationRuntimeRead,
            limits,
          ),
        ).toThrow();
      let reads = 0;
      const wrapped = {
        ...evidence,
        get record() {
          reads++;
          query.scope.tenantId = "changed";
          return record;
        },
      } as PolicyEvaluationRuntimeRead;
      const result = enumeratePolicyEvaluationRuntimeReferences(query, wrapped, limits);
      expect(reads).toBe(1);
      expect(result.references[0]).toMatchObject({
        path: "/configuration",
        reference: record.configuration,
      });
    });
  }
});

describe("immutable installation runtime catalogue", () => {
  it("strictly validates registration bodies and rejects every duplicate storage identity", () => {
    expect(() => new StaticRuntimeDefinitionCatalogue(null as never)).toThrow();
    expect(() => new StaticRuntimeDefinitionCatalogue([{}])).toThrow(
      InvalidRuntimeDefinitionRecordError,
    );
    expect(() => new StaticRuntimeDefinitionCatalogue(new Array(1))).toThrow(
      InvalidRuntimeDefinitionRecordError,
    );
    for (const record of records) {
      expect(() => new StaticRuntimeDefinitionCatalogue([record, structuredClone(record)])).toThrow(
        "Duplicate runtime definition identity",
      );
      expect(
        () =>
          new StaticRuntimeDefinitionCatalogue([
            record,
            rehash({ ...record, limitations: ["Changed"] }),
          ]),
      ).toThrow("Duplicate runtime definition identity");
    }
  });
  it("bounds the entry snapshot without following a growing input iterator", () => {
    const original = records[0];
    if (!original) throw new Error("Missing fixture");
    const bounded = Array.from({ length: MAX_STATIC_RUNTIME_DEFINITIONS }, (_, index) =>
      rehash({ ...original, scope: { ...original.scope, projectId: `project_${index}` } }),
    );
    expect(() => new StaticRuntimeDefinitionCatalogue(bounded)).not.toThrow();
    expect(() => new StaticRuntimeDefinitionCatalogue([...bounded, original])).toThrow(
      "entry limit",
    );
    const input = [original];
    Object.defineProperty(input, 0, {
      get() {
        input.push(original);
        return original;
      },
    });
    expect(() => new StaticRuntimeDefinitionCatalogue(input)).not.toThrow();
    expect(input.length).toBe(2);
    for (const count of [NaN, -1, 0.5, Infinity]) {
      const malformed = new Proxy([], {
        get(target, property) {
          return property === "length" ? count : Reflect.get(target, property);
        },
      });
      expect(() => new StaticRuntimeDefinitionCatalogue(malformed)).toThrow("entry limit");
    }
  });
  it("keeps equal profile IDs and versions in different kind namespaces separate", async () => {
    const runtime = records.find((record) => record.recordKind === "replay_runtime_profile");
    const isolation = records.find((record) => record.recordKind === "replay_isolation_profile");
    if (!runtime || !isolation) throw new Error("Expected both profile kinds");
    const sameIdentity = rehash({ ...isolation, id: runtime.id, version: runtime.version });
    const catalogue = new StaticRuntimeDefinitionCatalogue([runtime, sameIdentity]);
    expect(await catalogue.findRuntimeProfile(runtime.scope, runtime.id, runtime.version)).toEqual(
      runtime,
    );
    expect(
      await catalogue.findIsolationProfile(runtime.scope, runtime.id, runtime.version),
    ).toEqual(sameIdentity);
  });
  it("direct catalogue reads return copies without relying on the policy reader's defensive parse", async () => {
    const catalogue = fixture().catalogue;
    for (const original of records) {
      const read = () =>
        original.recordKind === "runtime_adapter"
          ? catalogue.findRuntimeAdapter(original.scope, original.adapterVersionId)
          : original.recordKind === "replay_runtime_profile"
            ? catalogue.findRuntimeProfile(original.scope, original.id, original.version)
            : catalogue.findIsolationProfile(original.scope, original.id, original.version);
      const first = await read();
      expect(first).toEqual(original);
      if (!first) throw new Error("Expected catalogue record");
      first.scope.tenantId = "changed_scope";
      first.configuration.artifactId = "changed_artifact";
      first.limitations.push("Changed limitation");
      expect(await read()).toEqual(original);
    }
  });
  it("does not share input or returned records, invent receipts, or use another version as fallback", async () => {
    const supplied = structuredClone(records);
    const catalogue = new StaticRuntimeDefinitionCatalogue(supplied);
    supplied.forEach((record) => {
      record.registeredByPrincipalId = "changed";
      record.configuration.sha256 = "e".repeat(64);
    });
    for (const record of records) {
      expect((await readPolicyEvaluationRuntimeRecord(input(record), catalogue)).record).toEqual(
        record,
      );
      const missing = input(record);
      if (missing.source.kind === "runtime_adapter")
        missing.source.reference.adapterVersionId += "_missing";
      else missing.source.reference.version += "_missing";
      expect((await readPolicyEvaluationRuntimeRecord(missing, catalogue)).observation).toEqual({
        status: "missing",
      });
    }
    await expect(catalogue.findRuntimeProfile(scope, "invalid/id", "1")).rejects.toThrow();
    await expect(catalogue.findIsolationProfile(scope, "id", "bad version")).rejects.toThrow();
    await expect(catalogue.findRuntimeAdapter({ ...scope, tenantId: "" }, "id")).rejects.toThrow();
  });
});
