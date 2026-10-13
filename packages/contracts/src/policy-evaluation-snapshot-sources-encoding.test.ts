import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePolicyEvaluationSnapshotSourceInputs } from "./policy-evaluation-snapshot-sources-encoding.js";
import type { PolicyEvaluationSnapshotSourceInputs } from "./policy-evaluation-snapshot-sources.js";

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-snapshot-sources-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    input: PolicyEvaluationSnapshotSourceInputs;
    encodedByteLength: number;
    sha256: string;
  }[];
};
const vector = document.vectors[0];
if (!vector) throw new Error("Missing independently generated snapshot-source vector");
const requiredVector = vector;
function input() {
  return structuredClone(requiredVector.input);
}
function hash(value: PolicyEvaluationSnapshotSourceInputs) {
  return createHash("sha256")
    .update(encodePolicyEvaluationSnapshotSourceInputs(value))
    .digest("hex");
}

describe("canonical snapshot relationship metadata", () => {
  it("matches independent Python UTF-8/JSON/hashlib bytes including Unicode paths", () => {
    const value = input();
    expect(encodePolicyEvaluationSnapshotSourceInputs(value).byteLength).toBe(
      requiredVector.encodedByteLength,
    );
    expect(hash(value)).toBe(requiredVector.sha256);
    expect(value).toEqual(requiredVector.input);
  });
  it("preserves canonical bytes across object insertion order", () => {
    const value = Object.fromEntries(
      Object.entries(input()).reverse(),
    ) as PolicyEvaluationSnapshotSourceInputs;
    expect(hash(value)).toBe(requiredVector.sha256);
  });
  it.each(["path", "resolution", "cut", "body", "root", "origin"] as const)(
    "binds retained %s without upgrading source availability",
    (field) => {
      const value = input();
      const parent = value.records.records[0]!;
      if (field === "path") value.semanticFrontier[0]!.reference.path = "/資料/다른이름";
      else if (field === "resolution") value.storedMappings[0]!.resolutionSha256 = "b".repeat(64);
      else if (field === "cut")
        value.records.evaluationTime = "2026-10-03T00:00:00.000000000000000000000000000002Z";
      else if (field === "body") {
        parent.storage!.recordSha256 = "b".repeat(64);
        parent.entry.observation = { status: "verified", recordSha256: "b".repeat(64) };
        value.semanticFrontier[0]!.parentRecordSha256 = "b".repeat(64);
        value.storedMappings[0]!.parentRecordSha256 = "b".repeat(64);
        value.logicalRoots.mappings[0]!.parentRecordSha256 = "b".repeat(64);
      } else if (field === "root") {
        value.logicalRoots.configuration = "unconfigured";
        value.logicalRoots.mappings[0]!.state = {
          status: "unresolved",
          reason: "root_port_unconfigured",
        };
        parent.origins = parent.origins.filter(({ kind }) => kind !== "logical_root");
      } else parent.origins.reverse();
      expect(hash(value)).not.toBe(requiredVector.sha256);
      expect(value.records.records[1]!.entry.observation.status).toBe("missing");
    },
  );
  it("rejects a changed coordinate without its original-use witness", () => {
    const value = input();
    value.storedMappings[0]!.edgeIndex = 1;
    expect(() => encodePolicyEvaluationSnapshotSourceInputs(value)).toThrow();
  });
});
