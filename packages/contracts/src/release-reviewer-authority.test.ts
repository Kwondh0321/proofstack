import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES,
  MAX_RELEASE_REVIEWER_AUTHORITY_RESPONSE_BYTES,
  ReleaseReviewerAuthorityDefinitionSchema,
  ReleaseReviewerAuthorityLifecycleEventSchema,
  ReleaseReviewerAuthoritySchema,
} from "./release-reviewer-authority.js";

const vectors = JSON.parse(
  readFileSync(new URL("../vectors/release-approval-definition-v1.json", import.meta.url), "utf8"),
) as { vectors: { input: { definition: unknown } }[] };
function definition() {
  return ReleaseReviewerAuthorityDefinitionSchema.parse(
    structuredClone(vectors.vectors[0]?.input.definition),
  );
}
function reference() {
  const v = definition();
  return {
    authorityId: v.authorityId,
    authorityVersionId: v.authorityVersionId,
    reviewerPrincipalId: v.reviewerPrincipalId,
    installationId: v.installationId,
    gateTargetId: v.gateTargetId,
    definitionSha256: "a".repeat(64),
  };
}
function record() {
  const v = definition();
  return {
    ...v,
    schemaVersion: "0.1",
    definitionSha256: "a".repeat(64),
    publishedByPrincipalId: v.issuerPrincipalId,
    publishedAt: "2026-10-15T00:00:00.000002Z",
  };
}
function atBytes(bytes: number) {
  const v = definition();
  v.rationale = "😀".repeat(1024);
  v.affiliations = Array.from({ length: 32 }, (_, i) => `aff_${i.toString().padStart(3, "0")}_`);
  let left = bytes - Buffer.byteLength(JSON.stringify(v));
  for (let i = 0; i < v.affiliations.length; i += 1) {
    const prefix = v.affiliations[i] ?? "";
    const addition = Math.min(left, (512 - prefix.length - 3) * 4);
    if (addition < 0) throw new Error("Invalid authority byte fixture base");
    v.affiliations[i] = prefix + "😀".repeat(Math.floor(addition / 4)) + "x".repeat(addition % 4);
    left -= addition;
  }
  if (left !== 0) throw new Error("Insufficient authority byte fixture headroom");
  expect(Buffer.byteLength(JSON.stringify(v))).toBe(bytes);
  return v;
}

describe("installation reviewer authority declarations", () => {
  it("retains explicit synthetic provenance without certifying expertise", () => {
    expect(definition().assurance).toBe("synthetic_reference");
    expect(
      ReleaseReviewerAuthorityDefinitionSchema.parse({
        ...definition(),
        assurance: "operator_verified",
      }).assurance,
    ).toBe("operator_verified");
    expect(ReleaseReviewerAuthoritySchema.safeParse(record()).success).toBe(true);
  });
  it("rejects self-issued authority and missing declaration provenance", () => {
    const v = definition();
    for (const change of [
      { issuerPrincipalId: v.reviewerPrincipalId },
      { reviewBasis: [] },
      { affiliations: [] },
      { reviewerKind: "service" },
      { assurance: "automatically_verified" },
    ])
      expect(ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...v, ...change }).success).toBe(
        false,
      );
  });
  it("keeps verified, rejected and unresolved authority distinguishable", () => {
    const v = definition();
    for (const status of ["unverifiable", "rejected"]) {
      expect(ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...v, status }).success).toBe(
        false,
      );
      expect(
        ReleaseReviewerAuthorityDefinitionSchema.safeParse({
          ...v,
          status,
          statusReasons: ["The review could not establish eligibility."],
        }).success,
      ).toBe(true);
    }
    for (const change of [
      { conflicts: ["Declared conflict"] },
      { statusReasons: ["Unresolved review"] },
    ])
      expect(ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...v, ...change }).success).toBe(
        false,
      );
  });
  it.each(["roleIds", "independenceGroupIds"] as const)("bounds and deduplicates %s", (key) => {
    const v = definition();
    const ids = Array.from({ length: 32 }, (_, i) => `member_${i.toString().padStart(3, "0")}`);
    expect(ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...v, [key]: ids }).success).toBe(
      true,
    );
    for (const values of [
      [],
      [...ids, "member_zzz"],
      ["member_one", "member_one"],
      ["member_two", "member_one"],
    ])
      expect(
        ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...v, [key]: values }).success,
      ).toBe(false);
  });
  it("rejects repeated or unordered provenance and declaration lists", () => {
    const v = definition();
    const basis = v.reviewBasis[0];
    if (!basis) throw new Error("Missing authority basis");
    expect(
      ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...v, reviewBasis: [basis, basis] })
        .success,
    ).toBe(false);
    expect(
      ReleaseReviewerAuthorityDefinitionSchema.safeParse({
        ...v,
        relationships: ["Second", "First"],
      }).success,
    ).toBe(false);
  });
  it("preserves native validity precision and rejects malformed time without throwing", () => {
    const v = definition();
    expect(
      ReleaseReviewerAuthorityDefinitionSchema.safeParse({
        ...v,
        expiresAt: "2026-10-15T00:00:00.0000011Z",
      }).success,
    ).toBe(true);
    for (const expiresAt of [
      v.effectiveAt,
      "2026-10-15T00:00:00.0000009Z",
      "invalid",
      "2026-02-30T00:00:00Z",
    ])
      expect(ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...v, expiresAt }).success).toBe(
        false,
      );
  });
  it("keeps original reviewer and target across predecessor references", () => {
    const v = definition();
    const predecessor = { ...reference(), authorityVersionId: "authority_previous" };
    expect(ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...v, predecessor }).success).toBe(
      true,
    );
    for (const change of [
      { authorityId: "authority_other" },
      { authorityVersionId: v.authorityVersionId },
      { reviewerPrincipalId: "reviewer_other" },
      { installationId: "installation_other" },
      { gateTargetId: "gate_other" },
    ])
      expect(
        ReleaseReviewerAuthorityDefinitionSchema.safeParse({
          ...v,
          predecessor: { ...predecessor, ...change },
        }).success,
      ).toBe(false);
  });
  it.each(["current", "capabilities", "sessionDigest", "definitionSha256", "publishedAt"])(
    "rejects authority or receipt smuggling: %s",
    (key) => {
      expect(
        ReleaseReviewerAuthorityDefinitionSchema.safeParse({ ...definition(), [key]: "untrusted" })
          .success,
      ).toBe(false);
    },
  );
  it("checks actual publisher receipt shape and original expiry", () => {
    const v = record();
    for (const change of [
      { publishedByPrincipalId: "publisher_other" },
      { publishedAt: v.expiresAt },
      { publishedAt: "invalid" },
      { schemaVersion: "99" },
    ])
      expect(ReleaseReviewerAuthoritySchema.safeParse({ ...v, ...change }).success).toBe(false);
  });
  it("admits independent UTF-8 byte boundaries and reserves actual response overhead", () => {
    for (const bytes of [
      MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES - 1,
      MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES,
    ]) {
      const v = atBytes(bytes);
      expect(ReleaseReviewerAuthorityDefinitionSchema.safeParse(v).success).toBe(true);
      const published = ReleaseReviewerAuthoritySchema.parse({ ...record(), ...v });
      expect(
        Buffer.byteLength(
          JSON.stringify({ authority: published, created: true, requestId: "\u0000".repeat(128) }),
        ),
      ).toBeLessThanOrEqual(MAX_RELEASE_REVIEWER_AUTHORITY_RESPONSE_BYTES);
    }
    const over = atBytes(MAX_RELEASE_REVIEWER_AUTHORITY_DEFINITION_BYTES + 1);
    expect(ReleaseReviewerAuthorityDefinitionSchema.safeParse(over).success).toBe(false);
    expect(ReleaseReviewerAuthoritySchema.safeParse({ ...record(), ...over }).success).toBe(false);
  });
  it("treats optional undefined predecessors as absent canonical fields", () => {
    expect(
      ReleaseReviewerAuthorityDefinitionSchema.safeParse({
        ...definition(),
        predecessor: undefined,
      }).success,
    ).toBe(true);
  });
});

describe("reviewer authority append-only lifecycle", () => {
  function event() {
    return {
      authority: reference(),
      eventId: "authority_event",
      scope: definition().scope,
      actorPrincipalId: "authority_administrator",
      occurredAt: "2026-10-15T12:00:00.123456Z",
      reason: "The original authority was revoked.",
      schemaVersion: "0.1",
      kind: "revoked",
    };
  }
  it("admits revocation and exact reviewer-target supersession", () => {
    expect(ReleaseReviewerAuthorityLifecycleEventSchema.safeParse(event()).success).toBe(true);
    expect(
      ReleaseReviewerAuthorityLifecycleEventSchema.safeParse({
        ...event(),
        kind: "superseded",
        successor: { ...reference(), authorityVersionId: "authority_v2" },
      }).success,
    ).toBe(true);
  });
  it.each([
    {},
    { authorityId: "authority_other" },
    { reviewerPrincipalId: "reviewer_other" },
    { installationId: "installation_other" },
    { gateTargetId: "gate_other" },
  ])("rejects foreign or self supersession: %j", (change) => {
    expect(
      ReleaseReviewerAuthorityLifecycleEventSchema.safeParse({
        ...event(),
        kind: "superseded",
        successor: { ...reference(), ...change },
      }).success,
    ).toBe(false);
  });
  it("rejects reactivation and in-place edits", () => {
    for (const changed of [
      { kind: "reactivated" },
      { kind: "superseded" },
      { current: true },
      { kind: "revoked", successor: reference() },
    ])
      expect(
        ReleaseReviewerAuthorityLifecycleEventSchema.safeParse({ ...event(), ...changed }).success,
      ).toBe(false);
  });
});
