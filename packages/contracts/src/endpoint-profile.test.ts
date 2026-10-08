import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_CONTENT_BYTES } from "./artifact.js";
import {
  type EndpointProfileDefinition,
  EndpointProfileDefinitionSchema,
  EndpointProfileRecordSchema,
  EndpointProfileReferenceSchema,
  MAX_ENDPOINT_PROFILE_OPERATIONS,
} from "./endpoint-profile.js";
import { encodeEndpointProfile } from "./endpoint-profile-encoding.js";
import type { EvidenceScope } from "./evidence.js";
import { ModelInteractionAttemptSchema } from "./interaction.js";
import { ReplayBoundaryDeclarationSchema } from "./replay-plan.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/endpoint-profile-v1.json", import.meta.url), "utf8"),
) as {
  format: string;
  vectors: {
    input: { definition: EndpointProfileDefinition; scope: EvidenceScope };
    encodedByteLength: number;
    sha256: string;
    canonical: string;
  }[];
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function first() {
  const vector = document.vectors[0];
  if (!vector) throw new Error("Missing independent endpoint vector");
  return structuredClone(vector);
}

describe("retained endpoint profile definitions", () => {
  it("reuses original references, HTTPS destinations and provider name contracts", () => {
    const live = ReplayBoundaryDeclarationSchema.options[0];
    expect(EndpointProfileReferenceSchema).toBe(live.shape.endpointProfile);
    expect(EndpointProfileDefinitionSchema.shape.destination).toBe(live.shape.destination);
    expect(EndpointProfileDefinitionSchema.shape.provider).toBe(
      ModelInteractionAttemptSchema.shape.provider.shape.name,
    );
    const vector = first();
    expect(
      EndpointProfileReferenceSchema.parse({
        endpointProfileId: vector.input.definition.endpointProfileId,
        endpointProfileVersion: vector.input.definition.endpointProfileVersion,
        definitionSha256: vector.sha256,
      }),
    ).toEqual({
      endpointProfileId: "endpoint_reference",
      endpointProfileVersion: "V1.0+RC-1",
      definitionSha256: vector.sha256,
    });
  });

  it("binds every scope coordinate and semantic leaf, including original classified artifact descriptors", () => {
    const vector = first();
    const original = hash(encodeEndpointProfile(vector.input));
    const mutations: ((value: typeof vector.input) => void)[] = [
      ...(["tenantId", "projectId", "environmentId"] as const).map(
        (field) => (value: typeof vector.input) => {
          value.scope[field] = "scope_other";
        },
      ),
      (v) => {
        v.definition.endpointProfileId = "endpoint_other";
      },
      (v) => {
        v.definition.endpointProfileVersion = "V1.0+RC-2";
      },
      (v) => {
        v.definition.provider = "other/provider";
      },
      (v) => {
        v.definition.destination.hostname = "other.reference.example";
      },
      (v) => {
        v.definition.operations = ["Chat", "generate_content"];
      },
      (v) => {
        v.definition.boundaryKinds = ["data", "tool"];
      },
      (v) => {
        v.definition.configuration.artifactId = "artifact_other";
      },
      (v) => {
        v.definition.configuration.classification = "restricted";
      },
      (v) => {
        v.definition.configuration.mediaType = "application/octet-stream";
      },
      (v) => {
        v.definition.configuration.sha256 = "b".repeat(64);
      },
      (v) => {
        v.definition.configuration.sizeBytes++;
      },
      (v) => {
        v.definition.configuration.redactedAt = "retention";
      },
      (v) => {
        delete v.definition.configuration.redactedAt;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(vector.input);
      mutate(changed);
      expect(hash(encodeEndpointProfile(changed))).not.toBe(original);
    }
  });

  it("admits exact original maximal tokens, case-sensitive versions and complete declaration limits", () => {
    const definition = first().input.definition;
    definition.endpointProfileId = "e".repeat(64);
    definition.endpointProfileVersion = `V+RC-1.${"x".repeat(57)}`;
    definition.provider = `P:/@+${"x".repeat(251)}`;
    definition.destination.hostname = [63, 63, 63, 61].map((n) => "a".repeat(n)).join(".");
    definition.operations = Array.from(
      { length: MAX_ENDPOINT_PROFILE_OPERATIONS },
      (_, i) => `Operation:/@+${String(i).padStart(2, "0")}${"x".repeat(241)}`,
    );
    definition.boundaryKinds = ["data", "model", "retrieval", "tool"];
    definition.configuration.mediaType = `${"x".repeat(127)}/${"y".repeat(127)}`;
    definition.configuration.sizeBytes = MAX_ARTIFACT_CONTENT_BYTES;
    expect(definition.endpointProfileVersion).toHaveLength(64);
    expect(definition.provider).toHaveLength(256);
    expect(definition.destination.hostname).toHaveLength(253);
    expect(definition.operations[0]).toHaveLength(256);
    expect(EndpointProfileDefinitionSchema.parse(definition)).toEqual(definition);
    for (const patch of [
      { endpointProfileId: `${definition.endpointProfileId}x` },
      { endpointProfileVersion: `${definition.endpointProfileVersion}x` },
      { provider: `${definition.provider}x` },
      { operations: [...definition.operations, "zz_over_limit"] },
      { operations: [`${definition.operations[0]}x`] },
      {
        destination: { ...definition.destination, hostname: `${definition.destination.hostname}x` },
      },
      { configuration: { ...definition.configuration, sizeBytes: MAX_ARTIFACT_CONTENT_BYTES + 1 } },
      {
        configuration: {
          ...definition.configuration,
          mediaType: `${definition.configuration.mediaType}x`,
        },
      },
    ])
      expect(EndpointProfileDefinitionSchema.safeParse({ ...definition, ...patch }).success).toBe(
        false,
      );
  });

  it("rejects missing, duplicate, unordered and unsupported declarations without invented capability", () => {
    const definition = first().input.definition;
    for (const patch of [
      { operations: [] },
      { operations: ["chat", "chat"] },
      { operations: ["generate_content", "chat"] },
      { operations: [""] },
      { operations: ["chat with space"] },
      { operations: ["chat?query"] },
      { boundaryKinds: [] },
      { boundaryKinds: ["model", "model"] },
      { boundaryKinds: ["tool", "model"] },
      { boundaryKinds: ["unknown"] },
      { boundaryKinds: ["data", "model", "retrieval", "tool", "tool"] },
      { provider: "" },
      { endpointProfileVersion: "version:unsupported" },
      { endpointProfileVersion: "" },
      { recordKind: "runtime_adapter" },
      { destination: { ...definition.destination, scheme: "http" } },
      { destination: { ...definition.destination, port: 80 } },
      { destination: { ...definition.destination, hostname: "127.0.0.1" } },
      { configuration: { ...definition.configuration, sizeBytes: 0 } },
      { configuration: { ...definition.configuration, sha256: "requested_hash" } },
    ])
      expect(EndpointProfileDefinitionSchema.safeParse({ ...definition, ...patch }).success).toBe(
        false,
      );
  });

  it("retains original millisecond receipts outside semantics and rejects unknown authority at every boundary", () => {
    const vector = first();
    const record = {
      ...vector.input.definition,
      scope: vector.input.scope,
      definitionSha256: vector.sha256,
      schemaVersion: "0.1",
      registeredAt: "2026-10-08T00:00:00.001Z",
      registeredByPrincipalId: "operator_endpoint",
    };
    expect(EndpointProfileRecordSchema.parse(record)).toEqual(record);
    expect(EndpointProfileDefinitionSchema.safeParse(record).success).toBe(false);
    for (const field of ["approved", "credentials", "execute", "latest", "providerAuthenticated"])
      for (const value of [true, undefined]) {
        expect(
          EndpointProfileDefinitionSchema.safeParse({ ...vector.input.definition, [field]: value })
            .success,
        ).toBe(false);
        expect(EndpointProfileRecordSchema.safeParse({ ...record, [field]: value }).success).toBe(
          false,
        );
        expect(
          EndpointProfileRecordSchema.safeParse({
            ...record,
            destination: { ...record.destination, [field]: value },
          }).success,
        ).toBe(false);
        expect(
          EndpointProfileRecordSchema.safeParse({
            ...record,
            configuration: { ...record.configuration, [field]: value },
          }).success,
        ).toBe(false);
        expect(
          EndpointProfileRecordSchema.safeParse({
            ...record,
            scope: { ...record.scope, [field]: value },
          }).success,
        ).toBe(false);
      }
    for (const patch of [
      { registeredAt: "2026-10-08T00:00:00.001001Z" },
      { registeredAt: "invalid" },
      { registeredByPrincipalId: "" },
      { definitionSha256: "invalid" },
      { schemaVersion: "2" },
    ])
      expect(EndpointProfileRecordSchema.safeParse({ ...record, ...patch }).success).toBe(false);
    expect(() =>
      encodeEndpointProfile({
        ...vector.input,
        registeredAt: record.registeredAt,
      } as typeof vector.input),
    ).toThrow();
    expect(() =>
      encodeEndpointProfile({
        ...vector.input,
        scope: { ...vector.input.scope, approved: true },
      } as typeof vector.input),
    ).toThrow();
  });

  it("pins independent tenant collisions and an exact distinct version", () => {
    expect(document.format).toBe("proofstack.endpoint-profile.v1");
    expect(document.vectors).toHaveLength(3);
    expect(document.vectors[0]?.input.definition).toEqual(document.vectors[1]?.input.definition);
    expect(document.vectors[0]?.sha256).not.toBe(document.vectors[1]?.sha256);
    expect(document.vectors[0]?.input.scope).toEqual(document.vectors[2]?.input.scope);
    expect(document.vectors[0]?.input.definition.endpointProfileVersion).not.toBe(
      document.vectors[2]?.input.definition.endpointProfileVersion,
    );
  });

  for (const [index, vector] of document.vectors.entries())
    it(`independent vector ${index}: complete canonical bytes, length and digest`, () => {
      const bytes = encodeEndpointProfile(vector.input);
      expect(bytes.byteLength).toBe(vector.encodedByteLength);
      expect(Buffer.from(bytes).toString("utf8")).toBe(vector.canonical);
      expect(hash(bytes)).toBe(vector.sha256);
      const independent = JSON.parse(vector.canonical) as Record<string, unknown>;
      expect(independent).toEqual({
        ...vector.input,
        definitionDomain: "proofstack.endpoint-profile.v1",
        encodingVersion: "proofstack.endpoint-profile-jcs.v1",
        schemaVersion: "0.1",
      });
      expect(
        encodeEndpointProfile({
          ...vector.input,
          definition: Object.fromEntries(
            Object.entries(vector.input.definition).reverse(),
          ) as EndpointProfileDefinition,
        }),
      ).toEqual(bytes);
    });
});
