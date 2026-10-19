import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceScopeSchema } from "./evidence.js";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import {
  MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES,
  MAX_RELEASE_REVIEWER_AUTHORITY_REQUEST_BYTES,
  MAX_RELEASE_REVIEWER_AUTHORITY_RESPONSE_BYTES,
  PublishReleaseReviewerAuthorityLifecycleRequestSchema,
  PublishReleaseReviewerAuthorityRequestSchema,
  ReleaseReviewerAuthorityDefinitionSchema,
  ReleaseReviewerAuthoritySchema,
} from "./release-reviewer-authority.js";
import { encodeReleaseReviewerPublicationDefinition } from "./release-reviewer-publication-encoding.js";
import { ReleaseReviewerPublicationDefinitionSchema } from "./release-reviewer-publication.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/release-reviewer-publication-v1.json", import.meta.url), "utf8"),
) as {
  vectors: {
    name: string;
    input: { scope: unknown; definition: unknown };
    encodedByteLength: number;
    sha256: string;
  }[];
};
function input() {
  const first = document.vectors[0];
  if (!first) throw new Error("Missing independent vector");
  return {
    scope: EvidenceScopeSchema.parse(first.input.scope),
    definition: ReleaseReviewerPublicationDefinitionSchema.parse(first.input.definition),
  };
}
function intent() {
  const old = JSON.parse(
    readFileSync(
      new URL("../vectors/release-approval-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ).vectors[0].input.definition;
  const {
    scope: _scope,
    issuerPrincipalId: _issuer,
    ...request
  } = ReleaseReviewerAuthorityDefinitionSchema.parse(old);
  return request;
}
function requestAtBytes(bytes: number) {
  const value = intent();
  value.rationale = "😀".repeat(1024);
  value.affiliations = Array.from(
    { length: 32 },
    (_, i) => `aff_${i.toString().padStart(3, "0")}_`,
  );
  let remaining = bytes - encodeEvaluationCanonicalJson(value).byteLength;
  for (let i = 0; i < value.affiliations.length; i++) {
    const prefix = value.affiliations[i] ?? "";
    const added = Math.min(remaining, (512 - prefix.length - 3) * 4);
    if (added < 0) throw new Error("Invalid request byte fixture base");
    value.affiliations[i] = prefix + "😀".repeat(Math.floor(added / 4)) + "x".repeat(added % 4);
    remaining -= added;
  }
  if (remaining !== 0) throw new Error("Insufficient request fixture headroom");
  expect(encodeEvaluationCanonicalJson(value).byteLength).toBe(bytes);
  return value;
}

describe("original reviewer administrator publication contracts", () => {
  it.each(document.vectors)("matches independent Python vector $name", (vector) => {
    const bytes = encodeReleaseReviewerPublicationDefinition({
      scope: EvidenceScopeSchema.parse(vector.input.scope),
      definition: ReleaseReviewerPublicationDefinitionSchema.parse(vector.input.definition),
    });
    expect(bytes.byteLength).toBe(vector.encodedByteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
  });
  it("is key-order independent and binds each original receipt component", () => {
    const value = input();
    const bytes = encodeReleaseReviewerPublicationDefinition(value);
    expect(
      encodeReleaseReviewerPublicationDefinition({
        ...value,
        definition: Object.fromEntries(
          Object.entries(value.definition).reverse(),
        ) as typeof value.definition,
      }),
    ).toEqual(bytes);
    for (const patch of [
      { issuedAt: "2026-10-15T12:10:00.000002Z" },
      { actor: { ...value.definition.actor, requestId: "request_other" } },
      { grantSha256: "b".repeat(64) },
      { credentialSha256: "c".repeat(64) },
      { subject: { ...value.definition.subject, recordSha256: "d".repeat(64) } },
    ])
      expect(
        encodeReleaseReviewerPublicationDefinition({
          ...value,
          definition: { ...value.definition, ...patch },
        }),
      ).not.toEqual(bytes);
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects substituted envelope %s",
    (key) => {
      const value = input();
      expect(() =>
        encodeReleaseReviewerPublicationDefinition({
          ...value,
          scope: { ...value.scope, [key]: "other_scope" },
        }),
      ).toThrow();
    },
  );
  it.each([
    { operation: "manage_selection" },
    { issuedAt: "2026-10-15T11:59:59.999999Z" },
    { current: true },
    { authenticated: true },
    { schemaVersion: "0.1" },
  ])("rejects invalid or injected original profile %j", (patch) => {
    expect(
      ReleaseReviewerPublicationDefinitionSchema.safeParse({ ...input().definition, ...patch })
        .success,
    ).toBe(false);
  });
  it("requires the original actor to own the OIDC identity", () => {
    const value = input().definition;
    expect(
      ReleaseReviewerPublicationDefinitionSchema.safeParse({
        ...value,
        identity: { ...value.identity, principalId: "other_user" },
      }).success,
    ).toBe(false);
  });
});

describe("strict reviewer administrator intents", () => {
  it("reserves scope, issuer, publication, native time and authentication for the server", () => {
    const request = intent();
    expect(PublishReleaseReviewerAuthorityRequestSchema.parse(request)).toEqual(request);
    for (const field of [
      "scope",
      "issuerPrincipalId",
      "publishedAt",
      "publishedByPrincipalId",
      "publication",
      "schemaVersion",
      "definitionSha256",
      "actor",
      "credential",
      "authenticated",
    ])
      expect(
        PublishReleaseReviewerAuthorityRequestSchema.safeParse({ ...request, [field]: "injected" })
          .success,
      ).toBe(false);
    expect(
      ReleaseReviewerAuthorityDefinitionSchema.safeParse({
        ...request,
        scope: input().scope,
        issuerPrincipalId: request.reviewerPrincipalId,
      }).success,
    ).toBe(false);
  });
  it("retains unresolved, rejected and synthetic declarations without upgrading expertise", () => {
    const request = intent();
    for (const status of ["unverifiable", "rejected"] as const) {
      expect(
        PublishReleaseReviewerAuthorityRequestSchema.safeParse({ ...request, status }).success,
      ).toBe(false);
      expect(
        PublishReleaseReviewerAuthorityRequestSchema.parse({
          ...request,
          status,
          statusReasons: ["The declared review basis does not establish eligibility."],
          conflicts: ["Declared conflict"],
        }).status,
      ).toBe(status);
    }
    expect(PublishReleaseReviewerAuthorityRequestSchema.parse(request).assurance).toBe(
      "synthetic_reference",
    );
    for (const patch of [
      { conflicts: ["Declared conflict"] },
      { statusReasons: ["Unresolved review"] },
      { reviewBasis: [] },
      { affiliations: [] },
      { expiresAt: request.effectiveAt },
      { expiresAt: "invalid" },
    ])
      expect(
        PublishReleaseReviewerAuthorityRequestSchema.safeParse({ ...request, ...patch }).success,
      ).toBe(false);
  });
  it("preserves exact predecessor target and version semantics", () => {
    const request = intent();
    const predecessor = {
      ...input().definition.subject.authority,
      authorityId: request.authorityId,
      authorityVersionId: "previous_version",
      installationId: request.installationId,
      gateTargetId: request.gateTargetId,
      reviewerPrincipalId: request.reviewerPrincipalId,
    };
    expect(
      PublishReleaseReviewerAuthorityRequestSchema.safeParse({ ...request, predecessor }).success,
    ).toBe(true);
    for (const patch of [
      { authorityId: "other_authority" },
      { authorityVersionId: request.authorityVersionId },
      { installationId: "other_installation" },
      { gateTargetId: "other_gate" },
      { reviewerPrincipalId: "other_reviewer" },
    ])
      expect(
        PublishReleaseReviewerAuthorityRequestSchema.safeParse({
          ...request,
          predecessor: { ...predecessor, ...patch },
        }).success,
      ).toBe(false);
  });
  it("admits exact UTF-8 request boundaries and fits maximum server-owned fields and response", () => {
    const scope = {
      tenantId: "t".repeat(64),
      projectId: "p".repeat(64),
      environmentId: "e".repeat(64),
    };
    const issuerPrincipalId = "i".repeat(64);
    for (const bytes of [
      MAX_RELEASE_REVIEWER_AUTHORITY_REQUEST_BYTES - 1,
      MAX_RELEASE_REVIEWER_AUTHORITY_REQUEST_BYTES,
    ]) {
      const request = PublishReleaseReviewerAuthorityRequestSchema.parse(requestAtBytes(bytes));
      const definition = ReleaseReviewerAuthorityDefinitionSchema.parse({
        ...request,
        scope,
        issuerPrincipalId,
      });
      expect(encodeEvaluationCanonicalJson(definition).byteLength).toBeLessThanOrEqual(
        MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES,
      );
      const authority = ReleaseReviewerAuthoritySchema.parse({
        ...definition,
        schemaVersion: "0.1",
        definitionSha256: "a".repeat(64),
        publishedAt: "2026-10-15T12:10:00.000001Z",
        publishedByPrincipalId: issuerPrincipalId,
      });
      expect(
        encodeEvaluationCanonicalJson({ authority, created: true, requestId: "\u0000".repeat(128) })
          .byteLength,
      ).toBeLessThanOrEqual(MAX_RELEASE_REVIEWER_AUTHORITY_RESPONSE_BYTES);
    }
    expect(
      PublishReleaseReviewerAuthorityRequestSchema.safeParse(
        requestAtBytes(MAX_RELEASE_REVIEWER_AUTHORITY_REQUEST_BYTES + 1),
      ).success,
    ).toBe(false);
  });
  it("admits only exact revocation or same-target supersession without caller receipts", () => {
    const authority = input().definition.subject.authority;
    const revoked = {
      eventId: "event_reviewer_revoked",
      kind: "revoked",
      authority,
      reason: "Revoke this exact declaration.",
    };
    expect(PublishReleaseReviewerAuthorityLifecycleRequestSchema.parse(revoked)).toEqual(revoked);
    for (const patch of [
      { actorPrincipalId: "injected" },
      { scope: input().scope },
      { occurredAt: "2026-10-15T12:00:00Z" },
      { publication: {} },
      { schemaVersion: "0.1" },
      { kind: "reactivated" },
      { successor: authority },
    ])
      expect(
        PublishReleaseReviewerAuthorityLifecycleRequestSchema.safeParse({ ...revoked, ...patch })
          .success,
      ).toBe(false);
    const superseded = {
      ...revoked,
      kind: "superseded",
      successor: { ...authority, authorityVersionId: "next_version" },
    };
    expect(
      PublishReleaseReviewerAuthorityLifecycleRequestSchema.safeParse(superseded).success,
    ).toBe(true);
    for (const patch of [
      { authorityId: "other_authority" },
      { authorityVersionId: authority.authorityVersionId },
      { installationId: "other_installation" },
      { gateTargetId: "other_gate" },
      { reviewerPrincipalId: "other_reviewer" },
    ])
      expect(
        PublishReleaseReviewerAuthorityLifecycleRequestSchema.safeParse({
          ...superseded,
          successor: { ...superseded.successor, ...patch },
        }).success,
      ).toBe(false);
  });
});
