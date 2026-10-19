import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeEvaluationCanonicalJson,
  MAX_RELEASE_REVIEWER_PUBLICATION_DEFINITION_BYTES,
  MAX_RELEASE_REVIEWER_PUBLICATION_GRANT_BYTES,
  MAX_RELEASE_REVIEWER_PUBLICATION_MATERIAL_BYTES,
  ReleaseReviewerPublicationMaterialSchema,
  type ReleaseReviewerPublicationMaterial,
} from "@proofstack/contracts";
import {
  authorityVersion,
  releaseReviewerAuthorityRepositoryFixture,
} from "../testing/release-reviewer-authority-repository-fixtures.js";
import {
  releaseReviewerPublicationFixture,
  reviewerPublicationFixtureBudget,
} from "../testing/release-reviewer-publication-fixtures.js";
import { releaseReviewerAuthorityReference } from "./release-authority-record-validation.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";
import {
  digestReleaseReviewerPublicationDefinition,
  digestReleaseReviewerPublicationRecord,
  InvalidReleaseReviewerPublicationError,
  prepareReleaseReviewerPublicationMaterial,
  validateReleaseReviewerPublicationMaterial,
} from "./release-reviewer-publication.js";

function rehash(value: ReleaseReviewerPublicationMaterial) {
  value.publication.subject.recordSha256 = digestReleaseReviewerPublicationRecord(
    value.source.record,
  );
  value.publication.grantSha256 = digestReleaseReviewerPublicationRecord(value.grant);
  value.publication.credentialSha256 = digestReleaseReviewerPublicationRecord(value.credential);
  const { schemaVersion: _version, definitionSha256: _sha, ...definition } = value.publication;
  value.publication.definitionSha256 = digestReleaseReviewerPublicationDefinition(
    value.publication.scope,
    definition,
  );
}
function input(value = releaseReviewerPublicationFixture()) {
  return {
    scope: value.publication.scope,
    source: value.source,
    actor: value.publication.actor,
    identity: value.publication.identity,
    grant: value.grant,
    credential: value.credential,
    issuedAt: value.publication.issuedAt,
    budget: reviewerPublicationFixtureBudget(),
  };
}
function rejected(value: unknown) {
  const budget = reviewerPublicationFixtureBudget();
  expect(() => validateReleaseReviewerPublicationMaterial(value, budget)).toThrow();
  expect(() => budget.snapshot()).toThrow();
  expect(() =>
    validateReleaseReviewerPublicationMaterial(releaseReviewerPublicationFixture(), budget),
  ).toThrow();
}

describe("original reviewer administration publication integrity", () => {
  it.each(["authority", "lifecycle"] as const)(
    "retains complete original %s without authenticating a caller",
    (kind) => {
      const value = releaseReviewerPublicationFixture(kind);
      const original = structuredClone(value);
      const budget = reviewerPublicationFixtureBudget();
      const result = validateReleaseReviewerPublicationMaterial(value, budget);
      expect(result).toEqual(value);
      expect(budget.snapshot().records).toBe(6);
      expect(budget.snapshot().approvalRecords).toBe(0);
      expect(value).toEqual(original);
      result.publication.actor.requestId = "mutated_copy";
      expect(value).toEqual(original);
      result.grant.capabilities = [];
      expect(value.grant.capabilities).toEqual(["approval:authority:manage"]);
    },
  );
  it("matches all independent Python canonical vectors using real owning source validators", () => {
    const vectors = JSON.parse(
      readFileSync(
        new URL("../../../contracts/vectors/release-reviewer-publication-v1.json", import.meta.url),
        "utf8",
      ),
    ).vectors as { name: string; input: { definition: unknown }; sha256: string }[];
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      const value = releaseReviewerPublicationFixture(
        vector.name === "original-revocation-native-cut" ? "lifecycle" : "authority",
        vector.name === "unicode-full-precision-cut"
          ? "2026-10-15T12:10:00.000001000000000000000000000001Z"
          : undefined,
      );
      const { schemaVersion: _version, definitionSha256, ...definition } = value.publication;
      expect(definition).toEqual(vector.input.definition);
      expect(definitionSha256).toBe(vector.sha256);
    }
  });
  it.each(["profile", "source", "grant", "credential"] as const)(
    "rejects changed retained %s and taints the original meter",
    (kind) => {
      const value = releaseReviewerPublicationFixture();
      if (kind === "profile") value.publication.definitionSha256 = "f".repeat(64);
      if (kind === "source" && value.source.kind === "release_reviewer_authority")
        value.source.record.publishedAt = "2026-10-15T12:09:59.999999Z";
      if (kind === "grant") value.grant.revision++;
      if (kind === "credential") value.credential.lastUsedAt = "2026-10-15T12:00:11.000001Z";
      rejected(value);
    },
  );
  it.each([
    "capability",
    "selection_capability",
    "admin_role_only",
    "scope",
    "inactive",
    "revoked",
    "expired",
    "future_grant",
    "future_touch",
    "other_binding",
    "other_session",
    "other_tenant",
  ] as const)("rejects consistently rehashed original %s ineligibility", (reason) => {
    const value = releaseReviewerPublicationFixture();
    if (reason === "capability") value.grant.capabilities = [];
    if (reason === "selection_capability") value.grant.capabilities = ["release:selection:manage"];
    if (reason === "admin_role_only") {
      value.grant.capabilities = [];
      value.grant.roles = ["admin"];
    }
    if (reason === "scope")
      value.grant.resourceScope = {
        mode: "restricted",
        projects: [{ projectId: "other_project", environmentIds: ["other_environment"] }],
      };
    if (reason === "inactive") value.grant.state = "inactive";
    if (reason === "revoked") {
      value.credential.revokedAt = "2026-10-15T12:09:00.000001Z";
      value.credential.revocationReason = "administrative";
    }
    if (reason === "expired") {
      const at = value.credential.idleExpiresAt;
      value.publication.issuedAt = at;
      if (value.source.kind === "release_reviewer_authority") value.source.record.publishedAt = at;
    }
    if (reason === "future_grant") value.grant.updatedAt = "2026-10-15T12:10:00.000002Z";
    if (reason === "future_touch") value.credential.lastUsedAt = "2026-10-15T12:10:00.000002Z";
    if (reason === "other_binding") value.credential.bindingId = "other_binding";
    if (reason === "other_session") value.credential.credentialId = "other_session";
    if (reason === "other_tenant") value.credential.tenantId = "other_tenant";
    rehash(value);
    rejected(value);
  });
  it.each(["clock", "actor", "reference", "scope", "grant_identity", "definition"] as const)(
    "rejects a rehashed original declaration %s substitution",
    (reason) => {
      const value = releaseReviewerPublicationFixture();
      if (reason === "clock") value.publication.issuedAt = "2026-10-15T12:10:00.000002Z";
      if (reason === "actor") {
        value.publication.actor.principalId = "other_actor";
        value.publication.identity.principalId = "other_actor";
        value.grant.identity.principalId = "other_actor";
        value.credential.principalId = "other_actor";
      }
      if (reason === "reference") value.publication.subject.authority.gateTargetId = "other_gate";
      if (reason === "scope") value.source.record.scope.projectId = "other_project";
      if (reason === "grant_identity" && value.grant.identity.kind === "oidc_binding")
        value.grant.identity.bindingId = "other_binding";
      if (reason === "definition" && value.source.kind === "release_reviewer_authority")
        value.source.record.rationale =
          "Substitute content while retaining the old owning definition hash.";
      rehash(value);
      rejected(value);
    },
  );
  it.each(["event", "clock", "actor", "authority", "kind"] as const)(
    "rejects a rehashed lifecycle %s substitution",
    (reason) => {
      const value = releaseReviewerPublicationFixture("lifecycle");
      if (value.source.kind !== "release_reviewer_authority_lifecycle")
        throw new Error("Fixture kind");
      if (reason === "event") value.source.record.eventId = "other_event";
      if (reason === "clock") value.source.record.occurredAt = "2026-10-15T12:11:00.000003Z";
      if (reason === "actor") value.source.record.actorPrincipalId = "other_actor";
      if (reason === "authority")
        value.source.record.authority.reviewerPrincipalId = "other_reviewer";
      if (reason === "kind") {
        const other = releaseReviewerPublicationFixture();
        value.publication.subject = other.publication.subject;
      }
      rehash(value);
      rejected(value);
    },
  );
  it("retains exact supersession preimages without asserting current source acquisition", () => {
    const value = releaseReviewerPublicationFixture("lifecycle");
    const base = releaseReviewerAuthorityRepositoryFixture("reviewer_publication");
    if (value.source.kind !== "release_reviewer_authority_lifecycle")
      throw new Error("Fixture kind");
    value.source.record = {
      ...value.source.record,
      kind: "superseded",
      successor: releaseReviewerAuthorityReference(base.successor),
    };
    rehash(value);
    expect(
      validateReleaseReviewerPublicationMaterial(value, reviewerPublicationFixtureBudget()),
    ).toEqual(value);
  });
  it.each(["unverifiable", "rejected"] as const)(
    "retains an authenticated %s declaration without upgrading its meaning",
    (status) => {
      const value = releaseReviewerPublicationFixture();
      if (value.source.kind !== "release_reviewer_authority") throw new Error("Fixture kind");
      value.source.record = authorityVersion(
        value.source.record,
        {
          status,
          statusReasons: ["Eligibility was not established."],
          conflicts: ["Declared conflict"],
        },
        value.publication.issuedAt,
      );
      value.publication.subject.authority = releaseReviewerAuthorityReference(value.source.record);
      rehash(value);
      expect(
        validateReleaseReviewerPublicationMaterial(value, reviewerPublicationFixtureBudget()).source
          .record,
      ).toEqual(value.source.record);
    },
  );
  it.each([
    "cookie",
    "csrf",
    "sessionDigest",
    "credentialHash",
    "basisContent",
    "current",
    "authenticated",
  ])("rejects injected private or authority field %s", (field) => {
    rejected({ ...releaseReviewerPublicationFixture(), [field]: "injected" });
  });
  it("requires a real usable aggregate meter and never resurrects a failed cut", () => {
    const value = releaseReviewerPublicationFixture();
    const fake = {
      observe() {},
      snapshot() {
        return { records: 0, recordBytes: 0, approvalRecords: 0 };
      },
    } as unknown as ReleaseDecisionVerificationBudget;
    expect(() => validateReleaseReviewerPublicationMaterial(value, fake)).toThrow(
      InvalidReleaseReviewerPublicationError,
    );
    expect(() =>
      prepareReleaseReviewerPublicationMaterial({ ...input(value), budget: fake }),
    ).toThrow(InvalidReleaseReviewerPublicationError);
    const budget = reviewerPublicationFixtureBudget();
    expect(() => budget.rejectSourceRead(new Error("Owning source failed"))).toThrow();
    expect(() => validateReleaseReviewerPublicationMaterial(value, budget)).toThrow();
    expect(() => prepareReleaseReviewerPublicationMaterial({ ...input(value), budget })).toThrow();
  });
  it("admits exact cumulative record/byte usage and rejects either limit one below", () => {
    const value = releaseReviewerPublicationFixture();
    const meter = reviewerPublicationFixtureBudget();
    validateReleaseReviewerPublicationMaterial(value, meter);
    const usage = meter.snapshot();
    const limited = (records: number, bytes: number) =>
      new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: records,
        maxAcquisitionRecordBytes: bytes,
        maxApprovalRecords: 0,
      });
    expect(
      validateReleaseReviewerPublicationMaterial(value, limited(usage.records, usage.recordBytes)),
    ).toEqual(value);
    for (const budget of [
      limited(usage.records - 1, usage.recordBytes),
      limited(usage.records, usage.recordBytes - 1),
    ]) {
      expect(() => validateReleaseReviewerPublicationMaterial(value, budget)).toThrow();
      expect(() => budget.snapshot()).toThrow();
    }
  });
  it("preparation shares its original meter and taints construction failures wholly", () => {
    const value = releaseReviewerPublicationFixture();
    const prepared = input(value);
    expect(prepareReleaseReviewerPublicationMaterial(prepared)).toEqual(value);
    expect(prepared.budget.snapshot().records).toBe(10);
    const broken = input(value);
    broken.actor = { ...broken.actor, principalId: "other_actor" };
    expect(() => prepareReleaseReviewerPublicationMaterial(broken)).toThrow();
    expect(() => broken.budget.snapshot()).toThrow();
  });
  it("rejects source kind mismatch in the retained material itself", () => {
    const value = releaseReviewerPublicationFixture();
    const other = releaseReviewerPublicationFixture("lifecycle");
    expect(
      ReleaseReviewerPublicationMaterialSchema.safeParse({ ...value, source: other.source })
        .success,
    ).toBe(false);
  });
  it("admits independent exact original grant byte limits while retaining material headroom", () => {
    function atGrantBytes(bytes: number) {
      const value = releaseReviewerPublicationFixture();
      const projects = Array.from({ length: 100 }, (_, project) => ({
        projectId: `p_${project.toString().padStart(3, "0")}`,
        environmentIds: Array.from(
          { length: 100 },
          (_, environment) => `e_${environment.toString().padStart(3, "0")}_`,
        ),
      }));
      value.grant.resourceScope = { mode: "restricted", projects };
      let remaining = bytes - encodeEvaluationCanonicalJson(value.grant).byteLength;
      for (const project of projects) {
        for (let index = 0; index < project.environmentIds.length; index++) {
          const prefix = project.environmentIds[index] ?? "";
          const count = Math.min(remaining, 64 - prefix.length);
          if (count < 0) throw new Error("Invalid grant boundary fixture");
          project.environmentIds[index] = prefix + "x".repeat(count);
          remaining -= count;
        }
      }
      expect(remaining).toBe(0);
      expect(encodeEvaluationCanonicalJson(value.grant).byteLength).toBe(bytes);
      return value;
    }
    for (const bytes of [
      MAX_RELEASE_REVIEWER_PUBLICATION_GRANT_BYTES - 1,
      MAX_RELEASE_REVIEWER_PUBLICATION_GRANT_BYTES,
    ]) {
      const value = atGrantBytes(bytes);
      expect(ReleaseReviewerPublicationMaterialSchema.safeParse(value).success).toBe(true);
      expect(encodeEvaluationCanonicalJson(value).byteLength + 64 * 1024).toBeLessThan(
        MAX_RELEASE_REVIEWER_PUBLICATION_MATERIAL_BYTES,
      );
      const { schemaVersion: _version, definitionSha256: _sha, ...definition } = value.publication;
      expect(encodeEvaluationCanonicalJson(definition).byteLength).toBeLessThan(
        MAX_RELEASE_REVIEWER_PUBLICATION_DEFINITION_BYTES,
      );
    }
    expect(
      ReleaseReviewerPublicationMaterialSchema.safeParse(
        atGrantBytes(MAX_RELEASE_REVIEWER_PUBLICATION_GRANT_BYTES + 1),
      ).success,
    ).toBe(false);
  });
});
