import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePolicyEvaluationSnapshotRecordInputs } from "./policy-evaluation-snapshot-records-encoding.js";
import type { PolicyEvaluationSnapshotRecordInputs } from "./policy-evaluation-snapshot-records.js";

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-snapshot-records-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: readonly {
    input: PolicyEvaluationSnapshotRecordInputs;
    encodedByteLength: number;
    sha256: string;
  }[];
};
const vector = document.vectors[0];
if (!vector) throw new Error("Missing independently generated snapshot-record vector");
const requiredVector = vector;
function input() {
  return structuredClone(requiredVector.input);
}
function hash(value: PolicyEvaluationSnapshotRecordInputs) {
  return createHash("sha256")
    .update(encodePolicyEvaluationSnapshotRecordInputs(value))
    .digest("hex");
}

describe("canonical snapshot record metadata", () => {
  it("matches the independent Python JSON/UTF-8/hashlib vector", () => {
    const value = input();
    const bytes = encodePolicyEvaluationSnapshotRecordInputs(value);
    expect(bytes.byteLength).toBe(requiredVector.encodedByteLength);
    expect(hash(value)).toBe(requiredVector.sha256);
    expect(value).toEqual(requiredVector.input);
  });

  it("preserves canonical bytes when object insertion order changes", () => {
    const value = input();
    const reversed = Object.fromEntries(
      Object.entries(value).reverse(),
    ) as PolicyEvaluationSnapshotRecordInputs;
    expect(hash(reversed)).toBe(requiredVector.sha256);
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)("binds exact %s scope", (field) => {
    const value = input();
    value.scope[field] = "scope_changed";
    expect(hash(value)).not.toBe(requiredVector.sha256);
  });

  it.each(["evaluationRequestId", "definitionSha256"] as const)(
    "binds exact request %s",
    (field) => {
      const value = input();
      value.request[field] = field === "definitionSha256" ? "b".repeat(64) : "request_changed";
      expect(hash(value)).not.toBe(requiredVector.sha256);
    },
  );

  it.each(["cut", "receipt", "body", "reference", "occurrence"] as const)(
    "binds every retained %s coordinate",
    (field) => {
      const value = input();
      const record = value.records[0]!;
      if (field === "cut")
        value.evaluationTime = "2026-10-03T00:00:00.000000000000000000000000000002Z";
      else if (field === "receipt")
        record.storage!.receiptTime = "2026-10-03T00:00:00.000000000000000000000000000000Z";
      else if (field === "body") {
        record.storage!.recordSha256 = "b".repeat(64);
        record.entry.observation = { status: "verified", recordSha256: "b".repeat(64) };
      } else if (field === "reference")
        Reflect.set(record.entry.source.reference, "definitionSha256", "b".repeat(64));
      else record.origins.push({ kind: "semantic_edge", edgeIndex: 0 });
      expect(hash(value)).not.toBe(requiredVector.sha256);
    },
  );

  it("binds explicit original use order without silently sorting occurrences", () => {
    const value = input();
    value.records[0]!.origins.push({ kind: "semantic_edge", edgeIndex: 0 });
    const original = hash(value);
    value.records[0]!.origins.reverse();
    expect(hash(value)).not.toBe(original);
  });

  it("rejects changed availability instead of hashing a future body as a verified input", () => {
    const value = input();
    value.records[0]!.storage!.receiptTime = "2099-01-01T00:00:00.000Z";
    expect(() => hash(value)).toThrow();
    value.records[0]!.entry.observation = { status: "unavailable", reason: "not_yet_available" };
    expect(hash(value)).not.toBe(requiredVector.sha256);
  });

  it.each(["workerId", "credential", "approval", "sealed"])(
    "rejects unexpected asserted %s",
    (field) => {
      const value = input();
      Reflect.set(value, field, "caller_assertion");
      expect(() => hash(value)).toThrow();
    },
  );
});
