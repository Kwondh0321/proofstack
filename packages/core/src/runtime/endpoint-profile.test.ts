import { readFileSync } from "node:fs";
import {
  type EndpointProfileDefinition,
  type EndpointProfileRecord,
  type EvidenceScope,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestEndpointProfile,
  InvalidEndpointProfileRecordError,
  MAX_STATIC_ENDPOINT_PROFILES,
  StaticEndpointProfileCatalogue,
  validateEndpointProfileRecord,
} from "./endpoint-profile.js";

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
  const vector = vectors[index];
  if (!vector) throw new Error("Missing independent endpoint vector");
  return structuredClone({
    ...vector.input.definition,
    scope: vector.input.scope,
    definitionSha256: vector.sha256,
    schemaVersion: "0.1" as const,
    registeredAt: "2026-10-08T00:00:00.001Z",
    registeredByPrincipalId: "operator_endpoint",
  });
}
function rehash(value: EndpointProfileRecord) {
  const {
    definitionSha256: _sha,
    registeredAt: _at,
    registeredByPrincipalId: _by,
    schemaVersion: _version,
    scope,
    ...definition
  } = value;
  value.definitionSha256 = digestEndpointProfile(scope, definition);
  return value;
}

describe("independent retained endpoint catalogue", () => {
  it("uses all three scope coordinates and exact case-sensitive ID/version without latest selection", async () => {
    const rows = [
      record(0),
      record(1),
      record(2),
      rehash({ ...record(), scope: { ...record().scope, tenantId: "tenant_endpoint_c" } }),
    ];
    const catalogue = new StaticEndpointProfileCatalogue(rows);
    for (const row of rows)
      await expect(
        catalogue.findEndpointProfile(row.scope, row.endpointProfileId, row.endpointProfileVersion),
      ).resolves.toEqual(row);
    const original = record();
    for (const field of ["tenantId", "projectId", "environmentId"] as const)
      await expect(
        catalogue.findEndpointProfile(
          { ...original.scope, [field]: "scope_missing" },
          original.endpointProfileId,
          original.endpointProfileVersion,
        ),
      ).resolves.toBeNull();
    for (const [id, version] of [
      ["endpoint_missing", original.endpointProfileVersion],
      [original.endpointProfileId, "V0.0"],
      [original.endpointProfileId, original.endpointProfileVersion.toLowerCase()],
    ] as const)
      await expect(catalogue.findEndpointProfile(original.scope, id, version)).resolves.toBeNull();
    await expect(
      new StaticEndpointProfileCatalogue([]).findEndpointProfile(
        original.scope,
        original.endpointProfileId,
        original.endpointProfileVersion,
      ),
    ).resolves.toBeNull();
  });

  it("rejects malformed/coercible lookup coordinates before interpreting missingness", async () => {
    const original = record();
    const catalogue = new StaticEndpointProfileCatalogue([original]);
    for (const scope of [
      { ...original.scope, tenantId: "" },
      { ...original.scope, projectId: "" },
      { ...original.scope, environmentId: "" },
      { ...original.scope, approved: true },
    ])
      await expect(
        catalogue.findEndpointProfile(
          scope,
          original.endpointProfileId,
          original.endpointProfileVersion,
        ),
      ).rejects.toThrow();
    let coerced = false;
    const coercible = {
      toString: () => {
        coerced = true;
        return original.endpointProfileId;
      },
    };
    for (const [id, version] of [
      ["", original.endpointProfileVersion],
      [original.endpointProfileId, ""],
      [coercible, original.endpointProfileVersion],
      [original.endpointProfileId, "Version:invalid"],
    ])
      await expect(
        catalogue.findEndpointProfile(original.scope, id as string, version as string),
      ).rejects.toThrow();
    expect(coerced).toBe(false);
    expect(new InvalidEndpointProfileRecordError().code).toBe("endpoint_profile_record_invalid");
  });

  it("copies all input state and detaches nested declarations/artifacts/receipts on every read", async () => {
    const original = record();
    const supplied = [structuredClone(original)];
    const catalogue = new StaticEndpointProfileCatalogue(supplied);
    const input = supplied[0];
    if (!input) throw new Error("Missing input");
    input.operations.pop();
    input.boundaryKinds.pop();
    input.destination.hostname = "input.example";
    input.configuration.sha256 = "f".repeat(64);
    input.scope.tenantId = "input_mutation";
    input.registeredAt = "2026-10-09T00:00:00.001Z";
    supplied.length = 0;
    const read = () =>
      catalogue.findEndpointProfile(
        original.scope,
        original.endpointProfileId,
        original.endpointProfileVersion,
      );
    const first = await read();
    expect(first).toEqual(original);
    if (!first) throw new Error("Missing copied record");
    first.operations.pop();
    first.boundaryKinds.pop();
    first.destination.hostname = "output.example";
    first.configuration.sha256 = "e".repeat(64);
    first.scope.projectId = "output_mutation";
    first.registeredByPrincipalId = "output_mutation";
    await expect(read()).resolves.toEqual(original);
  });

  it("validates independent semantic digests while retaining changed original receipt fields", () => {
    for (let i = 0; i < vectors.length; i++) {
      const row = record(i);
      expect(rehash(structuredClone(row)).definitionSha256).toBe(row.definitionSha256);
      expect(validateEndpointProfileRecord(row)).toEqual(row);
      const changed = {
        ...row,
        registeredAt: "2026-10-09T00:00:00.001Z",
        registeredByPrincipalId: "operator_other",
      };
      expect(validateEndpointProfileRecord(changed)).toEqual(changed);
      expect(rehash(structuredClone(changed)).definitionSha256).toBe(row.definitionSha256);
    }
    const original = record();
    for (const raw of [
      null,
      undefined,
      { ...original, definitionSha256: "f".repeat(64) },
      { ...original, endpointProfileId: "endpoint_other" },
      { ...original, endpointProfileVersion: "V1.0+RC-2" },
      { ...original, destination: { ...original.destination, hostname: "other.example" } },
      { ...original, configuration: { ...original.configuration, sha256: "b".repeat(64) } },
      { ...original, scope: { ...original.scope, tenantId: "tenant_other" } },
      { ...original, approved: true },
      { ...original, registeredAt: "2026-10-08T00:00:00.001001Z" },
    ]) {
      expect(() => validateEndpointProfileRecord(raw)).toThrow(InvalidEndpointProfileRecordError);
      expect(() => new StaticEndpointProfileCatalogue([raw])).toThrow(
        InvalidEndpointProfileRecordError,
      );
    }
  });

  it("rejects duplicate identities even with changed receipts or independently valid changed semantics", () => {
    const original = record();
    for (const other of [
      structuredClone(original),
      { ...original, registeredAt: "2026-10-09T00:00:00.001Z" },
      { ...original, registeredByPrincipalId: "operator_other" },
      rehash({ ...original, provider: "other/provider" }),
    ])
      expect(() => new StaticEndpointProfileCatalogue([original, other])).toThrow("Duplicate");
  });

  it("accepts the exact 256-entry limit and rejects overflow before inspecting any record", async () => {
    const rows = Array.from({ length: MAX_STATIC_ENDPOINT_PROFILES }, (_, i) =>
      rehash({ ...record(), endpointProfileVersion: `V1.${i}+RC` }),
    );
    const catalogue = new StaticEndpointProfileCatalogue(rows);
    const last = rows.at(-1);
    if (!last) throw new Error("Missing exact limit");
    await expect(
      catalogue.findEndpointProfile(
        last.scope,
        last.endpointProfileId,
        last.endpointProfileVersion,
      ),
    ).resolves.toEqual(last);
    let visited = false;
    const overflow = new Proxy(Array(MAX_STATIC_ENDPOINT_PROFILES + 1).fill(null), {
      get: (target, property, receiver) => {
        if (property === "0") visited = true;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => new StaticEndpointProfileCatalogue(overflow)).toThrow("entry limit");
    expect(visited).toBe(false);
  });

  it("rejects non-array and sparse catalogues without invented profile bodies", () => {
    for (const input of [
      null,
      undefined,
      {},
      { length: 0 },
      { length: -1 },
      { length: NaN },
      new Array(2),
    ])
      expect(() => new StaticEndpointProfileCatalogue(input as readonly unknown[])).toThrow();
  });
});
