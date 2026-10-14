import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encodePolicyEvaluationSnapshotInputs,
  encodePolicyEvaluationSnapshotDefinition,
  encodePolicyEvaluationSnapshotPageDefinition,
  type PolicyEvaluationSnapshotInputs,
} from "@proofstack/contracts";
import {
  assemblePolicyEvaluationSnapshot,
  validatePolicyEvaluationSnapshot,
} from "./policy-evaluation-snapshot.js";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/vectors/policy-evaluation-snapshot-inputs-v2.fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as PolicyEvaluationSnapshotInputs;
const oracle = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-snapshot-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  inputByteLength: number;
  inputSha256: string;
  rootByteLength: number;
  rootSha256: string;
  pages: { pageIndex: number; byteLength: number; sha256: string }[];
};
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
describe("version2 closure bytes with independent Python oracle", () => {
  it("binds all relationship metadata in canonical input, root and complete pages", () => {
    const bytes = encodePolicyEvaluationSnapshotInputs(fixture);
    expect(bytes.byteLength).toBe(oracle.inputByteLength);
    expect(sha(bytes)).toBe(oracle.inputSha256);
    const pageSet = assemblePolicyEvaluationSnapshot({
      snapshotId: "snapshot_closure_vector",
      inputs: fixture,
    });
    expect(pageSet.definitionSha256).toBe(oracle.rootSha256);
    expect(
      encodePolicyEvaluationSnapshotDefinition({
        definition: pageSet.definition,
        scope: pageSet.scope,
      }).byteLength,
    ).toBe(oracle.rootByteLength);
    pageSet.pages.forEach((page, index) => {
      const { schemaVersion: _version, definitionSha256: _hash, scope, ...definition } = page;
      const encoded = encodePolicyEvaluationSnapshotPageDefinition({ definition, scope });
      expect(encoded.byteLength).toBe(oracle.pages[index]!.byteLength);
      expect(sha(encoded)).toBe(oracle.pages[index]!.sha256);
    });
    expect(
      validatePolicyEvaluationSnapshot({
        expected: {
          scope: pageSet.scope,
          request: pageSet.definition.request,
          snapshot: {
            snapshotId: pageSet.definition.snapshotId,
            definitionSha256: pageSet.definitionSha256,
          },
        },
        pageSet,
      }),
    ).toEqual(fixture);
  });
  it("changing a retained mismatch or rule-use coordinate changes input/root identity", () => {
    const changed = structuredClone(fixture);
    if (changed.schemaVersion !== "0.2") throw new Error("Missing version2 fixture");
    changed.closure.checks[1]!.status = "matched";
    changed.closure.checks[1]!.reasons = [];
    const pages = assemblePolicyEvaluationSnapshot({
      snapshotId: "snapshot_closure_vector",
      inputs: changed,
    });
    expect(pages.definitionSha256).not.toBe(oracle.rootSha256);
    expect(pages.definition.inputSha256).not.toBe(oracle.inputSha256);
  });
});
