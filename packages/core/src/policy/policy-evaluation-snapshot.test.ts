import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodePolicyEvaluationSnapshotDefinition,
  encodePolicyEvaluationSnapshotInputs,
  encodePolicyEvaluationSnapshotPageDefinition,
  MAX_POLICY_EVALUATION_SNAPSHOT_PAGE_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_SNAPSHOT_RESPONSE_BYTES,
  type PolicyEvaluationSnapshotInputs,
  type PolicyEvaluationSnapshotPageSet,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { assemblePolicyEvaluationManifest } from "./policy-evaluation-manifest.js";
import {
  assemblePolicyEvaluationSnapshot,
  validatePolicyEvaluationSnapshot,
} from "./policy-evaluation-snapshot.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/vectors/policy-evaluation-snapshot-inputs-v1.fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as PolicyEvaluationSnapshotInputs;
const oracle = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-snapshot-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    extraMissingProtocolSources: number;
    inputByteLength: number;
    inputSha256: string;
    rootEncodedByteLength: number;
    rootSha256: string;
    pages: { pageIndex: number; encodedByteLength: number; sha256: string }[];
  }[];
};
function input(extra = 0) {
  const value = structuredClone(fixture);
  for (let index = 0; index < extra; index++)
    value.sources.records.records.push({
      entry: {
        source: {
          kind: "protocol_definition",
          reference: {
            protocolDefinitionId: `protocol_snapshot_vector_${String(index).padStart(6, "0")}_${"p".repeat(32)}`,
            definitionSha256: "a".repeat(64),
          },
        },
        observation: { status: "missing" },
      },
      storage: null,
      origins: [{ kind: "stored_node", nodeIndex: 1000 + index }],
    });
  value.sources.records.records.sort((left, right) => {
    const a = policyEvaluationSourceReferenceKey(left.entry.source),
      b = policyEvaluationSourceReferenceKey(right.entry.source);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  value.manifest = assemblePolicyEvaluationManifest({
    manifestId: value.manifest.manifest.manifestId,
    request: value.sources.records.request,
    scope: value.request.scope,
    entries: value.sources.records.records.map(({ entry }) => entry),
  });
  return value;
}
function pageSet(extra = 0) {
  return assemblePolicyEvaluationSnapshot({
    snapshotId: "snapshot_independent_vector",
    inputs: input(extra),
  });
}
function expected(pages: PolicyEvaluationSnapshotPageSet) {
  return {
    snapshot: { snapshotId: pages.definition.snapshotId, definitionSha256: pages.definitionSha256 },
    request: pages.definition.request,
    scope: pages.scope,
  };
}
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function rehash(pages: PolicyEvaluationSnapshotPageSet) {
  for (const page of pages.pages) {
    const { scope, schemaVersion: _version, definitionSha256: _sha, ...definition } = page;
    page.definitionSha256 = sha(
      encodePolicyEvaluationSnapshotPageDefinition({ definition, scope }),
    );
    pages.definition.pages[page.pageIndex]!.definitionSha256 = page.definitionSha256;
  }
  pages.definitionSha256 = sha(
    encodePolicyEvaluationSnapshotDefinition({ definition: pages.definition, scope: pages.scope }),
  );
}

describe("complete canonical snapshot storage pages", () => {
  it.each(oracle.vectors)(
    "matches independent Python metadata vector with $extraMissingProtocolSources extra missing sources",
    (vector) => {
      const inputs = input(vector.extraMissingProtocolSources);
      const pages = pageSet(vector.extraMissingProtocolSources);
      expect(encodePolicyEvaluationSnapshotInputs(inputs).byteLength).toBe(vector.inputByteLength);
      expect(pages.definition.inputSha256).toBe(vector.inputSha256);
      expect(pages.definitionSha256).toBe(vector.rootSha256);
      expect(
        encodePolicyEvaluationSnapshotDefinition({
          definition: pages.definition,
          scope: pages.scope,
        }).byteLength,
      ).toBe(vector.rootEncodedByteLength);
      expect(
        pages.pages.map((page) => {
          const { scope, schemaVersion: _version, definitionSha256, ...definition } = page;
          return {
            pageIndex: page.pageIndex,
            sha256: definitionSha256,
            encodedByteLength: encodePolicyEvaluationSnapshotPageDefinition({ definition, scope })
              .byteLength,
          };
        }),
      ).toEqual(vector.pages);
      expect(
        validatePolicyEvaluationSnapshot({ expected: expected(pages), pageSet: pages }),
      ).toEqual(inputs);
    },
  );
  it("preserves response headroom across full 128-frame pages and exact scope/request binding", () => {
    const pages = pageSet(1200);
    expect(pages.pages).toHaveLength(4);
    expect(
      Buffer.byteLength(
        serializeEvaluationCanonicalJson({
          snapshot: pages.definition,
          requestId: "r".repeat(128),
        }),
        "utf8",
      ),
    ).toBeLessThan(MAX_POLICY_EVALUATION_SNAPSHOT_RESPONSE_BYTES);
    for (const page of pages.pages)
      expect(
        Buffer.byteLength(
          serializeEvaluationCanonicalJson({
            page,
            snapshot: expected(pages).snapshot,
            requestId: "r".repeat(128),
          }),
          "utf8",
        ),
      ).toBeLessThan(MAX_POLICY_EVALUATION_SNAPSHOT_PAGE_RESPONSE_BYTES);
  });
  it.each(["missing", "duplicate", "order", "frame", "padding", "scope", "descriptor"] as const)(
    "rejects changed complete page geometry: %s",
    (fault) => {
      const pages = pageSet(1200);
      if (fault === "missing") pages.pages.pop();
      else if (fault === "duplicate") pages.pages[1] = structuredClone(pages.pages[0]!);
      else if (fault === "order") pages.pages.reverse();
      else if (fault === "frame") pages.pages[0]!.frames[0]!.frameIndex = 1;
      else if (fault === "padding") pages.pages[0]!.frames[0]!.dataBase64url += "=";
      else if (fault === "scope") pages.pages[0]!.scope.tenantId = "tenant_other";
      else pages.definition.pages[0]!.firstFrameIndex = 1;
      expect(() =>
        validatePolicyEvaluationSnapshot({ expected: expected(pages), pageSet: pages }),
      ).toThrow("invalid_snapshot");
    },
  );
  it.each(["snapshot", "request", "scope"] as const)(
    "rejects expected %s substitution",
    (fault) => {
      const pages = pageSet();
      const root = structuredClone(expected(pages));
      if (fault === "snapshot") root.snapshot.definitionSha256 = "b".repeat(64);
      else if (fault === "request") root.request.evaluationRequestId = "request_other";
      else root.scope.projectId = "project_other";
      expect(() => validatePolicyEvaluationSnapshot({ expected: root, pageSet: pages })).toThrow(
        "reference_mismatch",
      );
    },
  );
  it.each(["root", "page", "rehash"] as const)(
    "rejects changed canonical bytes with %s hashes",
    (fault) => {
      const pages = pageSet();
      if (fault === "root") pages.definition.capturedAt = "2026-10-02T00:00:00.000Z";
      else {
        const frame = pages.pages[0]!.frames[0]!;
        const bytes = Buffer.from(frame.dataBase64url, "base64url");
        bytes[10] = bytes[10]! ^ 1;
        frame.dataBase64url = bytes.toString("base64url");
        if (fault === "rehash") rehash(pages);
      }
      expect(() =>
        validatePolicyEvaluationSnapshot({ expected: expected(pages), pageSet: pages }),
      ).toThrow("digest_mismatch");
    },
  );
  it("rejects a root body changed without its original definition digest", () => {
    const inputs = input();
    inputs.roots.candidate.name = "Substituted root body";
    expect(() =>
      assemblePolicyEvaluationSnapshot({ snapshotId: "snapshot_invalid_root", inputs }),
    ).toThrow("invalid_inputs");
  });
});
