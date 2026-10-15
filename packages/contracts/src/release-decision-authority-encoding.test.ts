import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeReleaseDecisionAuthorityMaterial,
  encodeReleaseDecisionAuthorityPageDefinition,
  encodeReleaseDecisionAuthoritySnapshotDefinition,
  RELEASE_DECISION_AUTHORITY_MATERIAL_DOMAIN,
  RELEASE_DECISION_AUTHORITY_PAGE_DOMAIN,
  RELEASE_DECISION_AUTHORITY_SNAPSHOT_DOMAIN,
} from "./release-decision-authority-encoding.js";
import { ReleaseDecisionAuthorityMaterialSchema } from "./release-decision-authority-material.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/release-decision-authority-snapshot-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    material: unknown;
    expected: { materialByteLength: number; materialSha256: string };
  }[];
};
function fixture() {
  const material = ReleaseDecisionAuthorityMaterialSchema.parse(vectors.vectors[0]?.material);
  const scope = material.scope;
  const input = {
    decisionInputRequestId: material.input.decisionInputRequestId,
    definitionSha256: material.input.definitionSha256,
  };
  const common = {
    authoritySnapshotId: material.authoritySnapshotId,
    decisionId: material.decisionId,
    input,
    materialSha256: "a".repeat(64),
    materialByteLength: 1,
    frameCount: 1,
  };
  return {
    material: { scope, material },
    header: {
      scope,
      definition: {
        ...common,
        scope,
        capturedAt: material.capturedAt,
        recoveryEpoch: material.recoveryEpoch,
        reviewAuthorityAssurances: [],
        hasUnavailableReviewerAuthority: false,
        pages: [
          { pageIndex: 0, definitionSha256: "b".repeat(64), firstFrameIndex: 0, frameCount: 1 },
        ],
      },
    },
    page: {
      scope,
      definition: {
        ...common,
        pageIndex: 0,
        frames: [{ frameIndex: 0, dataBase64url: "AA" }],
      },
    },
  };
}
describe("domain-separated canonical authority encodings", () => {
  it.each(vectors.vectors)("matches independent Python material bytes for $name", (vector) => {
    const material = ReleaseDecisionAuthorityMaterialSchema.parse(vector.material);
    const bytes = encodeReleaseDecisionAuthorityMaterial({ scope: material.scope, material });
    expect(bytes.byteLength).toBe(vector.expected.materialByteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.expected.materialSha256);
  });

  it("retains distinct explicit domains and never mutates caller preimages", () => {
    const value = fixture();
    const before = structuredClone(value);
    const encodings = [
      [
        encodeReleaseDecisionAuthorityMaterial(value.material),
        RELEASE_DECISION_AUTHORITY_MATERIAL_DOMAIN,
      ],
      [
        encodeReleaseDecisionAuthoritySnapshotDefinition(value.header),
        RELEASE_DECISION_AUTHORITY_SNAPSHOT_DOMAIN,
      ],
      [
        encodeReleaseDecisionAuthorityPageDefinition(value.page),
        RELEASE_DECISION_AUTHORITY_PAGE_DOMAIN,
      ],
    ] as const;
    for (const [bytes, domain] of encodings) {
      const envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
      expect(envelope.definitionDomain).toBe(domain);
      expect(envelope.schemaVersion).toBe("0.1");
      expect(envelope.scope).toEqual(value.material.scope);
    }
    expect(value).toEqual(before);
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "binds material/header to exact %s and includes the page envelope scope in its digest",
    (field) => {
      const value = fixture();
      const scope = { ...value.material.scope, [field]: "scope_other" };
      expect(() => encodeReleaseDecisionAuthorityMaterial({ ...value.material, scope })).toThrow(
        TypeError,
      );
      expect(() =>
        encodeReleaseDecisionAuthoritySnapshotDefinition({ ...value.header, scope }),
      ).toThrow(TypeError);
      expect(encodeReleaseDecisionAuthorityPageDefinition({ ...value.page, scope })).not.toEqual(
        encodeReleaseDecisionAuthorityPageDefinition(value.page),
      );
    },
  );

  it("rejects extra envelope fields rather than silently canonicalizing them away", () => {
    const value = fixture();
    expect(() =>
      encodeReleaseDecisionAuthorityMaterial({
        ...value.material,
        secret: "redacted",
      } as typeof value.material),
    ).toThrow();
    expect(() =>
      encodeReleaseDecisionAuthoritySnapshotDefinition({
        ...value.header,
        extra: true,
      } as typeof value.header),
    ).toThrow();
    expect(() =>
      encodeReleaseDecisionAuthorityPageDefinition({
        ...value.page,
        extra: true,
      } as typeof value.page),
    ).toThrow();
  });
});
