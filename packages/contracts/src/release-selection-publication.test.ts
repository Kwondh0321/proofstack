import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceScopeSchema } from "./evidence.js";
import { encodeReleaseSelectionPublicationDefinition } from "./release-selection-publication-encoding.js";
import { ReleaseSelectionPublicationDefinitionSchema } from "./release-selection-publication.js";
import {
  PublishReleasePolicySelectionRequestSchema,
  ReleasePolicySelectionDefinitionSchema,
  PublishReleasePolicySelectionLifecycleRequestSchema,
} from "./release-policy-selection.js";

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/release-selection-publication-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    input: { scope: unknown; definition: unknown };
    encodedByteLength: number;
    sha256: string;
  }[];
};
const selection = JSON.parse(
  readFileSync(
    new URL("../vectors/release-policy-selection-definition-v1.json", import.meta.url),
    "utf8",
  ),
).vectors[0].input.definition;
function input() {
  const first = document.vectors[0];
  if (!first) throw new Error("Fixture missing");
  return {
    scope: EvidenceScopeSchema.parse(first.input.scope),
    definition: ReleaseSelectionPublicationDefinitionSchema.parse(first.input.definition),
  };
}
describe("original authenticated selection publication contracts", () => {
  it.each(document.vectors)("matches independent Python UTF-8/hash vector $name", (vector) => {
    const bytes = encodeReleaseSelectionPublicationDefinition({
      scope: EvidenceScopeSchema.parse(vector.input.scope),
      definition: ReleaseSelectionPublicationDefinitionSchema.parse(vector.input.definition),
    });
    expect(bytes.byteLength).toBe(vector.encodedByteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
  });
  it("preserves canonical bytes across key ordering and binds all original native receipt fields", () => {
    const value = input(),
      bytes = encodeReleaseSelectionPublicationDefinition(value);
    expect(
      encodeReleaseSelectionPublicationDefinition({
        scope: value.scope,
        definition: Object.fromEntries(
          Object.entries(value.definition).reverse(),
        ) as typeof value.definition,
      }),
    ).toEqual(bytes);
    expect(
      encodeReleaseSelectionPublicationDefinition({
        ...value,
        definition: { ...value.definition, issuedAt: "2026-10-15T12:10:00.000002Z" },
      }),
    ).not.toEqual(bytes);
    expect(
      encodeReleaseSelectionPublicationDefinition({
        ...value,
        definition: {
          ...value.definition,
          actor: { ...value.definition.actor, requestId: "request_other" },
        },
      }),
    ).not.toEqual(bytes);
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects substituted envelope %s",
    (key) => {
      const value = input();
      expect(() =>
        encodeReleaseSelectionPublicationDefinition({
          ...value,
          scope: { ...value.scope, [key]: "scope_other" },
        }),
      ).toThrow();
    },
  );
  it.each(["principal", "time", "operation", "extra"])("rejects invalid original %s", (change) => {
    const value = input();
    let definition: unknown = value.definition;
    if (change === "principal")
      definition = {
        ...value.definition,
        identity: { ...value.definition.identity, principalId: "user_other" },
      };
    if (change === "time")
      definition = { ...value.definition, issuedAt: "2026-10-15T11:59:59.999999Z" };
    if (change === "operation") definition = { ...value.definition, operation: "publish_decision" };
    if (change === "extra") definition = { ...value.definition, authenticated: true };
    expect(() => ReleaseSelectionPublicationDefinitionSchema.parse(definition)).toThrow();
  });
  it("retains old selection definitions but excludes server scope/issuer/clock from public intent", () => {
    const value = ReleasePolicySelectionDefinitionSchema.parse(selection);
    const { scope: _scope, issuerPrincipalId: _issuer, ...intent } = value;
    expect(PublishReleasePolicySelectionRequestSchema.parse(intent)).toEqual(intent);
    for (const field of [
      "scope",
      "issuerPrincipalId",
      "publishedAt",
      "publication",
      "definitionSha256",
    ])
      expect(() =>
        PublishReleasePolicySelectionRequestSchema.parse({ ...intent, [field]: "caller_supplied" }),
      ).toThrow();
  });
  it("requires exact lifecycle intent without caller actor or cut", () => {
    const value = input().definition.subject.selection;
    const intent = {
      eventId: "event_withdrawn",
      kind: "withdrawn",
      selection: value,
      reason: "Withdraw the exact installed selection.",
    };
    expect(PublishReleasePolicySelectionLifecycleRequestSchema.parse(intent)).toEqual(intent);
    expect(() =>
      PublishReleasePolicySelectionLifecycleRequestSchema.parse({
        ...intent,
        actorPrincipalId: "user_caller",
      }),
    ).toThrow();
    expect(() =>
      PublishReleasePolicySelectionLifecycleRequestSchema.parse({
        ...intent,
        occurredAt: "2026-10-15T12:00:00Z",
      }),
    ).toThrow();
  });
});
