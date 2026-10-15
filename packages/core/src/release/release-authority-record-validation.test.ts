import { readFileSync } from "node:fs";
import {
  ReleaseApprovalSchema,
  ReleasePolicySelectionSchema,
  ReleaseReviewerAuthoritySchema,
  type EvidenceScope,
  type ReleaseApprovalDefinition,
  type ReleasePolicySelectionDefinition,
  type ReleaseReviewerAuthorityDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestReleaseApprovalDefinition,
  digestReleasePolicySelectionDefinition,
  digestReleaseReviewerAuthorityDefinition,
  InvalidReleaseAuthorityRecordError,
  releaseApprovalReference,
  releasePolicySelectionReference,
  releaseReviewerAuthorityReference,
  validateReleaseApprovalRecord,
  validateReleasePolicySelectionRecord,
  validateReleaseReviewerAuthorityRecord,
  type ReleaseAuthorityRecordKind,
} from "./release-authority-record-validation.js";

interface Vector {
  name: string;
  input: { scope: EvidenceScope; definition: Record<string, unknown> };
  sha256: string;
}
function vectors(file: string): Vector[] {
  return JSON.parse(
    readFileSync(
      new URL(`../../../contracts/vectors/${file}-definition-v1.json`, import.meta.url),
      "utf8",
    ),
  ).vectors;
}
const selection = vectors("release-policy-selection")[0];
const approvals = vectors("release-approval");
const authority = approvals.find(({ input }) => "authorityVersionId" in input.definition);
const approval = approvals.find(({ input }) => "approvalId" in input.definition);
if (!selection || !authority || !approval) throw new Error("Missing independent authority vectors");

function fixture(kind: ReleaseAuthorityRecordKind) {
  const vector = structuredClone(
    kind === "selection" ? selection : kind === "reviewer_authority" ? authority : approval,
  );
  if (!vector) throw new Error("Missing vector");
  const scope = vector.input.scope;
  const definition = vector.input.definition;
  const record: Record<string, unknown> = {
    ...definition,
    schemaVersion: "0.1",
    definitionSha256: vector.sha256,
    ...(kind === "approval"
      ? {}
      : {
          publishedAt: definition["effectiveAt"],
          publishedByPrincipalId: definition["issuerPrincipalId"],
        }),
  };
  if (kind === "selection") {
    const parsed = ReleasePolicySelectionSchema.parse(record);
    const reference = releasePolicySelectionReference(parsed);
    return {
      record,
      scope,
      reference,
      sha256: vector.sha256,
      digest: () =>
        digestReleasePolicySelectionDefinition(
          scope,
          definition as unknown as ReleasePolicySelectionDefinition,
        ),
      check: (value: unknown, s: unknown = scope, r: unknown = reference) =>
        validateReleasePolicySelectionRecord({
          expected: { scope: s as EvidenceScope, reference: r as typeof reference },
          record: value,
        }),
    };
  }
  if (kind === "reviewer_authority") {
    const parsed = ReleaseReviewerAuthoritySchema.parse(record);
    const reference = releaseReviewerAuthorityReference(parsed);
    return {
      record,
      scope,
      reference,
      sha256: vector.sha256,
      digest: () =>
        digestReleaseReviewerAuthorityDefinition(
          scope,
          definition as unknown as ReleaseReviewerAuthorityDefinition,
        ),
      check: (value: unknown, s: unknown = scope, r: unknown = reference) =>
        validateReleaseReviewerAuthorityRecord({
          expected: { scope: s as EvidenceScope, reference: r as typeof reference },
          record: value,
        }),
    };
  }
  const parsed = ReleaseApprovalSchema.parse(record);
  const reference = releaseApprovalReference(parsed);
  return {
    record,
    scope,
    reference,
    sha256: vector.sha256,
    digest: () =>
      digestReleaseApprovalDefinition(scope, definition as unknown as ReleaseApprovalDefinition),
    check: (value: unknown, s: unknown = scope, r: unknown = reference) =>
      validateReleaseApprovalRecord({
        expected: { scope: s as EvidenceScope, reference: r as typeof reference },
        record: value,
      }),
  };
}

describe.each(["selection", "reviewer_authority", "approval"] as const)(
  "owning immutable %s integrity, not current authorization",
  (kind) => {
    it("verifies independent Python definition bytes and exact owning reference without mutation", () => {
      const value = fixture(kind);
      const before = structuredClone(value.record);
      expect(value.digest()).toBe(value.sha256);
      const result = value.check(value.record);
      expect(result).toEqual(value.record);
      expect(result).not.toBe(value.record);
      expect(value.record).toEqual(before);
    });

    it.each(["tenantId", "projectId", "environmentId"] as const)(
      "rejects another expected %s even for an internally valid original",
      (field) => {
        const value = fixture(kind);
        expect(() =>
          value.check(value.record, { ...value.scope, [field]: "scope_another" }),
        ).toThrow(InvalidReleaseAuthorityRecordError);
      },
    );

    it("requires every exact reference component, not only a logical ID or a valid body digest", () => {
      const value = fixture(kind);
      for (const field of Object.keys(value.reference)) {
        const changed = {
          ...value.reference,
          [field]: field === "definitionSha256" ? "0".repeat(64) : "reference_other",
        };
        expect(() => value.check(value.record, value.scope, changed)).toThrow(
          InvalidReleaseAuthorityRecordError,
        );
      }
    });

    it("rejects substituted definition preimages and unrecognized receipt fields", () => {
      const value = fixture(kind);
      expect(() => value.check({ ...value.record, rationale: "Substituted definition." })).toThrow(
        InvalidReleaseAuthorityRecordError,
      );
      expect(() => value.check({ ...value.record, privateProof: "not-a-credential" })).toThrow(
        InvalidReleaseAuthorityRecordError,
      );
    });

    it("rejects a replaced record digest even if its expected reference is replaced too", () => {
      const value = fixture(kind);
      const changed = { ...value.record, definitionSha256: "0".repeat(64) };
      expect(() =>
        value.check(changed, value.scope, { ...value.reference, definitionSha256: "0".repeat(64) }),
      ).toThrow(InvalidReleaseAuthorityRecordError);
    });

    it("wraps malformed originals and expected owners without echoing private input", () => {
      const value = fixture(kind);
      for (const malformed of [null, true, [], {}, { privateProof: "must-not-be-echoed" }]) {
        for (const run of [
          () => value.check(malformed),
          () => value.check(value.record, malformed),
          () => value.check(value.record, value.scope, malformed),
        ]) {
          try {
            run();
            throw new Error("Malformed original unexpectedly admitted");
          } catch (error) {
            expect(error).toBeInstanceOf(InvalidReleaseAuthorityRecordError);
            expect(error).toMatchObject({ kind, code: "release_authority_record_invalid" });
            expect((error as Error).message).not.toContain("must-not-be-echoed");
          }
        }
      }
    });
  },
);

describe("original release approval provenance", () => {
  it.each(["credentialId", "requestId", "authenticatedAt"])(
    "rejects replacement of the original %s without adopting a later login receipt",
    (field) => {
      const value = fixture("approval");
      const reviewer = value.record["reviewer"] as Record<string, unknown>;
      reviewer[field] =
        field === "authenticatedAt" ? "2026-10-15T00:00:00.000Z" : "receipt_another";
      expect(() => value.check(value.record)).toThrow(InvalidReleaseAuthorityRecordError);
    },
  );
});
