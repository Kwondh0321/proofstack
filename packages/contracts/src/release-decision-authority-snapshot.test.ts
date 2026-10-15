import { describe, expect, it } from "vitest";
import {
  MAX_RELEASE_DECISION_AUTHORITY_FRAMES,
  MAX_RELEASE_DECISION_AUTHORITY_PAGES,
  MAX_RELEASE_DECISION_AUTHORITY_RESPONSE_BYTES,
  MAX_RELEASE_DECISION_AUTHORITY_PAGE_RESPONSE_BYTES,
  RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
  RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
  ReleaseDecisionAuthorityPageDefinitionSchema,
  ReleaseDecisionAuthorityPageSchema,
  ReleaseDecisionAuthoritySnapshotDefinitionSchema,
  ReleaseDecisionAuthoritySnapshotSchema,
} from "./release-decision-authority-snapshot.js";

const scope = {
  tenantId: "tenant_reference",
  projectId: "project_reference",
  environmentId: "environment_reference",
};
const input = { decisionInputRequestId: "input_reference", definitionSha256: "a".repeat(64) };
function page() {
  return {
    authoritySnapshotId: "authority_reference",
    decisionId: "decision_reference",
    input,
    materialSha256: "b".repeat(64),
    materialByteLength: 1,
    frameCount: 1,
    pageIndex: 0,
    frames: [{ frameIndex: 0, dataBase64url: "AA" }],
  };
}
function header() {
  return {
    authoritySnapshotId: "authority_reference",
    decisionId: "decision_reference",
    input,
    scope,
    capturedAt: "2026-10-15T12:00:00.000001Z",
    recoveryEpoch: 0,
    materialSha256: "b".repeat(64),
    materialByteLength: 1,
    frameCount: 1,
    reviewAuthorityAssurances: [],
    hasUnavailableReviewerAuthority: false,
    pages: [{ pageIndex: 0, definitionSha256: "c".repeat(64), firstFrameIndex: 0, frameCount: 1 }],
  };
}

describe("fixed authority frame/page contracts", () => {
  it("admits canonical final one-byte/two-byte frames with exact original lengths", () => {
    expect(ReleaseDecisionAuthorityPageDefinitionSchema.parse(page())).toEqual(page());
    expect(
      ReleaseDecisionAuthorityPageDefinitionSchema.safeParse({
        ...page(),
        materialByteLength: 2,
        frames: [{ frameIndex: 0, dataBase64url: "AAA" }],
      }).success,
    ).toBe(true);
  });
  it.each(["A", "AB", "AA==", "AA+", "AA/", "á", ""])(
    "rejects noncanonical one-byte frame %s",
    (dataBase64url) => {
      expect(
        ReleaseDecisionAuthorityPageDefinitionSchema.safeParse({
          ...page(),
          frames: [{ frameIndex: 0, dataBase64url }],
        }).success,
      ).toBe(false);
    },
  );
  it("rejects nonzero two-byte padding bits and incomplete/shifted frame positions", () => {
    expect(
      ReleaseDecisionAuthorityPageDefinitionSchema.safeParse({
        ...page(),
        materialByteLength: 2,
        frames: [{ frameIndex: 0, dataBase64url: "AAB" }],
      }).success,
    ).toBe(false);
    for (const changed of [
      { frameCount: 2 },
      { pageIndex: 1 },
      { materialByteLength: 0 },
      { frames: [] },
      { frames: [{ frameIndex: 1, dataBase64url: "AA" }] },
      { frames: [{ frameIndex: 0, dataBase64url: "AAA" }] },
    ])
      expect(
        ReleaseDecisionAuthorityPageDefinitionSchema.safeParse({ ...page(), ...changed }).success,
      ).toBe(false);
  });
  it("requires a complete ordered header descriptor set and strict assurance metadata", () => {
    const value = header();
    expect(ReleaseDecisionAuthoritySnapshotDefinitionSchema.parse(value)).toEqual(value);
    for (const changed of [
      { pages: [] },
      { frameCount: 0 },
      { materialByteLength: 2049 },
      { pages: [{ ...value.pages[0], firstFrameIndex: 1 }] },
      { reviewAuthorityAssurances: ["synthetic_reference", "synthetic_reference"] },
      { reviewAuthorityAssurances: ["real_human_verified"] },
      { hasUnavailableReviewerAuthority: "false" },
      { privateProof: true },
    ])
      expect(
        ReleaseDecisionAuthoritySnapshotDefinitionSchema.safeParse({ ...value, ...changed })
          .success,
      ).toBe(false);
    expect(
      ReleaseDecisionAuthoritySnapshotSchema.safeParse({
        ...value,
        schemaVersion: "0.2",
        definitionSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
  });
  it("independently proves maximum header and final full-page UTF-8 response headroom", () => {
    const id = (prefix: string) => prefix.padEnd(64, "x");
    const maximum = {
      ...header(),
      authoritySnapshotId: id("authority"),
      decisionId: id("decision"),
      scope: { tenantId: id("tenant"), projectId: id("project"), environmentId: id("environment") },
      input: { decisionInputRequestId: id("input"), definitionSha256: "a".repeat(64) },
      materialByteLength: 67108864,
      frameCount: MAX_RELEASE_DECISION_AUTHORITY_FRAMES,
      pages: Array.from({ length: MAX_RELEASE_DECISION_AUTHORITY_PAGES }, (_, index) => ({
        pageIndex: index,
        definitionSha256: "c".repeat(64),
        firstFrameIndex: index * RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
        frameCount: RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
      })),
    };
    const parsed = ReleaseDecisionAuthoritySnapshotDefinitionSchema.parse(maximum);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          snapshot: { ...parsed, schemaVersion: "0.1", definitionSha256: "d".repeat(64) },
          requestId: String.fromCharCode(0).repeat(128),
        }),
      ),
    ).toBeLessThan(MAX_RELEASE_DECISION_AUTHORITY_RESPONSE_BYTES);
    const pageIndex = MAX_RELEASE_DECISION_AUTHORITY_PAGES - 1;
    const full = {
      ...page(),
      authoritySnapshotId: maximum.authoritySnapshotId,
      decisionId: maximum.decisionId,
      input: maximum.input,
      frameCount: maximum.frameCount,
      materialByteLength: maximum.materialByteLength,
      pageIndex,
      frames: Array.from({ length: RELEASE_DECISION_AUTHORITY_PAGE_SIZE }, (_, index) => ({
        frameIndex: pageIndex * RELEASE_DECISION_AUTHORITY_PAGE_SIZE + index,
        dataBase64url: Buffer.alloc(RELEASE_DECISION_AUTHORITY_FRAME_BYTES).toString("base64url"),
      })),
    };
    const record = ReleaseDecisionAuthorityPageSchema.parse({
      ...full,
      scope: maximum.scope,
      schemaVersion: "0.1",
      definitionSha256: "e".repeat(64),
    });
    expect(
      Buffer.byteLength(
        JSON.stringify({ page: record, requestId: String.fromCharCode(0).repeat(128) }),
      ),
    ).toBeLessThan(MAX_RELEASE_DECISION_AUTHORITY_PAGE_RESPONSE_BYTES);
    expect(
      ReleaseDecisionAuthoritySnapshotDefinitionSchema.safeParse({
        ...maximum,
        materialByteLength: maximum.materialByteLength + 1,
      }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionAuthoritySnapshotDefinitionSchema.safeParse({
        ...maximum,
        pages: [...maximum.pages, maximum.pages[255]],
      }).success,
    ).toBe(false);
  });
});
