import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceScopeSchema } from "./evidence.js";
import { encodeReleaseApprovalPublicationDefinition } from "./release-approval-publication-encoding.js";
import { ReleaseApprovalPublicationDefinitionSchema } from "./release-approval-publication.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/release-approval-publication-v1.json", import.meta.url), "utf8"),
) as {
  vectors: {
    name: string;
    input: { scope: unknown; definition: unknown };
    encodedByteLength: number;
    sha256: string;
  }[];
};
function input() {
  const value = document.vectors[0];
  if (!value) throw new Error("Missing independent original approval vector");
  return {
    scope: EvidenceScopeSchema.parse(value.input.scope),
    definition: ReleaseApprovalPublicationDefinitionSchema.parse(value.input.definition),
  };
}
describe("original approval publication canonical identity", () => {
  it.each(document.vectors)("matches independent Python $name", (v) => {
    const bytes = encodeReleaseApprovalPublicationDefinition({
      scope: EvidenceScopeSchema.parse(v.input.scope),
      definition: ReleaseApprovalPublicationDefinitionSchema.parse(v.input.definition),
    });
    expect(bytes.byteLength).toBe(v.encodedByteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(v.sha256);
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects envelope %s substitution",
    (key) => {
      const value = input();
      expect(() =>
        encodeReleaseApprovalPublicationDefinition({
          ...value,
          scope: { ...value.scope, [key]: "other_scope" },
        }),
      ).toThrow();
    },
  );
  it.each([
    { operation: "manage_reviewer_authority" },
    { current: true },
    { authenticated: true },
    { issuedAt: "2026-10-15T09:59:59.999999Z" },
    {
      identity: {
        kind: "service_credential",
        principalId: "user_release_reviewer",
        credentialId: "credential_other",
      },
    },
    {
      identity: {
        kind: "oidc_binding",
        principalId: "other_user",
        bindingId: "binding_release_reviewer",
      },
    },
  ])("rejects caller-injected or inconsistent provenance %j", (patch) => {
    expect(
      ReleaseApprovalPublicationDefinitionSchema.safeParse({ ...input().definition, ...patch })
        .success,
    ).toBe(false);
  });
  it("binds each original receipt and keeps key-order equivalence", () => {
    const value = input(),
      original = encodeReleaseApprovalPublicationDefinition(value);
    expect(
      encodeReleaseApprovalPublicationDefinition({
        ...value,
        definition: Object.fromEntries(
          Object.entries(value.definition).reverse(),
        ) as typeof value.definition,
      }),
    ).toEqual(original);
    for (const patch of [
      { actor: { ...value.definition.actor, requestId: "other_request" } },
      { grantSha256: "a".repeat(64) },
      { credentialSha256: "b".repeat(64) },
      { subject: { ...value.definition.subject, recordSha256: "c".repeat(64) } },
      { issuedAt: "2026-10-15T10:00:05.000002Z" },
    ])
      expect(
        encodeReleaseApprovalPublicationDefinition({
          ...value,
          definition: { ...value.definition, ...patch },
        }),
      ).not.toEqual(original);
  });
});
