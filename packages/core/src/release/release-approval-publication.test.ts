import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encodeEvaluationCanonicalJson,
  encodeReleaseApprovalDefinition,
  ReleaseApprovalPublicationMaterialSchema,
  type ReleaseApprovalPublicationMaterial,
} from "@proofstack/contracts";
import {
  releaseApprovalPublicationFixture,
  approvalPublicationFixtureBudget,
} from "../testing/release-approval-publication-fixtures.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";
import {
  digestReleaseApprovalPublicationDefinition,
  digestReleaseApprovalPublicationRecord,
  prepareReleaseApprovalPublicationMaterial,
  validateReleaseApprovalPublicationMaterial,
} from "./release-approval-publication.js";

function rehash(v: ReleaseApprovalPublicationMaterial) {
  v.publication.subject.recordSha256 = digestReleaseApprovalPublicationRecord(v.source.record);
  v.publication.grantSha256 = digestReleaseApprovalPublicationRecord(v.grant);
  v.publication.credentialSha256 = digestReleaseApprovalPublicationRecord(v.credential);
  const { schemaVersion: _v, definitionSha256: _h, ...definition } = v.publication;
  v.publication.definitionSha256 = digestReleaseApprovalPublicationDefinition(
    v.publication.scope,
    definition,
  );
}
function rejected(v: unknown) {
  const budget = approvalPublicationFixtureBudget();
  expect(() => validateReleaseApprovalPublicationMaterial(v, budget)).toThrow();
  expect(() => budget.snapshot()).toThrow();
  expect(() =>
    validateReleaseApprovalPublicationMaterial(releaseApprovalPublicationFixture(), budget),
  ).toThrow();
}
describe("original approval publication provenance", () => {
  it.each(["approve", "oppose", "escalate", "abstain"] as const)(
    "retains the original %s action without upgrading it into a quorum",
    (action) => {
      const value = releaseApprovalPublicationFixture();
      if (value.source.kind !== "release_approval") throw new Error("Fixture kind");
      value.source.record.action = action;
      const { schemaVersion: _v, definitionSha256: _h, ...definition } = value.source.record;
      value.source.record.definitionSha256 = createHash("sha256")
        .update(encodeReleaseApprovalDefinition({ scope: value.publication.scope, definition }))
        .digest("hex");
      value.publication.subject.approval.definitionSha256 = value.source.record.definitionSha256;
      rehash(value);
      expect(
        validateReleaseApprovalPublicationMaterial(value, approvalPublicationFixtureBudget()),
      ).toEqual(value);
    },
  );
  it.each(["approval", "revocation"] as const)(
    "retains %s originals and independent Python bytes without granting current authority",
    (kind) => {
      const value = releaseApprovalPublicationFixture(kind),
        original = structuredClone(value);
      const budget = approvalPublicationFixtureBudget();
      const parsed = validateReleaseApprovalPublicationMaterial(value, budget);
      expect(parsed).toEqual(original);
      expect(budget.snapshot().approvalRecords).toBe(kind === "approval" ? 1 : 0);
      expect(budget.snapshot().records).toBe(kind === "approval" ? 7 : 6);
      const vectors = JSON.parse(
        readFileSync(
          new URL(
            "../../../contracts/vectors/release-approval-publication-v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ).vectors;
      const v = vectors[kind === "approval" ? 0 : 1];
      const { schemaVersion: _v, definitionSha256, ...definition } = value.publication;
      expect(definition).toEqual(v.input.definition);
      expect(definitionSha256).toBe(v.sha256);
      parsed.publication.actor.requestId = "mutated_copy";
      parsed.grant.capabilities = [];
      expect(value).toEqual(original);
    },
  );
  it.each(["source", "profile", "grant", "credential"] as const)(
    "rejects stale %s digest and permanently taints the meter",
    (part) => {
      const v = releaseApprovalPublicationFixture();
      if (part === "source" && v.source.kind === "release_approval")
        v.source.record.rationale = "Different declaration";
      if (part === "profile") v.publication.issuedAt = "2026-10-15T10:00:05.000002Z";
      if (part === "grant") v.grant.revision++;
      if (part === "credential") v.credential.useCount++;
      rejected(v);
    },
  );
  it.each([
    "inactive",
    "capability",
    "scope",
    "expired",
    "revoked",
    "binding",
    "tenant",
    "session",
    "future_grant",
  ] as const)("rejects a rehashed ineligible %s original", (reason) => {
    const v = releaseApprovalPublicationFixture();
    if (reason === "inactive") v.grant.state = "inactive";
    if (reason === "capability") v.grant.capabilities = ["approval:authority:manage"];
    if (reason === "scope")
      v.grant.resourceScope = { mode: "restricted", projects: [{ projectId: "project_other" }] };
    if (reason === "expired" && v.source.kind === "release_approval") {
      // Retain the owning session's exact native expiry and move this synthetic original cut to
      // that boundary, recomputing the original approval rather than forging session metadata.
      v.publication.issuedAt = v.credential.idleExpiresAt;
      v.source.record.recordedAt = v.publication.issuedAt;
      const { schemaVersion: _v, definitionSha256: _h, ...definition } = v.source.record;
      v.source.record.definitionSha256 = createHash("sha256")
        .update(encodeReleaseApprovalDefinition({ scope: v.publication.scope, definition }))
        .digest("hex");
      v.publication.subject.approval.definitionSha256 = v.source.record.definitionSha256;
    }
    if (reason === "revoked") {
      v.credential.revokedAt = v.publication.issuedAt;
      v.credential.revocationReason = "logout";
    }
    if (reason === "binding") v.credential.bindingId = "other_binding";
    if (reason === "tenant") v.credential.tenantId = "other_tenant";
    if (reason === "session") v.credential.credentialId = "other_session";
    if (reason === "future_grant") v.grant.updatedAt = "2026-10-15T10:00:05.000002Z";
    rehash(v);
    // Negative authority cases must reach semantic identity inspection, not fail malformed data.
    expect(ReleaseApprovalPublicationMaterialSchema.parse(v)).toEqual(v);
    if (reason === "scope" || reason === "expired")
      expect(() =>
        validateReleaseApprovalPublicationMaterial(v, approvalPublicationFixtureBudget()),
      ).toThrowError(
        expect.objectContaining({
          cause: expect.objectContaining({ reason: "identity_ineligible" }),
        }),
      );
    rejected(v);
  });
  it.each(["actor", "time", "approval_reference", "scope", "source_definition"] as const)(
    "rejects a fully rehashed approval %s substitution",
    (reason) => {
      const v = releaseApprovalPublicationFixture();
      if (v.source.kind !== "release_approval") throw new Error("Fixture kind");
      if (reason === "actor") v.publication.actor.requestId = "other_request";
      if (reason === "time") v.publication.issuedAt = "2026-10-15T10:00:05.000002Z";
      if (reason === "approval_reference")
        v.publication.subject.approval.approvalId = "other_approval";
      if (reason === "scope") v.source.record.subject.scope.environmentId = "other_environment";
      if (reason === "source_definition")
        v.source.record.rationale = "Substituted original declaration";
      rehash(v);
      rejected(v);
    },
  );
  it.each(["actor", "event", "reference", "time", "kind"] as const)(
    "rejects fully rehashed revocation %s substitution",
    (reason) => {
      const v = releaseApprovalPublicationFixture("revocation");
      if (v.source.kind !== "release_approval_revocation") throw new Error("Fixture kind");
      if (reason === "actor") v.source.record.reviewer.credentialId = "other_session";
      if (reason === "event") v.source.record.eventId = "other_event";
      if (reason === "reference") v.source.record.approval.definitionSha256 = "d".repeat(64);
      if (reason === "time") v.source.record.occurredAt = "2026-10-15T10:01:00.000003Z";
      if (reason === "kind")
        v.publication.subject = releaseApprovalPublicationFixture().publication.subject;
      rehash(v);
      rejected(v);
    },
  );
  it("rejects private session fields rather than retaining them as original metadata", () => {
    const v = releaseApprovalPublicationFixture();
    for (const key of ["sessionDigest", "csrfDigest", "cookie", "token"])
      rejected({ ...v, credential: { ...v.credential, [key]: "caller_private_field" } });
  });
  it("charges every duplicate original and enforces exact record, byte and approval admission", () => {
    const v = releaseApprovalPublicationFixture();
    const measured = approvalPublicationFixtureBudget();
    validateReleaseApprovalPublicationMaterial(v, measured);
    const used = measured.snapshot();
    expect(used.recordBytes).toBe(
      encodeEvaluationCanonicalJson(v).byteLength +
        encodeEvaluationCanonicalJson(v.source.record).byteLength +
        encodeEvaluationCanonicalJson({
          state: "observed",
          reference: v.publication.identity,
          record: v.grant,
        }).byteLength +
        encodeEvaluationCanonicalJson({
          state: "observed",
          reference: {
            kind: "oidc_session",
            principalId: v.publication.actor.principalId,
            credentialId: v.publication.actor.credentialId,
          },
          record: v.credential,
        }).byteLength,
    );
    for (const delta of [-1, 0, 1]) {
      const meter = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: used.records,
        maxAcquisitionRecordBytes: used.recordBytes + delta,
        maxApprovalRecords: 1,
      });
      if (delta < 0) {
        expect(() => validateReleaseApprovalPublicationMaterial(v, meter)).toThrow();
        expect(() => meter.snapshot()).toThrow();
      } else {
        validateReleaseApprovalPublicationMaterial(v, meter);
        expect(meter.snapshot()).toEqual(used);
        expect(() => validateReleaseApprovalPublicationMaterial(v, meter)).toThrow();
      }
    }
    const noApproval = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 100,
      maxAcquisitionRecordBytes: 1024 * 1024,
      maxApprovalRecords: 0,
    });
    expect(() => validateReleaseApprovalPublicationMaterial(v, noApproval)).toThrow();
    expect(() => noApproval.snapshot()).toThrow();
  });
  it("rejects a caught construction failure without permitting later validation", () => {
    const v = releaseApprovalPublicationFixture(),
      budget = approvalPublicationFixtureBudget();
    expect(() =>
      prepareReleaseApprovalPublicationMaterial({
        scope: v.publication.scope,
        source: v.source,
        actor: { ...v.publication.actor, principalId: "other_user" },
        identity: v.publication.identity,
        grant: v.grant,
        credential: v.credential,
        issuedAt: v.publication.issuedAt,
        budget,
      }),
    ).toThrow();
    expect(() => budget.snapshot()).toThrow();
  });
  it("requires an actual cumulative meter and never restores a failed cut", () => {
    const value = releaseApprovalPublicationFixture();
    const fake = {
      observe() {},
      snapshot() {
        return { records: 0, recordBytes: 0, approvalRecords: 0 };
      },
    } as unknown as ReleaseDecisionVerificationBudget;
    const input = (budget: ReleaseDecisionVerificationBudget) => ({
      scope: value.publication.scope,
      source: value.source,
      actor: value.publication.actor,
      identity: value.publication.identity,
      grant: value.grant,
      credential: value.credential,
      issuedAt: value.publication.issuedAt,
      budget,
    });
    expect(() => validateReleaseApprovalPublicationMaterial(value, fake)).toThrow();
    expect(() => prepareReleaseApprovalPublicationMaterial(input(fake))).toThrow();
    const budget = approvalPublicationFixtureBudget();
    expect(() => budget.rejectSourceRead(new Error("Owning port failed"))).toThrow();
    expect(() => prepareReleaseApprovalPublicationMaterial(input(budget))).toThrow();
    expect(() => validateReleaseApprovalPublicationMaterial(value, budget)).toThrow();
  });
});
