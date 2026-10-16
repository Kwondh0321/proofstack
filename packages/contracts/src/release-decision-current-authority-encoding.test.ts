import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReleaseDecisionCurrentAuthorityMaterialSchema } from "./release-decision-current-authority-material.js";
import { encodeReleaseDecisionCurrentAuthorityMaterial } from "./release-decision-current-authority-encoding.js";
import {
  ReleaseDecisionCurrentAuthoritySnapshotSchema,
  ReleaseDecisionCurrentAuthorityPageSchema,
} from "./release-decision-current-authority-encoding.js";
import {
  MAX_RELEASE_DECISION_AUTHORITY_FRAMES,
  MAX_RELEASE_DECISION_AUTHORITY_PAGES,
  MAX_RELEASE_DECISION_AUTHORITY_RESPONSE_BYTES,
  MAX_RELEASE_DECISION_AUTHORITY_PAGE_RESPONSE_BYTES,
  RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
  RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
} from "./release-decision-authority-snapshot.js";
import { MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES } from "./release-decision-authority-material.js";
import { encodeReleaseDecisionAuthorityMaterial } from "./release-decision-authority-encoding.js";
import { ReleaseDecisionAuthorityMaterialSchema } from "./release-decision-authority-material.js";

const read = (file: string) =>
  JSON.parse(readFileSync(new URL("../vectors/" + file, import.meta.url), "utf8"));
const current = read("release-decision-current-authority-snapshot-v2.json") as {
  vectors: {
    name: string;
    material: unknown;
    expected: { materialByteLength: number; materialSha256: string };
  }[];
};
const original = read("release-decision-authority-snapshot-v1.json") as typeof current;
describe("distinct complete-current-cut canonical domains and historical compatibility", () => {
  it("retains complete maximum 0.2 header/page geometry and original 512 KiB response headroom", () => {
    const id = "a".repeat(64),
      scope = { tenantId: id, projectId: id, environmentId: id };
    const snapshot = ReleaseDecisionCurrentAuthoritySnapshotSchema.parse({
      schemaVersion: "0.2",
      definitionSha256: id,
      authoritySnapshotId: id,
      decisionId: id,
      scope,
      input: { decisionInputRequestId: id, definitionSha256: id },
      capturedAt: `9999-12-31T23:59:59.${"9".repeat(30)}Z`,
      recoveryEpoch: Number.MAX_SAFE_INTEGER,
      materialSha256: id,
      materialByteLength: MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES,
      frameCount: MAX_RELEASE_DECISION_AUTHORITY_FRAMES,
      reviewAuthorityAssurances: ["operator_verified", "synthetic_reference"],
      hasUnavailableReviewerAuthority: true,
      pages: Array.from({ length: MAX_RELEASE_DECISION_AUTHORITY_PAGES }, (_, i) => ({
        pageIndex: i,
        definitionSha256: id,
        firstFrameIndex: i * RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
        frameCount: RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(
      MAX_RELEASE_DECISION_AUTHORITY_RESPONSE_BYTES,
    );
    const pageIndex = MAX_RELEASE_DECISION_AUTHORITY_PAGES - 1;
    const page = ReleaseDecisionCurrentAuthorityPageSchema.parse({
      schemaVersion: "0.2",
      definitionSha256: id,
      authoritySnapshotId: id,
      decisionId: id,
      scope,
      input: snapshot.input,
      materialSha256: id,
      materialByteLength: snapshot.materialByteLength,
      frameCount: snapshot.frameCount,
      pageIndex,
      frames: Array.from({ length: RELEASE_DECISION_AUTHORITY_PAGE_SIZE }, (_, i) => ({
        frameIndex: pageIndex * RELEASE_DECISION_AUTHORITY_PAGE_SIZE + i,
        dataBase64url: "A".repeat(Math.ceil((RELEASE_DECISION_AUTHORITY_FRAME_BYTES * 4) / 3)),
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
      MAX_RELEASE_DECISION_AUTHORITY_PAGE_RESPONSE_BYTES,
    );
    expect(
      ReleaseDecisionCurrentAuthoritySnapshotSchema.safeParse({
        ...snapshot,
        materialByteLength: snapshot.materialByteLength + 1,
      }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionCurrentAuthorityPageSchema.safeParse({ ...page, frames: page.frames.slice(1) })
        .success,
    ).toBe(false);
  });
  for (const vector of current.vectors)
    it(vector.name, () => {
      const material = ReleaseDecisionCurrentAuthorityMaterialSchema.parse(vector.material);
      const bytes = encodeReleaseDecisionCurrentAuthorityMaterial({
        scope: material.base.scope,
        material,
      });
      expect(bytes.byteLength).toBe(vector.expected.materialByteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.expected.materialSha256);
      expect(JSON.parse(new TextDecoder().decode(bytes)).schemaVersion).toBe("0.2");
    });
  for (const vector of original.vectors)
    it("preserves original 0.1 bytes: " + vector.name, () => {
      const material = ReleaseDecisionAuthorityMaterialSchema.parse(vector.material);
      const bytes = encodeReleaseDecisionAuthorityMaterial({ scope: material.scope, material });
      expect(bytes.byteLength).toBe(vector.expected.materialByteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.expected.materialSha256);
    });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects a different canonical %s scope",
    (field) => {
      const material = ReleaseDecisionCurrentAuthorityMaterialSchema.parse(
        current.vectors[0]?.material,
      );
      expect(() =>
        encodeReleaseDecisionCurrentAuthorityMaterial({
          scope: { ...material.base.scope, [field]: "scope_other" },
          material,
        }),
      ).toThrow("scope");
    },
  );
  it("does not parse a legacy-only material as complete current data", () => {
    expect(
      ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(original.vectors[0]?.material)
        .success,
    ).toBe(false);
  });
});
