import { readFileSync } from "node:fs";
import {
  encodeEvaluationCanonicalJson,
  type EndpointProfileDefinition,
  type EndpointProfileRecord,
  type EvidenceScope,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestEndpointProfile,
  InvalidEndpointProfileRecordError,
  StaticEndpointProfileCatalogue,
} from "../runtime/endpoint-profile.js";
import { PolicyEvaluationDefinitionReadInputError } from "./policy-evaluation-definition-reader.js";
import {
  enumeratePolicyEvaluationEndpointProfileReferences as enumerate,
  inspectPolicyEvaluationEndpointProfileRecord as inspect,
  type PolicyEvaluationEndpointProfileSource,
  readPolicyEvaluationEndpointProfileRecord as read,
} from "./policy-evaluation-endpoint-profile-reader.js";

const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/endpoint-profile-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    vectors: {
      input: { definition: EndpointProfileDefinition; scope: EvidenceScope };
      sha256: string;
    }[];
  }
).vectors;
function record(index = 0): EndpointProfileRecord {
  const v = vectors[index];
  if (!v) throw new Error("Missing independent endpoint vector");
  return structuredClone({
    ...v.input.definition,
    scope: v.input.scope,
    definitionSha256: v.sha256,
    schemaVersion: "0.1" as const,
    registeredAt: "2026-09-01T00:00:00.001Z",
    registeredByPrincipalId: "operator_endpoint",
  });
}
function rehash(row: EndpointProfileRecord) {
  const {
    definitionSha256: _sha,
    registeredAt: _at,
    registeredByPrincipalId: _by,
    schemaVersion: _version,
    scope,
    ...definition
  } = row;
  row.definitionSha256 = digestEndpointProfile(scope, definition);
  return row;
}
function input(row = record()) {
  const source: PolicyEvaluationEndpointProfileSource = {
    kind: "endpoint_profile",
    reference: {
      endpointProfileId: row.endpointProfileId,
      endpointProfileVersion: row.endpointProfileVersion,
      definitionSha256: row.definitionSha256,
    },
  };
  return {
    scope: structuredClone(row.scope),
    source,
    evaluationTime: "2026-10-01T00:00:00.000000Z",
  };
}
const limits = { maxReferences: 10, maxReferenceBytes: 10_000 };

describe("exact independent endpoint source acquisition", () => {
  it("looks up exact coordinates without a requested hash and pins the original full-record observation", async () => {
    const row = record();
    const catalogue = new StaticEndpointProfileCatalogue([row]);
    const reader = { findEndpointProfile: vi.fn(catalogue.findEndpointProfile.bind(catalogue)) };
    const result = await read(input(row), reader);
    expect(reader.findEndpointProfile).toHaveBeenCalledExactlyOnceWith(
      row.scope,
      row.endpointProfileId,
      row.endpointProfileVersion,
    );
    expect(result).toEqual({
      source: input(row).source,
      record: row,
      observation: {
        status: "verified",
        recordSha256: "b315ca3805b33348f7f2a0b3fda08a552186ebc8846befa00df1545bdc4b475d",
      },
    });
    expect(encodeEvaluationCanonicalJson(row).byteLength).toBe(857);
  });

  it("retains all independent tenant/version vectors through exact owning validation", async () => {
    const rows = vectors.map((_, i) => record(i));
    const catalogue = new StaticEndpointProfileCatalogue(rows);
    for (const row of rows) {
      const result = await read(input(row), catalogue);
      expect(result.observation.status).toBe("verified");
      expect(result).toEqual(inspect(input(row), row));
      expect(result.record).toEqual(row);
    }
  });

  it("keeps null missing and malformed data unavailable without a successful empty frontier", async () => {
    const context = input();
    expect(inspect(context, null)).toEqual({
      source: context.source,
      observation: { status: "missing" },
      record: null,
    });
    await expect(read(context, new StaticEndpointProfileCatalogue([]))).resolves.toEqual(
      inspect(context, null),
    );
    for (const raw of [
      undefined,
      true,
      {},
      { ...record(), approved: true },
      { ...record(), operations: [] },
      { ...record(), configuration: { ...record().configuration, sha256: "b".repeat(64) } },
    ])
      expect(inspect(context, raw)).toEqual({
        source: context.source,
        observation: { status: "unavailable", reason: "record_invalid" },
        record: null,
      });
    expect(() => enumerate(context, inspect(context, null), limits)).toThrow();
  });

  it("checks every scope coordinate, exact identity/version and expected semantic digest", () => {
    const original = record();
    const context = input(original);
    const rows = [
      ...(["tenantId", "projectId", "environmentId"] as const).map((field) =>
        rehash({
          ...structuredClone(original),
          scope: { ...original.scope, [field]: "scope_other" },
        }),
      ),
      rehash({ ...structuredClone(original), endpointProfileId: "endpoint_other" }),
      rehash({
        ...structuredClone(original),
        endpointProfileVersion: original.endpointProfileVersion.toLowerCase(),
      }),
      rehash({ ...structuredClone(original), provider: "other/provider" }),
    ];
    for (const row of rows)
      expect(inspect(context, row)).toEqual({
        source: context.source,
        observation: { status: "unavailable", reason: "reference_mismatch" },
        record: null,
      });
  });

  it("uses the original millisecond receipt at exact full-precision cuts", () => {
    const row = record();
    const context = input(row);
    expect(
      inspect({ ...context, evaluationTime: "2026-09-01T00:00:00.000999Z" }, row).observation,
    ).toEqual({ status: "unavailable", reason: "not_yet_available" });
    for (const time of [
      "2026-09-01T00:00:00.001Z",
      "2026-09-01T00:00:00.001000Z",
      "2026-09-01T00:00:00.001001Z",
    ])
      expect(inspect({ ...context, evaluationTime: time }, row).observation.status).toBe(
        "verified",
      );
    const changed = inspect(context, { ...row, registeredByPrincipalId: "operator_other" });
    expect(changed.observation.status).toBe("verified");
    expect(changed.observation).not.toEqual(inspect(context, row).observation);
  });

  it("propagates storage errors even when shaped like owning validation failures", async () => {
    for (const cause of [new Error("storage unavailable"), new InvalidEndpointProfileRecordError()])
      await expect(
        read(input(), {
          findEndpointProfile: async () => {
            throw cause;
          },
        }),
      ).rejects.toBe(cause);
  });

  it("captures source/scope before I/O and rejects malformed inputs before accessing a port", async () => {
    const context = input();
    const original = structuredClone(context);
    const result = await read(context, {
      findEndpointProfile: async (scope) => {
        scope.tenantId = "mutation_attempt";
        return record();
      },
    });
    expect(context).toEqual(original);
    expect(result).toEqual(inspect(original, record()));
    const reader = { findEndpointProfile: vi.fn(async () => null) };
    for (const bad of [
      { ...context, evaluationTime: "invalid" },
      { ...context, scope: { ...context.scope, tenantId: "" } },
      {
        ...context,
        source: {
          ...context.source,
          reference: { ...context.source.reference, endpointProfileVersion: "Version:invalid" },
        },
      },
      { ...context, approved: true },
    ])
      await expect(read(bad, reader)).rejects.toBeInstanceOf(
        PolicyEvaluationDefinitionReadInputError,
      );
    expect(reader.findEndpointProfile).not.toHaveBeenCalled();
  });

  it("enumerates only the exact original configuration occurrence with bounded bytes and revalidated body/hash", () => {
    const context = input();
    const evidence = inspect(context, record());
    const result = enumerate(context, evidence, limits);
    const reference = {
      kind: "artifact",
      path: "/configuration",
      reference: record().configuration,
    };
    expect(result.references).toEqual([reference]);
    expect(result.referenceBytes).toBe(encodeEvaluationCanonicalJson(reference).byteLength);
    expect(
      enumerate(context, evidence, { maxReferences: 1, maxReferenceBytes: result.referenceBytes }),
    ).toEqual(result);
    expect(() =>
      enumerate(context, evidence, {
        maxReferences: 1,
        maxReferenceBytes: result.referenceBytes - 1,
      }),
    ).toThrow();
    expect(() =>
      enumerate(context, evidence, { maxReferences: 0, maxReferenceBytes: result.referenceBytes }),
    ).toThrow();
    if (evidence.observation.status !== "verified")
      throw new Error("Expected original verified endpoint");
    const changedHash = {
      source: evidence.source,
      observation: { status: "verified" as const, recordSha256: "0".repeat(64) },
      record: record(),
    };
    expect(() => enumerate(context, changedHash, limits)).toThrow();
    const changedBody = {
      source: evidence.source,
      observation: evidence.observation,
      record: { ...record(), registeredAt: "2026-09-02T00:00:00.001Z" },
    };
    expect(() => enumerate(context, changedBody, limits)).toThrow();
    expect(() =>
      enumerate(
        { ...context, scope: { ...context.scope, tenantId: "other_scope" } },
        evidence,
        limits,
      ),
    ).toThrow();
  });
});
