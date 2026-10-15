import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  encodeReleaseApprovalDefinition,
  encodeReleaseReviewerAuthorityDefinition,
  RELEASE_APPROVAL_DEFINITION_DOMAIN,
  RELEASE_APPROVAL_ENCODING_VERSION,
  RELEASE_REVIEWER_AUTHORITY_DEFINITION_DOMAIN,
  RELEASE_REVIEWER_AUTHORITY_ENCODING_VERSION,
} from "./release-approval-encoding.js";
import { ReleaseApprovalDefinitionSchema } from "./release-approval.js";
import { ReleaseReviewerAuthorityDefinitionSchema } from "./release-reviewer-authority.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/release-approval-definition-v1.json", import.meta.url), "utf8"),
) as {
  format: string;
  vectors: {
    name: string;
    input: { scope: unknown; definition: unknown };
    encodedByteLength: number;
    sha256: string;
  }[];
};
function authority() {
  const v = document.vectors[0];
  return {
    scope: EvidenceScopeSchema.parse(v?.input.scope),
    definition: ReleaseReviewerAuthorityDefinitionSchema.parse(v?.input.definition),
  };
}
function approval() {
  const v = document.vectors[1];
  return {
    scope: EvidenceScopeSchema.parse(v?.input.scope),
    definition: ReleaseApprovalDefinitionSchema.parse(v?.input.definition),
  };
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("canonical reviewer authority and original approval identity", () => {
  it("matches independent Python scalar/integer UTF-8 and digest vectors", () => {
    expect(document.format).toBe("proofstack.release-approval-definition.v1");
    for (const [i, vector] of document.vectors.entries()) {
      const scope = EvidenceScopeSchema.parse(vector.input.scope);
      const bytes =
        i === 0
          ? encodeReleaseReviewerAuthorityDefinition({
              scope,
              definition: ReleaseReviewerAuthorityDefinitionSchema.parse(vector.input.definition),
            })
          : encodeReleaseApprovalDefinition({
              scope,
              definition: ReleaseApprovalDefinitionSchema.parse(vector.input.definition),
            });
      expect(bytes.byteLength).toBe(vector.encodedByteLength);
      expect(hash(bytes)).toBe(vector.sha256);
      const text = Buffer.from(bytes).toString("utf8");
      expect(text).toContain(
        i === 0 ? RELEASE_REVIEWER_AUTHORITY_DEFINITION_DOMAIN : RELEASE_APPROVAL_DEFINITION_DOMAIN,
      );
      expect(text).toContain(
        i === 0 ? RELEASE_REVIEWER_AUTHORITY_ENCODING_VERSION : RELEASE_APPROVAL_ENCODING_VERSION,
      );
    }
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects substituted %s in both digest envelopes",
    (key) => {
      expect(() =>
        encodeReleaseReviewerAuthorityDefinition({
          ...authority(),
          scope: { ...authority().scope, [key]: "scope_other" },
        }),
      ).toThrow(/digest scope/);
      expect(() =>
        encodeReleaseApprovalDefinition({
          ...approval(),
          scope: { ...approval().scope, [key]: "scope_other" },
        }),
      ).toThrow(/digest scope/);
    },
  );
  it("preserves object-order equivalence without omitting original authentication", () => {
    const a = authority();
    const p = approval();
    expect(
      encodeReleaseReviewerAuthorityDefinition({
        ...a,
        definition: Object.fromEntries(
          Object.entries(a.definition).reverse(),
        ) as typeof a.definition,
      }),
    ).toEqual(encodeReleaseReviewerAuthorityDefinition(a));
    expect(
      encodeReleaseApprovalDefinition({
        ...p,
        definition: Object.fromEntries(
          Object.entries(p.definition).reverse(),
        ) as typeof p.definition,
      }),
    ).toEqual(encodeReleaseApprovalDefinition(p));
  });
  it("binds actual original session/request/time and authority rather than rewriting on retry", () => {
    const v = approval();
    const original = hash(encodeReleaseApprovalDefinition(v));
    for (const change of [
      { reviewer: { ...v.definition.reviewer, credentialId: "session_other" } },
      { reviewer: { ...v.definition.reviewer, requestId: "request_other" } },
      { reviewer: { ...v.definition.reviewer, authenticatedAt: "2026-10-15T10:00:01.000Z" } },
      { recordedAt: "2026-10-15T10:00:05.000002Z" },
      { authority: { ...v.definition.authority, definitionSha256: "f".repeat(64) } },
      { expiresAt: "2026-10-15T11:00:00.000002Z" },
      { action: "oppose" as const },
      { conditions: ["Additional independent verification remains required."] },
    ])
      expect(
        hash(encodeReleaseApprovalDefinition({ ...v, definition: { ...v.definition, ...change } })),
      ).not.toBe(original);
  });
  it("binds all original subject references and declaration provenance", () => {
    const p = approval();
    const original = hash(encodeReleaseApprovalDefinition(p));
    for (const key of [
      "candidate",
      "policy",
      "request",
      "snapshot",
      "evaluation",
      "selection",
    ] as const) {
      const subject = {
        ...p.definition.subject,
        [key]: { ...p.definition.subject[key], definitionSha256: "e".repeat(64) },
      };
      expect(
        hash(encodeReleaseApprovalDefinition({ ...p, definition: { ...p.definition, subject } })),
      ).not.toBe(original);
    }
    const a = authority();
    const originalAuthority = hash(encodeReleaseReviewerAuthorityDefinition(a));
    for (const change of [
      { assurance: "operator_verified" as const },
      { roleIds: ["role_other"] },
      { independenceGroupIds: ["group_other"] },
      { reviewBasis: [{ ...a.definition.reviewBasis[0], artifactId: "artifact_other" }] },
      { rationale: "A changed attributable review basis" },
      { expiresAt: "2026-10-16T00:00:00.000002Z" },
    ])
      expect(
        hash(
          encodeReleaseReviewerAuthorityDefinition({
            ...a,
            definition: ReleaseReviewerAuthorityDefinitionSchema.parse({
              ...a.definition,
              ...change,
            }),
          }),
        ),
      ).not.toBe(originalAuthority);
  });
  it("rejects private proof, server metadata and extra envelope authority claims", () => {
    for (const field of ["sessionDigest", "currentlyEligible", "definitionSha256", "publishedAt"]) {
      expect(() =>
        encodeReleaseReviewerAuthorityDefinition({
          ...authority(),
          definition: { ...authority().definition, [field]: "untrusted" },
        }),
      ).toThrow();
      expect(() =>
        encodeReleaseApprovalDefinition({
          ...approval(),
          definition: { ...approval().definition, [field]: "untrusted" },
        }),
      ).toThrow();
    }
    expect(() =>
      encodeReleaseApprovalDefinition({ ...approval(), current: true } as never),
    ).toThrow();
    expect(() =>
      encodeReleaseReviewerAuthorityDefinition({ ...authority(), current: true } as never),
    ).toThrow();
  });
});
