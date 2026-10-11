import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type EvidenceScope, PolicyEvaluationSourceReferenceSchema } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { StaticEvaluationImplementationRegistrationCatalogue } from "../evaluation/evaluation-implementation-registration.js";
import { StaticQualificationPolicyCatalogue } from "../evaluation/qualification-policy.js";
import { StaticEndpointProfileCatalogue } from "../runtime/endpoint-profile.js";
import { StaticProtocolDefinitionCatalogue } from "../runtime/protocol-definition.js";
import { StaticRuntimeDefinitionCatalogue } from "../runtime/runtime-definition-catalogue.js";
import * as endpoint from "./policy-evaluation-endpoint-profile-reader.js";
import * as implementation from "./policy-evaluation-implementation-reader.js";
import * as protocol from "./policy-evaluation-protocol-reader.js";
import * as qualification from "./policy-evaluation-qualification-policy-reader.js";
import * as runtime from "./policy-evaluation-runtime-reader.js";

type Fields = Record<string, unknown>;
const adapters = {
  runtime: {
    inspect: runtime.inspectPolicyEvaluationRuntimeCapture,
    read: runtime.readPolicyEvaluationRuntimeCapture,
    enumerate: runtime.enumeratePolicyEvaluationStoredRuntimeReferences,
    semantic: runtime.enumeratePolicyEvaluationRuntimeReferences,
    catalogue: StaticRuntimeDefinitionCatalogue,
  },
  protocol: {
    inspect: protocol.inspectPolicyEvaluationProtocolCapture,
    read: protocol.readPolicyEvaluationProtocolCapture,
    enumerate: protocol.enumeratePolicyEvaluationStoredProtocolReferences,
    semantic: protocol.enumeratePolicyEvaluationProtocolReferences,
    catalogue: StaticProtocolDefinitionCatalogue,
  },
  endpoint: {
    inspect: endpoint.inspectPolicyEvaluationEndpointProfileCapture,
    read: endpoint.readPolicyEvaluationEndpointProfileCapture,
    enumerate: endpoint.enumeratePolicyEvaluationStoredEndpointProfileReferences,
    semantic: endpoint.enumeratePolicyEvaluationEndpointProfileReferences,
    catalogue: StaticEndpointProfileCatalogue,
  },
  qualification: {
    inspect: qualification.inspectPolicyEvaluationQualificationPolicyCapture,
    read: qualification.readPolicyEvaluationQualificationPolicyCapture,
    enumerate: qualification.enumeratePolicyEvaluationStoredQualificationPolicyReferences,
    semantic: qualification.enumeratePolicyEvaluationQualificationPolicyReferences,
    catalogue: StaticQualificationPolicyCatalogue,
  },
  implementation: {
    inspect: implementation.inspectPolicyEvaluationImplementationCapture,
    read: implementation.readPolicyEvaluationImplementationCapture,
    enumerate: implementation.enumeratePolicyEvaluationStoredImplementationReferences,
    semantic: implementation.enumeratePolicyEvaluationImplementationReferences,
    catalogue: StaticEvaluationImplementationRegistrationCatalogue,
  },
};
const documents = {
  runtime: "runtime-definition-v1.json",
  protocol: "protocol-definition-v1.json",
  endpoint: "endpoint-profile-v1.json",
  qualification: "qualification-policy-v1.json",
  implementation: "evaluation-implementation-registration-v1.json",
} as const;
type Family = keyof typeof adapters;
const receipt = "2026-09-01T00:00:00.001Z";
const before = "2026-09-01T00:00:00.000999999999999999999999999999Z";
const limits = { maxReferences: 100, maxReferenceBytes: 100000 };
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sorted(child)]),
    );
  return value;
}
const json = (value: unknown) => JSON.stringify(sorted(value));
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");

function fixture(
  family: Family,
  vector: { input: { scope: EvidenceScope; definition: Fields }; sha256: string },
) {
  const record: Fields = {
    ...structuredClone(vector.input.definition),
    scope: structuredClone(vector.input.scope),
    definitionSha256: vector.sha256,
    schemaVersion: "0.1",
    [family === "qualification" ? "publishedAt" : "registeredAt"]: receipt,
    [family === "qualification" ? "publishedByPrincipalId" : "registeredByPrincipalId"]:
      "operator_original",
  };
  const kind = record["recordKind"];
  const coordinates = family === "implementation" ? (record["implementation"] as Fields) : record;
  const keys =
    family === "protocol"
      ? ["protocolDefinitionId"]
      : family === "endpoint"
        ? ["endpointProfileId", "endpointProfileVersion"]
        : family === "qualification"
          ? ["policyId", "policyVersionId"]
          : family === "implementation"
            ? ["implementationId", "implementationVersionId"]
            : kind === "runtime_adapter"
              ? ["adapterId", "adapterVersionId"]
              : kind === "replay_runtime_profile"
                ? ["id", "version", "family"]
                : ["id", "version", "kind"];
  const source = PolicyEvaluationSourceReferenceSchema.parse({
    kind,
    reference: {
      ...Object.fromEntries(keys.map((key) => [key, coordinates[key]])),
      definitionSha256: vector.sha256,
    },
  });
  return {
    record,
    input: { source, scope: structuredClone(vector.input.scope), evaluationTime: receipt },
  };
}

// Independent owning-field inventory; neither production enumerator nor canonical encoder is used.
function references(family: Family, record: Fields) {
  const artifacts =
    family === "runtime"
      ? [
          "configuration",
          "implementation",
          ...(record["recordKind"] === "runtime_adapter" ? ["interfaceContract"] : []),
        ]
      : family === "protocol"
        ? [
            "specification",
            ...(record["implementation"] === undefined ? [] : ["implementation", "configuration"]),
          ]
        : family === "endpoint"
          ? ["configuration"]
          : [];
  return [
    ...artifacts.map((key) => ({ kind: "artifact", path: `/${key}`, reference: record[key] })),
    ...(record["recordKind"] === "runtime_adapter"
      ? [{ kind: "protocol_declaration", path: "/protocol", reference: record["protocol"] }]
      : []),
  ];
}

const cases = (Object.keys(documents) as Family[]).flatMap((family) => {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../contracts/vectors/${documents[family]}`, import.meta.url),
      "utf8",
    ),
  ) as { vectors: { input: { scope: EvidenceScope; definition: Fields }; sha256: string }[] };
  return document.vectors.map((vector, index) => ({ family, vector, label: `${family}:${index}` }));
});

describe("original stored definition capture", () => {
  it.each(["read", "storage"] as const)(
    "preserves canonical negative-zero equivalence in the separate %s body",
    (side) => {
      const selected = cases.find(({ family }) => family === "qualification");
      if (!selected) throw new Error("Expected qualification policy vector");
      const s = fixture(selected.family, selected.vector);
      const capture = qualification.inspectPolicyEvaluationQualificationPolicyCapture(
        s.input as never,
        s.record,
      );
      const record = side === "read" ? capture.read.record : capture.storage?.record;
      if (!record) throw new Error("Expected retained policy body");
      expect(Reflect.get(record, "unexpectedErrorLimit")).toBe(0);
      Reflect.set(record, "unexpectedErrorLimit", -0);
      expect(Object.is(Reflect.get(record, "unexpectedErrorLimit"), -0)).toBe(true);
      const frontier = qualification.enumeratePolicyEvaluationStoredQualificationPolicyReferences(
        s.input as never,
        capture,
        limits,
      );
      expect(frontier.storage.recordSha256).toBe(hash(s.record));
      expect(frontier.references).toEqual(references("qualification", s.record));
      expect(capture.storage?.recordSha256).toBe(hash(s.record));
    },
  );
  it.each(cases)(
    "$label rejects absent/invalid storage, all scope substitutions and forged future witnesses",
    ({ family, vector }) => {
      const adapter = adapters[family];
      const s = fixture(family, vector);
      const context = { ...s.input, evaluationTime: before };
      const capture = adapter.inspect(context as never, s.record);
      if (!capture.storage) throw new Error("Expected original storage");
      for (const change of [
        (value: typeof capture) =>
          Reflect.set(value.storage as object, "recordSha256", "f".repeat(64)),
        (value: typeof capture) =>
          Reflect.set(value.storage as object, "receiptTime", "2026-09-01T00:00:00.002Z"),
        (value: typeof capture) =>
          Reflect.set(
            value.storage?.record as object,
            family === "qualification" ? "publishedByPrincipalId" : "registeredByPrincipalId",
            "operator_substituted",
          ),
        (value: typeof capture) =>
          Reflect.set(value.read, "observation", {
            status: "verified",
            recordSha256: hash(s.record),
          }),
        (value: typeof capture) => Reflect.set(value.read, "record", s.record),
        (value: typeof capture) =>
          Reflect.set(value.read.source.reference, "definitionSha256", "f".repeat(64)),
      ]) {
        const altered = structuredClone(capture);
        change(altered);
        expect(() => adapter.enumerate(context as never, altered as never, limits)).toThrow(
          expect.objectContaining({ reason: "observation_mismatch" }),
        );
      }
      for (const raw of [
        null,
        undefined,
        { ...s.record, definitionSha256: "0".repeat(64) },
        { ...s.record, approved: true },
      ]) {
        const bad = adapter.inspect(context as never, raw);
        expect(bad.storage).toBeNull();
        expect(bad.read.observation).toEqual(
          raw === null
            ? { status: "missing" }
            : { status: "unavailable", reason: "record_invalid" },
        );
        expect(() => adapter.enumerate(context as never, bad as never, limits)).toThrow(
          expect.objectContaining({ reason: "evidence_unverified" }),
        );
      }
      for (const key of ["tenantId", "projectId", "environmentId"] as const) {
        const altered = structuredClone(context);
        altered.scope[key] = "other_scope";
        expect(adapter.inspect(altered as never, s.record)).toMatchObject({
          storage: null,
          read: {
            record: null,
            observation: { status: "unavailable", reason: "reference_mismatch" },
          },
        });
        expect(() => adapter.enumerate(altered as never, capture as never, limits)).toThrow();
      }
      expect(() =>
        adapter.enumerate(context as never, { ...capture, approved: true } as never, limits),
      ).toThrow(expect.objectContaining({ reason: "input_invalid" }));
    },
  );
  it.each(cases)(
    "$label owns exact scope/identity across real catalogue I/O",
    async ({ family, vector }) => {
      const adapter = adapters[family];
      const s = fixture(family, vector);
      s.input.evaluationTime = before;
      const original = structuredClone(s.input);
      const catalogue = new adapter.catalogue([s.record]);
      const calls: { name: string; args: unknown[] }[] = [];
      const reader = new Proxy(catalogue, {
        get(target, key) {
          const method: unknown = Reflect.get(target, key);
          if (typeof method !== "function") return method;
          return async (...args: unknown[]) => {
            calls.push({ name: String(key), args: structuredClone(args) });
            const value: unknown = await Reflect.apply(method, target, args);
            s.input.scope.tenantId = "tenant_mutated_during_read";
            Reflect.set(s.input.source.reference, "definitionSha256", "0".repeat(64));
            return value;
          };
        },
      });
      const capture = await adapter.read(s.input as never, reader as never);
      const refs = s.input.source.reference as unknown as Fields;
      const kind = s.input.source.kind;
      const expected =
        family === "protocol"
          ? { name: "findProtocolDefinition", ids: [refs["protocolDefinitionId"]] }
          : family === "endpoint"
            ? {
                name: "findEndpointProfile",
                ids: [refs["endpointProfileId"], refs["endpointProfileVersion"]],
              }
            : family === "qualification"
              ? {
                  name: "findQualificationPolicy",
                  ids: [refs["policyId"], refs["policyVersionId"]],
                }
              : family === "implementation"
                ? {
                    name: "findEvaluationImplementationRegistration",
                    ids: [refs["implementationId"], refs["implementationVersionId"]],
                  }
                : kind === "runtime_adapter"
                  ? { name: "findRuntimeAdapter", ids: [refs["adapterVersionId"]] }
                  : {
                      name:
                        kind === "replay_runtime_profile"
                          ? "findRuntimeProfile"
                          : "findIsolationProfile",
                      ids: [refs["id"], refs["version"]],
                    };
      expect(calls).toEqual([{ name: expected.name, args: [original.scope, ...expected.ids] }]);
      expect(capture).toEqual(adapter.inspect(original as never, s.record));
      expect(capture.read.record).toBeNull();
      expect(capture.storage?.recordSha256).toBe(hash(s.record));
    },
  );
  it.each(cases)(
    "$label retains independent hashes and declarations without promoting future availability",
    ({ family, vector }) => {
      const adapter = adapters[family];
      const s = fixture(family, vector);
      const expected = references(family, s.record);
      const bytes = expected.reduce(
        (sum, value) => sum + Buffer.byteLength(json(value), "utf8"),
        0,
      );
      for (const cut of [receipt, before]) {
        const context = { ...s.input, evaluationTime: cut };
        const capture = adapter.inspect(context as never, s.record);
        expect(capture.storage).toEqual({
          record: s.record,
          recordSha256: hash(s.record),
          receiptTime: receipt,
        });
        expect(capture.read.observation).toEqual(
          cut === receipt
            ? { status: "verified", recordSha256: hash(s.record) }
            : { status: "unavailable", reason: "not_yet_available" },
        );
        expect(capture.read.record).toEqual(cut === receipt ? s.record : null);
        const result = adapter.enumerate(context as never, capture as never, {
          maxReferences: expected.length,
          maxReferenceBytes: bytes,
        });
        expect(result).toEqual({
          references: expected,
          referenceBytes: bytes,
          semanticObservation: capture.read.observation,
          storage: { source: s.input.source, recordSha256: hash(s.record), receiptTime: receipt },
        });
        expect(result).not.toHaveProperty("source");
        if (cut === before)
          expect(() => adapter.semantic(context as never, capture.read as never, limits)).toThrow(
            expect.objectContaining({ reason: "evidence_unverified" }),
          );
        if (expected.length > 0) {
          expect(() =>
            adapter.enumerate(context as never, capture as never, {
              maxReferences: expected.length - 1,
              maxReferenceBytes: bytes,
            }),
          ).toThrow(expect.objectContaining({ reason: "reference_limit_exceeded" }));
          expect(() =>
            adapter.enumerate(context as never, capture as never, {
              maxReferences: expected.length,
              maxReferenceBytes: bytes - 1,
            }),
          ).toThrow(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
        }
        const original = structuredClone(capture);
        if (!capture.storage) throw new Error("Missing storage");
        Reflect.set(capture.storage.record, "definitionSha256", "0".repeat(64));
        if (result.references[0]) Reflect.set(result.references[0], "path", "/mutated_output");
        expect(s.record).toEqual(original.storage?.record);
        expect(adapter.inspect(context as never, s.record)).toEqual(original);
      }
    },
  );
});
