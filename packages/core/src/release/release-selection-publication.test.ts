import { describe, expect, it } from "vitest";
import type { ReleaseSelectionPublicationMaterial } from "@proofstack/contracts";
import {
  releaseSelectionPublicationFixture,
  selectionPublicationFixtureBudget,
} from "../testing/release-selection-publication-fixtures.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";
import {
  digestReleaseSelectionPublicationDefinition,
  digestReleaseSelectionPublicationRecord,
  validateReleaseSelectionPublicationMaterial,
} from "./release-selection-publication.js";

function rehash(value: ReleaseSelectionPublicationMaterial) {
  const { schemaVersion: _version, definitionSha256: _sha, ...definition } = value.publication;
  value.publication.definitionSha256 = digestReleaseSelectionPublicationDefinition(
    value.publication.scope,
    definition,
  );
}
function rehashPreimages(value: ReleaseSelectionPublicationMaterial) {
  value.publication.subject.recordSha256 = digestReleaseSelectionPublicationRecord(
    value.source.record,
  );
  value.publication.grantSha256 = digestReleaseSelectionPublicationRecord(value.grant);
  value.publication.credentialSha256 = digestReleaseSelectionPublicationRecord(value.credential);
  rehash(value);
}
describe("original authenticated selection publication integrity", () => {
  it.each(["selection", "lifecycle"] as const)(
    "retains complete original %s preimages without authenticating a caller",
    (kind) => {
      const value = releaseSelectionPublicationFixture(kind);
      const original = structuredClone(value);
      const budget = selectionPublicationFixtureBudget();
      expect(validateReleaseSelectionPublicationMaterial(value, budget)).toEqual(value);
      expect(budget.snapshot().records).toBe(6);
      expect(value).toEqual(original);
      value.publication.issuedAt = "2026-10-15T12:11:00.000001Z";
      expect(original.publication.issuedAt).toBe("2026-10-15T12:10:00.000001Z");
    },
  );
  it.each(["profile", "source", "grant", "credential"] as const)(
    "rejects a changed retained %s preimage and taints the original meter",
    (kind) => {
      const value = releaseSelectionPublicationFixture();
      if (kind === "profile") value.publication.definitionSha256 = "f".repeat(64);
      if (kind === "source" && value.source.kind === "release_policy_selection")
        value.source.record.publishedAt = "2026-10-15T12:09:59.999999Z";
      if (kind === "grant") value.grant.revision++;
      if (kind === "credential") value.credential.lastUsedAt = "2026-10-15T12:00:11.000001Z";
      const budget = selectionPublicationFixtureBudget();
      expect(() => validateReleaseSelectionPublicationMaterial(value, budget)).toThrow();
      expect(() => budget.snapshot()).toThrow();
      expect(() =>
        validateReleaseSelectionPublicationMaterial(releaseSelectionPublicationFixture(), budget),
      ).toThrow();
    },
  );
  it.each(["capability", "scope", "inactive", "revoked", "expired"] as const)(
    "rejects rehashed original %s ineligibility",
    (reason) => {
      const value = releaseSelectionPublicationFixture();
      if (reason === "capability") value.grant.capabilities = [];
      if (reason === "scope")
        value.grant.resourceScope = {
          mode: "restricted",
          projects: [{ projectId: "project_foreign", environmentIds: ["env_foreign"] }],
        };
      if (reason === "inactive") value.grant.state = "inactive";
      if (reason === "revoked") {
        value.credential.revokedAt = "2026-10-15T12:09:00.000001Z";
        value.credential.revocationReason = "administrative";
      }
      if (reason === "expired") {
        const at = "2026-10-15T13:00:00.000001Z";
        value.publication.issuedAt = at;
        if (value.source.kind === "release_policy_selection") value.source.record.publishedAt = at;
      }
      rehashPreimages(value);
      expect(() =>
        validateReleaseSelectionPublicationMaterial(value, selectionPublicationFixtureBudget()),
      ).toThrow();
    },
  );
  it.each(["clock", "actor", "reference"] as const)(
    "rejects a rehashed %s binding substitution",
    (reason) => {
      const value = releaseSelectionPublicationFixture();
      if (reason === "clock") value.publication.issuedAt = "2026-10-15T12:10:00.000002Z";
      if (reason === "actor") {
        value.publication.actor.principalId = "user_other";
        value.publication.identity.principalId = "user_other";
        value.grant.identity.principalId = "user_other";
        value.credential.principalId = "user_other";
      }
      if (reason === "reference") value.publication.subject.selection.gateTargetId = "gate_other";
      rehashPreimages(value);
      expect(() =>
        validateReleaseSelectionPublicationMaterial(value, selectionPublicationFixtureBudget()),
      ).toThrow();
    },
  );
  it("admits exact original record/byte limits and rejects one below without resetting the cut", () => {
    const value = releaseSelectionPublicationFixture();
    const meter = selectionPublicationFixtureBudget();
    validateReleaseSelectionPublicationMaterial(value, meter);
    const usage = meter.snapshot();
    const limited = (records: number, bytes: number) =>
      new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: records,
        maxAcquisitionRecordBytes: bytes,
        maxApprovalRecords: 0,
      });
    expect(
      validateReleaseSelectionPublicationMaterial(value, limited(usage.records, usage.recordBytes)),
    ).toEqual(value);
    for (const budget of [
      limited(usage.records - 1, usage.recordBytes),
      limited(usage.records, usage.recordBytes - 1),
    ]) {
      expect(() => validateReleaseSelectionPublicationMaterial(value, budget)).toThrow();
      expect(() => budget.snapshot()).toThrow();
    }
  });
});
