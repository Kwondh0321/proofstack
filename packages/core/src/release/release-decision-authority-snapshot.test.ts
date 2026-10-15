import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  encodeReleaseDecisionAuthoritySnapshotDefinition,
  encodeReleaseDecisionAuthorityPageDefinition,
  encodeReleaseDecisionAuthorityMaterial,
  encodeReleaseDecisionInputDefinition,
  MAX_RELEASE_DECISION_AUTHORITY_PAGE_RESPONSE_BYTES,
  RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
  RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
  ReleaseDecisionAuthorityMaterialSchema,
  type ReleaseDecisionAuthoritySnapshot,
  type ReleaseDecisionAuthorityPage,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  prepareReleaseDecisionAuthoritySnapshot,
  decodeReleaseDecisionAuthoritySnapshot,
  ReleaseDecisionAuthorityIntegrityError,
} from "./release-decision-authority-snapshot.js";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/vectors/release-decision-authority-snapshot-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    material: unknown;
    expected: {
      materialByteLength: number;
      materialSha256: string;
      frameCount: number;
      pageSha256: string[];
      headerSha256: string;
      reviewAuthorityAssurances: string[];
      hasUnavailableReviewerAuthority: boolean;
    };
  }[];
};
function material(index = 0) {
  return ReleaseDecisionAuthorityMaterialSchema.parse(
    structuredClone(vectors.vectors[index]?.material),
  );
}
function owner(snapshot: ReleaseDecisionAuthoritySnapshot) {
  return {
    scope: snapshot.scope,
    snapshot: {
      authoritySnapshotId: snapshot.authoritySnapshotId,
      definitionSha256: snapshot.definitionSha256,
    },
    decisionId: snapshot.decisionId,
    input: snapshot.input,
  };
}
function rehash(snapshot: ReleaseDecisionAuthoritySnapshot): void {
  const { schemaVersion: _version, definitionSha256: _sha, ...definition } = snapshot;
  snapshot.definitionSha256 = createHash("sha256")
    .update(encodeReleaseDecisionAuthoritySnapshotDefinition({ scope: snapshot.scope, definition }))
    .digest("hex");
}

/** Adversarial transport rewrite: recompute all outer hashes, without the owning material encoder. */
function replaceBytes(bytes: Uint8Array) {
  const prepared = prepareReleaseDecisionAuthoritySnapshot(material());
  const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
  const frames = Array.from(
    { length: Math.ceil(bytes.byteLength / RELEASE_DECISION_AUTHORITY_FRAME_BYTES) },
    (_, frameIndex) => ({
      frameIndex,
      dataBase64url: Buffer.from(
        bytes.subarray(
          frameIndex * RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
          (frameIndex + 1) * RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
        ),
      ).toString("base64url"),
    }),
  );
  const snapshot = prepared.snapshot;
  snapshot.materialByteLength = bytes.byteLength;
  snapshot.materialSha256 = digest(bytes);
  snapshot.frameCount = frames.length;
  const template = prepared.pages[0];
  if (!template) throw new Error("Missing page template");
  const pages: ReleaseDecisionAuthorityPage[] = [];
  for (let first = 0; first < frames.length; first += RELEASE_DECISION_AUTHORITY_PAGE_SIZE) {
    const page: ReleaseDecisionAuthorityPage = {
      ...template,
      materialByteLength: bytes.byteLength,
      materialSha256: snapshot.materialSha256,
      frameCount: frames.length,
      pageIndex: pages.length,
      frames: frames.slice(first, first + RELEASE_DECISION_AUTHORITY_PAGE_SIZE),
    };
    const { scope, schemaVersion: _version, definitionSha256: _sha, ...definition } = page;
    page.definitionSha256 = digest(
      encodeReleaseDecisionAuthorityPageDefinition({ scope, definition }),
    );
    pages.push(page);
  }
  snapshot.pages = pages.map((page) => ({
    pageIndex: page.pageIndex,
    definitionSha256: page.definitionSha256,
    firstFrameIndex: page.pageIndex * RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
    frameCount: page.frames.length,
  }));
  rehash(snapshot);
  return { snapshot, pages };
}

describe("historical authority snapshot transport, not current publication authority", () => {
  it.each(vectors.vectors.map((value, index) => ({ ...value, index })))(
    "matches independent Python material/frame/page/header $name",
    (vector) => {
      const input = material(vector.index);
      const prepared = prepareReleaseDecisionAuthoritySnapshot(input);
      expect(prepared.snapshot.materialByteLength).toBe(vector.expected.materialByteLength);
      expect(prepared.snapshot.materialSha256).toBe(vector.expected.materialSha256);
      expect(prepared.snapshot.frameCount).toBe(vector.expected.frameCount);
      expect(prepared.pages.map(({ definitionSha256 }) => definitionSha256)).toEqual(
        vector.expected.pageSha256,
      );
      expect(prepared.snapshot.definitionSha256).toBe(vector.expected.headerSha256);
      expect(prepared.snapshot.reviewAuthorityAssurances).toEqual(
        vector.expected.reviewAuthorityAssurances,
      );
      expect(prepared.snapshot.hasUnavailableReviewerAuthority).toBe(
        vector.expected.hasUnavailableReviewerAuthority,
      );
      expect(
        decodeReleaseDecisionAuthoritySnapshot({ expected: owner(prepared.snapshot), ...prepared }),
      ).toEqual(input);
    },
  );

  it("does not mutate caller data or return shared material/page byte state", () => {
    const input = material(3);
    const original = structuredClone(input);
    const prepared = prepareReleaseDecisionAuthoritySnapshot(input);
    expect(input).toEqual(original);
    const decoded = decodeReleaseDecisionAuthoritySnapshot({
      expected: owner(prepared.snapshot),
      ...prepared,
    });
    decoded.publisher.requestId = "another-request";
    expect(input.publisher.requestId).toBe(original.publisher.requestId);
    expect(
      decodeReleaseDecisionAuthoritySnapshot({ expected: owner(prepared.snapshot), ...prepared }),
    ).toEqual(original);
  });

  it("reconstructs real multiple pages, enforces each response ceiling and rejects page reordering", () => {
    const value = material();
    const identity = value.identities[0];
    if (identity?.state !== "observed") throw new Error("Missing identity fixture");
    const before = Buffer.byteLength(JSON.stringify(identity));
    identity.record.resourceScope = {
      mode: "restricted",
      projects: Array.from({ length: 50 }, (_, p) => ({
        projectId: `project_${p.toString().padStart(3, "0")}`.padEnd(64, "x"),
        environmentIds: Array.from({ length: 100 }, (_, e) =>
          `environment_${e.toString().padStart(3, "0")}`.padEnd(64, "x"),
        ),
      })),
    };
    value.usage.recordBytes += Buffer.byteLength(JSON.stringify(identity)) - before;
    const prepared = prepareReleaseDecisionAuthoritySnapshot(value);
    expect(prepared.pages.length).toBeGreaterThan(1);
    for (const page of prepared.pages)
      expect(
        Buffer.byteLength(JSON.stringify({ page, requestId: String.fromCharCode(0).repeat(128) })),
      ).toBeLessThan(MAX_RELEASE_DECISION_AUTHORITY_PAGE_RESPONSE_BYTES);
    expect(
      decodeReleaseDecisionAuthoritySnapshot({ expected: owner(prepared.snapshot), ...prepared }),
    ).toEqual(value);
    expect(() =>
      decodeReleaseDecisionAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        ...prepared,
        pages: [...prepared.pages].reverse(),
      }),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    expect(() =>
      decodeReleaseDecisionAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        ...prepared,
        pages: prepared.pages.slice(0, -1),
      }),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
  });

  it("reassembles UTF-8 scalar bytes across frame boundaries before strict decoding", () => {
    const value = material();
    const before = Buffer.byteLength(JSON.stringify(value.input));
    value.input.rationale = "😀".repeat(4095);
    const update = () => {
      const { schemaVersion: _version, definitionSha256: _sha, ...definition } = value.input;
      value.input.definitionSha256 = createHash("sha256")
        .update(encodeReleaseDecisionInputDefinition({ scope: value.scope, definition }))
        .digest("hex");
      value.usage.recordBytes =
        material().usage.recordBytes + Buffer.byteLength(JSON.stringify(value.input)) - before;
    };
    update();
    let bytes = Buffer.from(
      encodeReleaseDecisionAuthorityMaterial({ scope: value.scope, material: value }),
    );
    if (bytes.indexOf(Buffer.from("😀")) % 4 === 0) {
      value.input.rationale = `a${value.input.rationale}`;
      update();
      bytes = Buffer.from(
        encodeReleaseDecisionAuthorityMaterial({ scope: value.scope, material: value }),
      );
    }
    expect(bytes.indexOf(Buffer.from("😀")) % 4).not.toBe(0);
    const prepared = prepareReleaseDecisionAuthoritySnapshot(value);
    let splitScalar = false;
    for (const frame of prepared.pages.flatMap(({ frames }) => frames)) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(frame.dataBase64url, "base64url"),
        );
      } catch {
        splitScalar = true;
      }
    }
    expect(splitScalar).toBe(true);
    expect(
      decodeReleaseDecisionAuthoritySnapshot({ expected: owner(prepared.snapshot), ...prepared })
        .input.rationale,
    ).toBe(value.input.rationale);
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects a different expected %s",
    (field) => {
      const prepared = prepareReleaseDecisionAuthoritySnapshot(material());
      const expected = owner(prepared.snapshot);
      expect(() =>
        decodeReleaseDecisionAuthoritySnapshot({
          ...prepared,
          expected: { ...expected, scope: { ...expected.scope, [field]: "scope_other" } },
        }),
      ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    },
  );

  it("rejects another original input/decision/header instead of choosing a latest subject", () => {
    const prepared = prepareReleaseDecisionAuthoritySnapshot(material());
    const expected = owner(prepared.snapshot);
    for (const changed of [
      { ...expected, decisionId: "decision_other" },
      { ...expected, input: { ...expected.input, definitionSha256: "0".repeat(64) } },
      { ...expected, snapshot: { ...expected.snapshot, authoritySnapshotId: "snapshot_other" } },
    ])
      expect(() =>
        decodeReleaseDecisionAuthoritySnapshot({ ...prepared, expected: changed }),
      ).toThrow(ReleaseDecisionAuthorityIntegrityError);
  });

  it("rejects corrupt, missing, duplicated, reordered or cross-owner frames/pages", () => {
    const prepared = prepareReleaseDecisionAuthoritySnapshot(material());
    const expected = owner(prepared.snapshot);
    expect(() =>
      decodeReleaseDecisionAuthoritySnapshot({ ...prepared, expected, pages: [] }),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    expect(() =>
      decodeReleaseDecisionAuthoritySnapshot({
        ...prepared,
        expected,
        pages: [...prepared.pages, ...prepared.pages],
      }),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    for (const kind of ["bytes", "duplicate", "reorder", "scope", "decision", "digest"]) {
      const changed = structuredClone(prepared);
      const page = changed.pages[0];
      const frame = page?.frames[0];
      if (!page || !frame) throw new Error("Missing framed material fixture");
      if (kind === "bytes")
        frame.dataBase64url = `${frame.dataBase64url.startsWith("A") ? "B" : "A"}${frame.dataBase64url.slice(1)}`;
      if (kind === "duplicate") page.frames.push(structuredClone(frame));
      if (kind === "reorder") page.frames.reverse();
      if (kind === "scope") page.scope.tenantId = "tenant_other";
      if (kind === "decision") page.decisionId = "decision_other";
      if (kind === "digest") page.definitionSha256 = "0".repeat(64);
      expect(() => decodeReleaseDecisionAuthoritySnapshot({ ...changed, expected })).toThrow(
        ReleaseDecisionAuthorityIntegrityError,
      );
    }
  });

  it("cannot hide synthetic or unavailable authority by rehashing an outer summary", () => {
    for (const index of [1, 2]) {
      const prepared = prepareReleaseDecisionAuthoritySnapshot(material(index));
      prepared.snapshot.reviewAuthorityAssurances = [];
      prepared.snapshot.hasUnavailableReviewerAuthority = false;
      rehash(prepared.snapshot);
      expect(() =>
        decodeReleaseDecisionAuthoritySnapshot({ expected: owner(prepared.snapshot), ...prepared }),
      ).toThrow(/assurance summary/);
    }
  });

  it.each(["domain", "version", "scope", "extra", "noncanonical", "utf8", "cut", "epoch", "owner"])(
    "rejects rehashed malicious %s material without trusting outer integrity alone",
    (kind) => {
      const envelope = JSON.parse(
        Buffer.from(
          encodeReleaseDecisionAuthorityMaterial({
            scope: material().scope,
            material: material(),
          }),
        ).toString("utf8"),
      );
      if (kind === "domain") envelope.definitionDomain = "proofstack.policy-evaluation-snapshot.v1";
      if (kind === "version") envelope.schemaVersion = "0.2";
      if (kind === "scope") envelope.scope.tenantId = "tenant_another";
      if (kind === "extra") envelope.privateProof = "not-a-credential";
      if (kind === "cut") envelope.material.capturedAt = "2026-10-15T12:04:00.000001Z";
      if (kind === "epoch") envelope.material.recoveryEpoch += 1;
      if (kind === "owner") envelope.material.decisionId = "decision_another";
      const bytes =
        kind === "utf8"
          ? Buffer.from([0xc0, 0x80])
          : Buffer.from(JSON.stringify(envelope, null, kind === "noncanonical" ? 2 : undefined));
      const changed = replaceBytes(bytes);
      expect(() =>
        decodeReleaseDecisionAuthoritySnapshot({
          expected: owner(changed.snapshot),
          ...changed,
        }),
      ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    },
  );

  it("rejects tampering with the frozen original input even when material shape is admitted", () => {
    const value = material();
    value.input.rationale = "Altered original input.";
    expect(() => prepareReleaseDecisionAuthoritySnapshot(value)).toThrow(/original input digest/);
  });

  it("wraps malformed snapshots/material and rejects non-array page sets", () => {
    expect(() =>
      prepareReleaseDecisionAuthoritySnapshot(null as unknown as ReturnType<typeof material>),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    const prepared = prepareReleaseDecisionAuthoritySnapshot(material());
    expect(() =>
      decodeReleaseDecisionAuthoritySnapshot({
        ...prepared,
        expected: owner(prepared.snapshot),
        snapshot: null,
      }),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    expect(() =>
      decodeReleaseDecisionAuthoritySnapshot({
        ...prepared,
        expected: owner(prepared.snapshot),
        pages: null as unknown as [],
      }),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
  });
});
